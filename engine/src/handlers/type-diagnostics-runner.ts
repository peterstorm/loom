/**
 * Imperative shell for advisory type diagnostics: find the touched file's
 * TypeScript project, run the project's own `tsc` incrementally under a
 * deadline, and judge the result with the pure core (core/type-diagnostics.ts).
 *
 * Both harness adapters call `typeDiagnosticsAdvisory` — the Claude Code
 * PostToolUse hook and Pi's tool_result handler — so they cannot drift.
 *
 * Cost model: `tsc --incremental --noEmit` keeps a build-info cache per
 * tsconfig under the cache directory. A cold run builds the whole program
 * (tens of seconds on a large repository); a warm run re-checks only what
 * changed. When a run misses the deadline it is NOT killed: it keeps running
 * detached, writes the cache, and later edits get the fast path. A pid file
 * keeps a second check from racing a run that is still warming.
 *
 * Everything here fails open: this is advisory context, never a gate.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DomainResult } from "../core/orchestration-contract/identity";
import {
  isTypeScriptSource,
  judgeTypeCheck,
  parseTscOutput,
  parseTypeCheckMemory,
  type TypeAdvisory,
  type TypeCheckMemory,
  type TypeCheckOutcome,
} from "../core/type-diagnostics";
import { TYPE_DIAGNOSTICS_DEADLINE_MS, typeDiagnosticsCacheDir } from "../config";

export type TypeCheckProject = Readonly<{ tsconfig: string; projectDir: string; tscPath: string }>;

export type TypeDiagnosticsOptions = Readonly<{
  cacheDir?: string;
  deadlineMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}>;

const NO_ADVISORY: TypeAdvisory = { forModel: null, forOperator: null };

/** tsc exit codes that mean "ran to completion" (clean, or diagnostics present). */
const COMPLETED_EXIT_CODES: ReadonlySet<number> = new Set([0, 1, 2]);

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

type CachePaths = Readonly<{ buildInfo: string; output: string; pid: string; memory: string }>;

function cachePaths(cacheDir: string, tsconfig: string): CachePaths {
  const key = createHash("sha256").update(tsconfig).digest("hex").slice(0, 16);
  const at = (suffix: string) => join(cacheDir, `${key}.${suffix}`);
  return { buildInfo: at("tsbuildinfo"), output: at("out"), pid: at("pid"), memory: at("memory.json") };
}

/** Whether the run recorded in the pid file is still alive. A stale or missing file is not. */
function isRunAlive(pidFile: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, "utf-8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: the process exists but belongs to another user — still running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 300) ?? "";
}

/** Run the project's tsc once under a deadline. Never throws. */
async function runTypeCheck(project: TypeCheckProject, paths: CachePaths, deadlineMs: number): Promise<TypeCheckOutcome> {
  if (isRunAlive(paths.pid)) return { kind: "busy" };

  let outputFd: number;
  try {
    outputFd = openSync(paths.output, "w");
  } catch (error: unknown) {
    return { kind: "failed", reason: `cannot open ${paths.output}: ${(error as Error).message}` };
  }

  const child = spawn(
    process.execPath,
    [project.tscPath, "--noEmit", "-p", project.tsconfig, "--incremental", "--tsBuildInfoFile", paths.buildInfo, "--pretty", "false"],
    { cwd: project.projectDir, stdio: ["ignore", outputFd, outputFd], detached: true },
  );
  closeSync(outputFd);
  if (child.pid !== undefined) writeFileSync(paths.pid, String(child.pid));

  type Ended = { kind: "exited"; code: number | null; signal: string | null } | { kind: "spawn-error"; message: string } | { kind: "deadline" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race<Ended>([
    new Promise((settle) => child.once("exit", (code, signal) => settle({ kind: "exited", code, signal }))),
    new Promise((settle) => child.once("error", (error) => settle({ kind: "spawn-error", message: error.message }))),
    new Promise((settle) => { timer = setTimeout(() => settle({ kind: "deadline" }), deadlineMs); }),
  ]);
  clearTimeout(timer);

  if (ended.kind === "deadline") {
    // Let the build finish on its own: it writes the incremental cache.
    child.unref();
    return { kind: "timed-out", afterMs: deadlineMs };
  }
  rmSync(paths.pid, { force: true });
  if (ended.kind === "spawn-error") return { kind: "failed", reason: ended.message };

  const output = readFileSync(paths.output, "utf-8");
  if (ended.code === null || !COMPLETED_EXIT_CODES.has(ended.code)) {
    const detail = firstLine(output);
    return { kind: "failed", reason: `tsc exited with ${ended.code ?? ended.signal}${detail ? `: ${detail}` : ""}` };
  }
  const parsed = parseTscOutput(output, project.projectDir);
  return { kind: "completed", diagnostics: parsed.located, global: parsed.global };
}

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

/**
 * The advisory for one landed edit. Returns no advisory for files the check
 * does not cover, projects it cannot check, or when switched off with
 * LOOM_TYPE_DIAGNOSTICS=off. Never throws: an unexpected failure becomes an
 * operator note.
 */
export async function typeDiagnosticsAdvisory(file: string, options: TypeDiagnosticsOptions = {}): Promise<TypeAdvisory> {
  const env = options.env ?? process.env;
  if (env.LOOM_TYPE_DIAGNOSTICS === "off" || !isTypeScriptSource(file)) return NO_ADVISORY;

  try {
    if (!existsSync(file)) return NO_ADVISORY;
    const touchedFile = realpathSync(file);
    const located = locateTypeCheckProject(touchedFile);
    if (!located.ok) return NO_ADVISORY;

    const cacheDir = options.cacheDir ?? typeDiagnosticsCacheDir(env);
    mkdirSync(cacheDir, { recursive: true });
    const paths = cachePaths(cacheDir, located.value.tsconfig);

    const outcome = await runTypeCheck(located.value, paths, options.deadlineMs ?? TYPE_DIAGNOSTICS_DEADLINE_MS);
    const judged = judgeTypeCheck({ touchedFile, projectDir: located.value.projectDir, outcome, memory: loadMemory(paths.memory) });
    if (outcome.kind === "completed" && judged.memory !== null) storeMemory(paths.memory, judged.memory);
    return judged.advisory;
  } catch (error: unknown) {
    return { forModel: null, forOperator: `Loom type diagnostics could not run: ${error instanceof Error ? error.message : String(error)}` };
  }
}
