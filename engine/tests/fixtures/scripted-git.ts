/**
 * One scripted Git for every suite that fakes Git's status-returning spawn.
 * Answers are the production `GitSpawnOutcome` itself, built with the
 * constructors below (`answered`, `exited`, `failedToStart`), so a suite
 * scripts exactly the endings the code under test classifies, and the empty
 * transient the bounded retries discharge is `answered("")`: a status-0 exit
 * with empty stdout, nothing more.
 *
 * The answers reach the code under test through its injected `GitSpawn` port:
 * `scriptedGitSpawn` is a plain port fake, owned by the one test that builds
 * it — no module mock of `node:child_process`, no state shared between cases.
 * The fake records the logical argv and the run each probe asked for.
 */
import type { GitSpawn, SpawnGitRun } from "../../src/utils/git-execution-policy";
import type { GitSpawnOutcome } from "../../src/utils/git-spawn-outcome";

/** A child that ran and exited with `status`, having written these streams. */
export const exited = (status: number, stdout = "", stderr = ""): GitSpawnOutcome =>
  Object.freeze({ kind: "exited", status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });

/** Git's status-0 answer; `answered("")` is the empty transient. */
export const answered = (stdout: string): GitSpawnOutcome => exited(0, stdout);

/** A spawn that started no child (a missing executable, a bad cwd). */
export const failedToStart = (message: string, code: string | null = null): GitSpawnOutcome =>
  Object.freeze({ kind: "spawn-failed", code, message });

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
      if (next === undefined) throw new Error(`scripted Git ran past its answers at: git ${args.join(" ")}`);
      return next;
    },
  });
}
