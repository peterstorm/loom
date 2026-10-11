/**
 * Imperative shell for advisory type diagnostics: find the touched file's
 * TypeScript project, run the project's own `tsc` incrementally under a
 * deadline, and judge the result with the pure core (core/type-diagnostics.ts).
 *
 * Both harness adapters reach `typeDiagnosticsAdvisory` through
 * handlers/type-diagnostics-edit.ts — the Claude Code PostToolUse hook and
 * Pi's post-edit flow — so they cannot drift.
 *
 * Cost model: `tsc --incremental --noEmit` keeps a build-info cache per
 * tsconfig under the cache directory. A cold run builds the whole program
 * (tens of seconds on a large repository); a warm run re-checks only what
 * changed. When a run misses the deadline it is NOT killed: it keeps running
 * detached, writes the cache, and later edits get the fast path.
 *
 * One run per tsconfig at a time, through the run slot
 * (handlers/type-diagnostics-run-slot.ts). A check holds the slot from
 * acquisition until it finishes. If it misses the deadline, the slot passes
 * to its detached compiler. Stored memory is read and written only while the
 * slot is held: a busy check returns before touching it.
 *
 * Everything here fails open: this is advisory context, never a gate.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DomainResult } from "../core/orchestration-contract/identity";
import {
  couldNotRun,
  isTypeScriptSource,
  judgeTypeCheck,
  NO_ADVISORY,
  outcomeOfTscExit,
  parseTypeCheckMemory,
  type FinishedTypeCheck,
  type TypeAdvisory,
  type TypeCheckMemory,
  type TypeCheckOutcome,
} from "../core/type-diagnostics";
import { TYPE_DIAGNOSTICS_DEADLINE_MS, typeDiagnosticsCacheDir } from "../config";
import { acquireRunSlot, handSlotTo, releaseRunSlot, type RunSlotPaths } from "./type-diagnostics-run-slot";

export type TypeCheckProject = Readonly<{ tsconfig: string; projectDir: string; tscPath: string }>;

/** One check of one project, as the shell hands it to the compiler port. */
export type TypeCheckRun = Readonly<{
  project: TypeCheckProject;
  buildInfo: string;
  /** This run's own output file. */
  output: string;
  deadlineMs: number;
}>;

/**
 * What the compiler port reports. A run either finished within the deadline
 * (completed or failed), or missed it and is still running DETACHED as `pid`.
 * The shell then hands that pid the run slot. One value carries both the
 * outcome and the hand-off, so the two cannot disagree.
 */
export type CompilerRun =
  | FinishedTypeCheck
  | Readonly<{ kind: "detached"; pid: number; afterMs: number }>;

/** The compiler port. Never throws: every failure is a `failed` result. */
export type RunTypeCheck = (run: TypeCheckRun) => Promise<CompilerRun>;

export type TypeDiagnosticsOptions = Readonly<{
  cacheDir?: string;
  deadlineMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** The compiler port; the project's real tsc by default. */
  runCheck?: RunTypeCheck;
  /** Epoch-ms clock; `Date.now` by default. */
  now?: () => number;
}>;

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

export type TypeCheckCachePaths = RunSlotPaths & Readonly<{
  buildInfo: string;
  memory: string;
  outputFor: (runId: string) => string;
}>;

/** Where one tsconfig's build info, run slot, memory and run outputs live. */
export function typeCheckCachePaths(cacheDir: string, tsconfig: string): TypeCheckCachePaths {
  const key = createHash("sha256").update(tsconfig).digest("hex").slice(0, 16);
  const at = (suffix: string) => join(cacheDir, `${key}.${suffix}`);
  return { cacheDir, buildInfo: at("tsbuildinfo"), slot: at("slot"), memory: at("memory.json"), outputFor: (runId) => at(`${runId}.out`) };
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

    type Ended = { kind: "exited"; code: number | null; signal: string | null } | { kind: "spawn-error"; message: string } | { kind: "deadline" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race<Ended>([
      new Promise((settle) => child.once("exit", (code, signal) => settle({ kind: "exited", code, signal }))),
      new Promise((settle) => child.once("error", (error) => settle({ kind: "spawn-error", message: error.message }))),
      new Promise((settle) => { timer = setTimeout(() => settle({ kind: "deadline" }), run.deadlineMs); }),
    ]);
    clearTimeout(timer);

    if (ended.kind === "deadline" && child.pid !== undefined) {
      // Let the build finish on its own: it writes the incremental cache.
      child.unref();
      return { kind: "detached", pid: child.pid, afterMs: run.deadlineMs };
    }
    if (ended.kind === "deadline") return { kind: "failed", reason: `tsc did not start within ${run.deadlineMs}ms` };
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

/** Store memory without letting a bookkeeping failure cost the model its advisory. */
function withStoredMemory(advisory: TypeAdvisory, path: string, memory: TypeCheckMemory): TypeAdvisory {
  try {
    storeMemory(path, memory);
    return advisory;
  } catch (error: unknown) {
    const note = `Loom type diagnostics could not save its memory: ${error instanceof Error ? error.message : String(error)}`;
    return { forModel: advisory.forModel, forOperator: advisory.forOperator === null ? note : `${advisory.forOperator}\n${note}` };
  }
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
    if (acquireRunSlot(paths, { pid: process.pid, startedAt, output }).kind === "busy") return NO_ADVISORY;

    let handedOff = false;
    try {
      const run = await runCheck({ project, buildInfo: paths.buildInfo, output, deadlineMs: options.deadlineMs ?? TYPE_DIAGNOSTICS_DEADLINE_MS });
      if (run.kind === "detached") {
        handSlotTo(paths, { pid: run.pid, startedAt, output });
        handedOff = true;
      }
      const outcome: TypeCheckOutcome = run.kind === "detached" ? { kind: "timed-out", afterMs: run.afterMs } : run;
      const judged = judgeTypeCheck({ touchedFile, projectDir: project.projectDir, outcome, memory: loadMemory(paths.memory), now: clock() });
      return judged.memoryUpdate.kind === "replace"
        ? withStoredMemory(judged.advisory, paths.memory, judged.memoryUpdate.memory)
        : judged.advisory;
    } finally {
      if (!handedOff) releaseRunSlot(paths, output);
    }
  } catch (error: unknown) {
    return couldNotRun(error);
  }
}
