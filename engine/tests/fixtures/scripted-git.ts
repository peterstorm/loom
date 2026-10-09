/**
 * One scripted Git for every suite that fakes Git's status-returning spawn.
 * Answers are the production `GitSpawnOutcome` itself, built with the
 * constructors below (`answered`, `exited`, `failedToStart`), so a suite
 * scripts exactly the endings the code under test classifies, and the empty
 * transient the bounded retries discharge is `answered("")`: a status-0 exit
 * with empty stdout, nothing more.
 *
 * The answers reach the code under test through one of two seams:
 *
 * - `scriptedGitSpawn` — a plain `GitSpawn` port fake, for code that takes the
 *   port (config's root probe, changed-paths). No module mock at all; the
 *   fake records the logical argv and the run each probe asked for.
 * - `scriptedChildProcess` — the `node:child_process` module double for code
 *   whose spawn is not injectable. Each suite keeps its hoisted `vi.mock` as a
 *   one-line delegation here; this module owns the rest: the policy-argv
 *   decode (`logicalGitArgs`), and `rawSpawnResult`, the inverse of the
 *   policy's `parseGitSpawnResult` — including the null-stream rule (a spawn
 *   that started no child hands back no streams and no status, as both
 *   runtimes do).
 *
 * Load the module double from inside the `vi.mock` factory with
 * `await import(...)`: this module imports `node:child_process` nowhere (its
 * production imports are type-only), so loading it there cannot recurse into
 * the mock being built, and the factory and the suite share its one
 * `scriptedGit` state.
 */
import type { SpawnSyncOptions } from "node:child_process";
import { match } from "ts-pattern";
import type { GitSpawn, SpawnGitRun } from "../../src/utils/git-execution-policy";
import type { GitSpawnOutcome, RawGitSpawnResult } from "../../src/utils/git-spawn-outcome";
import { logicalGitArgs } from "./policy-bound-git-argv";

/** A child that ran and exited with `status`, having written these streams. */
export const exited = (status: number, stdout = "", stderr = ""): GitSpawnOutcome =>
  Object.freeze({ kind: "exited", status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });

/** Git's status-0 answer; `answered("")` is the empty transient. */
export const answered = (stdout: string): GitSpawnOutcome => exited(0, stdout);

/** A spawn that started no child (a missing executable, a bad cwd). */
export const failedToStart = (message: string, code: string | null = null): GitSpawnOutcome =>
  Object.freeze({ kind: "spawn-failed", code, message });

/** The raw `spawnSync` result a runtime hands back for `outcome`: the inverse
 *  of `parseGitSpawnResult` for the bounds that outcome names. */
export function rawSpawnResult(outcome: GitSpawnOutcome): RawGitSpawnResult {
  const spawnError = (code: string | null, message: string): Error & { code?: string } =>
    Object.assign(new Error(message), code === null ? {} : { code });
  return Object.freeze(match(outcome)
    .returnType<RawGitSpawnResult>()
    .with({ kind: "spawn-failed" }, ({ code, message }) =>
      ({ error: spawnError(code, message), status: null, signal: null, stdout: null, stderr: null }))
    .with({ kind: "faulted" }, ({ code, message, status, signal, stdout, stderr }) =>
      ({ error: spawnError(code, message), status, signal, stdout, stderr }))
    .with({ kind: "timed-out" }, ({ signal, stdout, stderr }) =>
      ({ error: spawnError("ETIMEDOUT", "spawnSync git ETIMEDOUT"), status: null, signal, stdout, stderr }))
    .with({ kind: "over-budget" }, ({ stdout, stderr }) =>
      ({ error: spawnError("ENOBUFS", "spawnSync git ENOBUFS"), status: null, signal: "SIGTERM", stdout, stderr }))
    .with({ kind: "signalled" }, ({ signal, stdout, stderr }) => ({ error: null, status: null, signal, stdout, stderr }))
    .with({ kind: "exited" }, ({ status, stdout, stderr }) => ({ error: null, status, signal: null, stdout, stderr }))
    .exhaustive());
}

const pastScript = (args: readonly string[]): Error =>
  new Error(`scripted Git ran past its answers at: git ${args.join(" ")}`);

/** One probe call the port fake saw: the logical argv and the run it asked for. */
export type ScriptedGitCall = Readonly<{ args: readonly string[]; run: SpawnGitRun }>;

/** A `GitSpawn` that answers in order, records every call, and fails loudly
 *  when the code under test runs past its script. */
export function scriptedGitSpawn(answers: readonly GitSpawnOutcome[]): Readonly<{
  spawn: GitSpawn;
  calls: readonly ScriptedGitCall[];
}> {
  const queue = [...answers];
  const calls: ScriptedGitCall[] = [];
  return Object.freeze({
    calls,
    spawn: (args, run) => {
      calls.push(Object.freeze({ args, run }));
      const next = queue.shift();
      if (next === undefined) throw pastScript(args);
      return next;
    },
  });
}

/** The module double's shared state. `answers` is the queue a suite scripts;
 *  `calls` holds the logical argv of each scripted spawn; while `passthrough`
 *  is set, every spawn runs the real `spawnSync` unrecorded (fixture setup). */
type ScriptedGitProcess = {
  readonly answers: GitSpawnOutcome[];
  readonly calls: Readonly<{ args: readonly string[] }>[];
  passthrough: boolean;
};

export const scriptedGit: ScriptedGitProcess = { answers: [], calls: [], passthrough: false };

/** Start a case: forget every call, script these answers, and choose passthrough. */
export function scriptGit(answers: readonly GitSpawnOutcome[], passthrough = false): void {
  scriptedGit.calls.length = 0;
  scriptedGit.answers.splice(0, scriptedGit.answers.length, ...answers);
  scriptedGit.passthrough = passthrough;
}

type ChildProcessModule = typeof import("node:child_process");

/** The `node:child_process` double: the real module with `spawnSync` answered
 *  from `scriptedGit`. A scripted answer is the loose raw shape the policy's
 *  parser reads (`RawGitSpawnResult`), not Node's full `SpawnSyncReturns`
 *  (no `pid`, no `output`), so the double is typed as `spawnSync` once, here. */
export function scriptedChildProcess(actual: ChildProcessModule): ChildProcessModule {
  const spawnSync = (file: string, args: readonly string[], options: SpawnSyncOptions): RawGitSpawnResult => {
    if (scriptedGit.passthrough) return actual.spawnSync(file, args, options);
    const logical = logicalGitArgs(args);
    scriptedGit.calls.push(Object.freeze({ args: logical }));
    const next = scriptedGit.answers.shift();
    if (next === undefined) throw pastScript(logical);
    return rawSpawnResult(next);
  };
  return { ...actual, spawnSync: spawnSync as unknown as ChildProcessModule["spawnSync"] };
}
