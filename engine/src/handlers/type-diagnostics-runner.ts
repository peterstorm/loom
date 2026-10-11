/**
 * Imperative shell for advisory type diagnostics: find the touched file's
 * TypeScript project, run the project's own `tsc` incrementally under a
 * deadline, and judge the result with the pure core (core/type-diagnostics.ts).
 *
 * Both harness adapters reach `typeDiagnosticsAdvisory` through the core's
 * `adviceForEdit` — the Claude Code PostToolUse hook and Pi's tool_result
 * handler — so they cannot drift.
 *
 * Cost model: `tsc --incremental --noEmit` keeps a build-info cache per
 * tsconfig under the cache directory. A cold run builds the whole program
 * (tens of seconds on a large repository); a warm run re-checks only what
 * changed. When a run misses the deadline it is NOT killed: it keeps running
 * detached, writes the cache, and later edits get the fast path.
 *
 * One run per tsconfig at a time, through a RUN SLOT: a slot file created
 * atomically (link of a complete record, so no reader ever sees a half-written
 * one) names its owner `{pid, startedAt, output}`. A second check while the
 * owner lives is `busy`. The slot is reclaimed when its owner is dead, older
 * than STALE_RUN_MS (bounding a recycled pid), or unreadable. A run that
 * misses the deadline hands the slot to its detached tsc. Every run writes its
 * own output file, and stored memory is only read and written while the slot
 * is held, so even the residual race (two checks reclaiming the same stale
 * slot at once) cannot interleave outputs; memory is replaced by atomic rename.
 *
 * Everything here fails open: this is advisory context, never a gate.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DomainResult } from "../core/orchestration-contract/identity";
import {
  couldNotRun,
  isTypeScriptSource,
  judgeTypeCheck,
  NO_ADVISORY,
  outcomeOfTscExit,
  parseTypeCheckMemory,
  type TypeAdvisory,
  type TypeCheckMemory,
  type TypeCheckOutcome,
} from "../core/type-diagnostics";
import { TYPE_DIAGNOSTICS_DEADLINE_MS, typeDiagnosticsCacheDir } from "../config";

export type TypeCheckProject = Readonly<{ tsconfig: string; projectDir: string; tscPath: string }>;

/** One check of one project, as the shell hands it to the compiler port. */
export type TypeCheckRun = Readonly<{
  project: TypeCheckProject;
  buildInfo: string;
  /** This run's own output file. */
  output: string;
  deadlineMs: number;
  /** Called with the compiler's pid once it is spawned: the slot passes to it if the deadline is missed. */
  onSpawn: (pid: number) => void;
}>;

/**
 * The compiler port. Never throws: every failure is a `failed` outcome. A
 * `timed-out` outcome means the spawned compiler is still running and owns
 * the run slot.
 */
export type RunTypeCheck = (run: TypeCheckRun) => Promise<TypeCheckOutcome>;

export type TypeDiagnosticsOptions = Readonly<{
  cacheDir?: string;
  deadlineMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** The compiler port; the project's real tsc by default. */
  runCheck?: RunTypeCheck;
  /** Epoch-ms clock; `Date.now` by default. */
  now?: () => number;
}>;

/** A run slot older than this is reclaimed even if its pid is alive: the pid may have been recycled. */
export const STALE_RUN_MS = 10 * 60_000;

function* ancestors(start: string): Generator<string> {
  for (let dir = start; ; dir = dirname(dir)) {
    yield dir;
    if (dirname(dir) === dir) return;
  }
}

/** Nearest tsconfig.json above the file, and the TypeScript compiler that project installed. */
export function locateTypeCheckProject(file: string): DomainResult<TypeCheckProject, string> {
  let projectDir: string | undefined;
  for (const dir of ancestors(dirname(file))) {
    if (existsSync(join(dir, "tsconfig.json"))) { projectDir = dir; break; }
  }
  if (projectDir === undefined) return { ok: false, error: `no tsconfig.json above ${file}` };

  for (const dir of ancestors(projectDir)) {
    const tscPath = join(dir, "node_modules", "typescript", "lib", "tsc.js");
    if (existsSync(tscPath)) {
      return { ok: true, value: { tsconfig: join(projectDir, "tsconfig.json"), projectDir, tscPath } };
    }
  }
  return { ok: false, error: `no node_modules/typescript installed for ${projectDir}` };
}

export type TypeCheckCachePaths = Readonly<{
  cacheDir: string;
  buildInfo: string;
  slot: string;
  memory: string;
  outputFor: (runId: string) => string;
}>;

/** Where one tsconfig's build info, run slot, memory and run outputs live. */
export function typeCheckCachePaths(cacheDir: string, tsconfig: string): TypeCheckCachePaths {
  const key = createHash("sha256").update(tsconfig).digest("hex").slice(0, 16);
  const at = (suffix: string) => join(cacheDir, `${key}.${suffix}`);
  return { cacheDir, buildInfo: at("tsbuildinfo"), slot: at("slot"), memory: at("memory.json"), outputFor: (runId) => at(`${runId}.out`) };
}

// ── Run slot ───────────────────────────────────────────────────────────

type SlotRecord = Readonly<{ pid: number; startedAt: number; output: string }>;
type SlotAcquisition = Readonly<{ kind: "acquired" }> | Readonly<{ kind: "busy" }>;

const errnoCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseSlotRecord(raw: string): SlotRecord | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value)) return null;
  const { pid, startedAt, output } = value;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof startedAt === "number" && Number.isFinite(startedAt) && typeof output === "string"
    ? { pid, startedAt, output }
    : null;
}

/** The slot's current record; null when it is absent or unreadable. */
function readSlot(slot: string): SlotRecord | null {
  try {
    return parseSlotRecord(readFileSync(slot, "utf-8"));
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: the process exists but belongs to another user — still running.
    return errnoCode(error) === "EPERM";
  }
}

/** Write a complete record to a private file first, so the slot never holds a partial one. */
function stageRecord(paths: TypeCheckCachePaths, record: SlotRecord): string {
  const staged = `${paths.slot}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staged, JSON.stringify(record));
  return staged;
}

/** Remove a run's output, but only a run output this cache directory owns. */
function removeRunOutput(paths: TypeCheckCachePaths, output: string): void {
  const resolved = resolve(output);
  if (dirname(resolved) === resolve(paths.cacheDir) && resolved.endsWith(".out")) rmSync(resolved, { force: true });
}

function acquireRunSlot(paths: TypeCheckCachePaths, record: SlotRecord): SlotAcquisition {
  const staged = stageRecord(paths, record);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(staged, paths.slot); // atomic, and fails if the slot is taken
        return { kind: "acquired" };
      } catch (error: unknown) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }
      const held = readSlot(paths.slot);
      if (held !== null && isAlive(held.pid) && record.startedAt - held.startedAt <= STALE_RUN_MS) return { kind: "busy" };
      if (held !== null) removeRunOutput(paths, held.output);
      rmSync(paths.slot, { force: true });
    }
    return { kind: "busy" };
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Pass the held slot to the spawned compiler, so it stays held while that process lives. */
function handSlotTo(paths: TypeCheckCachePaths, record: SlotRecord): void {
  renameSync(stageRecord(paths, record), paths.slot);
}

/** Release the slot this run holds, unless another run has since reclaimed it. */
function releaseRunSlot(paths: TypeCheckCachePaths, output: string): void {
  if (readSlot(paths.slot)?.output === output) rmSync(paths.slot, { force: true });
  removeRunOutput(paths, output);
}

// ── The real compiler ──────────────────────────────────────────────────

/** The project's own tsc, run once under a deadline. Never throws. */
export const runTsc: RunTypeCheck = async (run) => {
  try {
    const outputFd = openSync(run.output, "w");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [run.project.tscPath, "--noEmit", "-p", run.project.tsconfig, "--incremental", "--tsBuildInfoFile", run.buildInfo, "--pretty", "false"],
        { cwd: run.project.projectDir, stdio: ["ignore", outputFd, outputFd], detached: true },
      );
    } finally {
      closeSync(outputFd);
    }
    if (child.pid !== undefined) run.onSpawn(child.pid);

    type Ended = { kind: "exited"; code: number | null; signal: string | null } | { kind: "spawn-error"; message: string } | { kind: "deadline" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race<Ended>([
      new Promise((settle) => child.once("exit", (code, signal) => settle({ kind: "exited", code, signal }))),
      new Promise((settle) => child.once("error", (error) => settle({ kind: "spawn-error", message: error.message }))),
      new Promise((settle) => { timer = setTimeout(() => settle({ kind: "deadline" }), run.deadlineMs); }),
    ]);
    clearTimeout(timer);

    if (ended.kind === "deadline") {
      // Let the build finish on its own: it writes the incremental cache.
      child.unref();
      return { kind: "timed-out", afterMs: run.deadlineMs };
    }
    if (ended.kind === "spawn-error") return { kind: "failed", reason: ended.message };
    return outcomeOfTscExit({ code: ended.code, signal: ended.signal }, readFileSync(run.output, "utf-8"), run.project.projectDir);
  } catch (error: unknown) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
};

// ── Memory ─────────────────────────────────────────────────────────────

function loadMemory(path: string): TypeCheckMemory | null {
  try {
    return parseTypeCheckMemory(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function storeMemory(path: string, memory: TypeCheckMemory): void {
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify(memory));
  renameSync(staged, path);
}

// ── One edit ───────────────────────────────────────────────────────────

/**
 * The advisory for one landed edit of an absolute file path. Returns no
 * advisory for files the check does not cover, projects it cannot check, a
 * project whose check is already running, or when switched off with
 * LOOM_TYPE_DIAGNOSTICS=off. Never throws: an unexpected failure becomes an
 * operator note.
 */
export async function typeDiagnosticsAdvisory(file: string, options: TypeDiagnosticsOptions = {}): Promise<TypeAdvisory> {
  const env = options.env ?? process.env;
  if (env.LOOM_TYPE_DIAGNOSTICS === "off" || !isTypeScriptSource(file)) return NO_ADVISORY;
  const clock = options.now ?? Date.now;
  const runCheck = options.runCheck ?? runTsc;

  try {
    if (!existsSync(file)) return NO_ADVISORY;
    const touchedFile = realpathSync(file);
    const located = locateTypeCheckProject(touchedFile);
    if (!located.ok) return NO_ADVISORY;
    const project = located.value;

    const cacheDir = options.cacheDir ?? typeDiagnosticsCacheDir(env);
    mkdirSync(cacheDir, { recursive: true });
    const paths = typeCheckCachePaths(cacheDir, project.tsconfig);

    const startedAt = clock();
    const output = paths.outputFor(randomUUID());
    const judge = (outcome: TypeCheckOutcome) =>
      judgeTypeCheck({ touchedFile, projectDir: project.projectDir, outcome, memory: loadMemory(paths.memory), now: clock() });

    if (acquireRunSlot(paths, { pid: process.pid, startedAt, output }).kind === "busy") return judge({ kind: "busy" }).advisory;

    let handedOff = false;
    try {
      const outcome = await runCheck({
        project,
        buildInfo: paths.buildInfo,
        output,
        deadlineMs: options.deadlineMs ?? TYPE_DIAGNOSTICS_DEADLINE_MS,
        onSpawn: (pid) => handSlotTo(paths, { pid, startedAt, output }),
      });
      handedOff = outcome.kind === "timed-out";
      const judged = judge(outcome);
      if (judged.memoryUpdate.kind === "replace") storeMemory(paths.memory, judged.memoryUpdate.memory);
      return judged.advisory;
    } finally {
      if (!handedOff) releaseRunSlot(paths, output);
    }
  } catch (error: unknown) {
    return couldNotRun(error);
  }
}
