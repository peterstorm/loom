/**
 * The ONE execution policy every engine Git child runs under, and the ONE
 * place in the engine and Pi sources where `git` is spawned: `runGit`
 * (throwing) and `spawnGit` (returning a closed `GitSpawnOutcome`).
 * `tests/utils/git-spawn-seam-guard.test.ts` fails on any other spawn. Callers
 * are `utils/git.ts` (root/HEAD/authority probes and, through its shadow
 * administration directory, every diff, content-hashing listing and tracking
 * probe), `utils/git-leaves.ts` (`gitOutput`: the single leaf enumerator and
 * every revision read that the snapshot hasher, reviewed workspace, Review
 * Packet, Wave lint and task-local diff share), `utils/workspace-digest.ts`
 * (the workspace roster and root), `utils/declared-artifact-snapshot.ts`
 * (commit existence), `config.ts` (the task-graph boundary root),
 * `orchestration/remediation-candidate.ts` (tracking and ignore audits),
 * `orchestration/completion-check-runner.ts` (the report reset's tracking and
 * ignore probes, which must agree with those audits),
 * `orchestration/git-remediation.ts` (witness, temporary-index staging), and
 * the helper shells: review scope (`programs/changed-paths.ts`), Review
 * Packet, model calibration, task-graph population and implementation-proof
 * reconciliation.
 *
 * Moving a caller here intentionally drops the operator's system and global
 * config for it: `core.excludesFile`, `safe.directory`, `core.quotePath`,
 * `diff.renames`, `core.autocrlf`, `includeIf` and any user identity. Engine
 * observations must not depend on operator-local config, and no caller writes
 * a commit. A repository owned by another uid therefore fails every route
 * alike with Git's dubious-ownership diagnostic instead of passing some routes
 * and failing others.
 *
 * The policy is one invocation — argv and environment together — and it is
 * private to this module, so no caller can apply half of it or hand-roll the
 * spawn options around it:
 *
 * - A Git child receives only process-launch essentials — `PATH`, `HOME`, the
 *   temporary-directory variables and Windows' launch variables, each passed
 *   exactly when the engine's own process has it — never ambient authority
 *   such as GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 *   GIT_LITERAL_PATHSPECS/GIT_GLOB_PATHSPECS, GIT_CONFIG_COUNT/KEY/VALUE
 *   config injection, or executable diff overrides. The macOS verify failure
 *   that first surfaced a lost diagnostic here (run 37744264682) was not an
 *   environment gap: the same job's policy-bound Git children wrote 94
 *   not-a-repository diagnostics that arrived intact, Git there is Homebrew's
 *   binary rather than the `xcrun` shim (so `DEVELOPER_DIR`/`SDKROOT` are not
 *   consulted), and `TMPDIR`/`HOME`/`PATH` were passed.
 * - System and global config are excluded, so no config authored outside the
 *   repository reaches the observation — and every observer agrees on one
 *   ignore rule set (an operator's global `core.excludesFile` is invisible to
 *   all of them alike). `GIT_CONFIG_GLOBAL` alone does not reach Git's
 *   IMPLICIT global files, which it still reads from `$XDG_CONFIG_HOME/git`
 *   or `$HOME/.config/git` when no config names them: the default `ignore`
 *   (the global excludes file) and `attributes`. `XDG_CONFIG_HOME=/dev/null`
 *   makes both resolve under a non-directory, which Git skips silently
 *   (ENOTDIR), so `HOME` can still be passed for process launch.
 * - `core.fsmonitor` is disabled as command-scope config, which outranks every
 *   config file: it is the one repository-configured executable hook a
 *   read-only metadata command (`rev-parse`, `ls-files`, `ls-tree`,
 *   `cat-file`, `show`) can reach. It is supplied twice from one table: as a
 *   `-c` argv prefix, which every Git honours, and as GIT_CONFIG_COUNT/KEY/VALUE
 *   environment config, which only Git 2.31+ honours. The argv form is what
 *   makes the guarantee independent of the installed Git's version.
 *
 * Diffs and the tracking probe additionally run inside `utils/git.ts`'s shadow
 * administration directory, which removes repository config entirely. Diffs
 * are patches and the repository change baseline's dirty-path listings
 * (`changedPaths`), and they need it because they can run repository-authored
 * clean filters and diff drivers. Leaf listing deliberately does NOT: the
 * shadow directory has no `info/exclude` and no repository
 * `core.excludesFile`, which the enumerator's ignore rules must honour, and
 * `ls-files`/`ls-tree` run no filter or diff driver.
 *
 * A status-returning run never loses what the child said: `spawnGit` parses
 * the raw spawn result into a closed `GitSpawnOutcome` whose every arm that
 * ran a child carries both captured streams, and `diagnoseGitOutcome` renders
 * any arm — including a fatal exit whose stderr arrived empty, which Git
 * itself never produces — as a self-explaining diagnostic.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { match } from "ts-pattern";
import { COMMAND_SCOPE_ARGV, COMMAND_SCOPE_CONFIG } from "./git-command-scope";

/** Passed to every Git child exactly when the engine's own process has them. */
const INHERITED_LAUNCH_ESSENTIALS = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP",
  "SystemRoot", "WINDIR", "PATHEXT",
] as const;

/** The stdout budget of one `bytes` capture — a path or revision listing, in
 *  the repository or the shadow directory alike — unless the run names its own. */
const GIT_OUTPUT_LIMIT = 100 * 1024 * 1024;

/** Node's own `spawnSync` stdout budget (1 MiB): what a status probe that
 *  never named a budget — a root, HEAD, ref or single-path answer — ran
 *  under before it reached this seam, kept so routing it here changes no
 *  over-budget outcome. */
export const GIT_PROBE_OUTPUT_LIMIT = 1024 * 1024;

/** Where a policy-bound Git child finds its repository when it is not the
 *  working directory's own: the shadow administration directory's overrides.
 *  Closed to these names, so a caller can relocate the repository but never
 *  re-inject config or reopen an ambient variable the policy dropped. */
export type GitRepositoryLocation = Readonly<{
  GIT_DIR: string;
  GIT_WORK_TREE: string;
  GIT_INDEX_FILE: string;
  GIT_OBJECT_DIRECTORY: string;
}>;

/** A throwaway index for the working directory's own repository: remediation
 *  stages into one so the real index is untouched until a verified install. */
export type GitIndexLocation = Readonly<{ GIT_INDEX_FILE: string }>;

type HardenedGitInvocation = Readonly<{
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}>;

/** The policy applied to one Git command: `args` behind the command-scope
 *  `-c` prefix, and the allow-listed environment read fresh from the process. */
function hardenedGitInvocation(
  args: readonly string[],
  location?: GitRepositoryLocation | GitIndexLocation,
): HardenedGitInvocation {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_LAUNCH_ESSENTIALS) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const configEnvironment = Object.fromEntries(COMMAND_SCOPE_CONFIG.flatMap(([key, value], index) => [
    [`GIT_CONFIG_KEY_${index}`, key],
    [`GIT_CONFIG_VALUE_${index}`, value],
  ]));
  return Object.freeze({
    argv: Object.freeze([...COMMAND_SCOPE_ARGV, ...args]),
    env: Object.freeze({
      ...env,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      XDG_CONFIG_HOME: "/dev/null",
      GIT_CONFIG_COUNT: String(COMMAND_SCOPE_CONFIG.length),
      ...configEnvironment,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      ...location,
    }),
  });
}

/** One policy-bound spawn, assembled once for both runners: the hardened
 *  argv, and the spawn options every runner shares (the policy environment,
 *  plus `cwd` and `maxBuffer` exactly when the run names them). */
type PolicyBoundSpawn = Readonly<{ argv: readonly string[]; base: SpawnBase }>;

type SpawnBase = Readonly<{ cwd?: string; env: NodeJS.ProcessEnv; maxBuffer?: number }>;

function policyBoundSpawn(
  args: readonly string[],
  run: Readonly<{ cwd?: string; location?: GitRepositoryLocation | GitIndexLocation; maxBuffer?: number }>,
): PolicyBoundSpawn {
  const { argv, env } = hardenedGitInvocation(args, run.location);
  return Object.freeze({
    argv,
    base: Object.freeze({
      ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
      env,
      ...(run.maxBuffer === undefined ? {} : { maxBuffer: run.maxBuffer }),
    }),
  });
}

/** What a `runGit` child's stdout becomes: raw bytes, UTF-8 text, or nothing
 *  (stdout is not even piped — only the exit status and stderr matter). */
export type GitOutput = "bytes" | "text" | "discard";

export type GitOutputValue = Readonly<{ bytes: Buffer; text: string; discard: void }>;

/** One policy-bound run. `stdin` defaults to `"ignore"`; `maxBuffer` defaults
 *  to the listing budget for `bytes` and to Node's own default otherwise. */
export type GitRun<K extends GitOutput> = Readonly<{
  output: K;
  cwd?: string;
  location?: GitRepositoryLocation;
  stdin?: "ignore" | "pipe";
  maxBuffer?: number;
}>;

type GitRunner<K extends GitOutput> = (argv: readonly string[], base: SpawnBase, stdin: "ignore" | "pipe") => GitOutputValue[K];

const RUNNERS: { readonly [K in GitOutput]: GitRunner<K> } = {
  bytes: (argv, base, stdin) => execFileSync("git", argv, { ...base, encoding: "buffer", stdio: [stdin, "pipe", "pipe"] }),
  text: (argv, base, stdin) => execFileSync("git", argv, { ...base, encoding: "utf-8", stdio: [stdin, "pipe", "pipe"] }),
  discard: (argv, base, stdin) => {
    execFileSync("git", argv, { ...base, stdio: [stdin, "ignore", "pipe"] });
  },
};

/**
 * Run one Git command under the policy and return its stdout as `run.output`
 * names. THROWS exactly as `execFileSync` does — a non-zero exit carries
 * `status`, `signal`, `stdout` and `stderr`, an over-budget capture
 * `code: "ENOBUFS"` — so each caller keeps its own failure contract.
 */
export function runGit<K extends GitOutput>(args: readonly string[], run: GitRun<K>): GitOutputValue[K] {
  const { argv, base } = policyBoundSpawn(args, {
    ...run,
    maxBuffer: run.maxBuffer ?? (run.output === "bytes" ? GIT_OUTPUT_LIMIT : undefined),
  });
  return RUNNERS[run.output](argv, base, run.stdin ?? "ignore");
}

/** One status-returning run. `input`, when present, is piped as the child's
 *  whole stdin (otherwise stdin is ignored); `timeout` bounds the child's wall
 *  time; `location` relocates only through the closed overlays above. */
export type SpawnGitRun = Readonly<{
  cwd?: string;
  maxBuffer: number;
  input?: Uint8Array;
  timeout?: number;
  location?: GitRepositoryLocation | GitIndexLocation;
}>;

/** What a child that ran said: both streams, as captured bytes. */
export type GitCapture = Readonly<{ stdout: Buffer; stderr: Buffer }>;

/**
 * Every way one status-returning Git run can end, closed. Each arm in which a
 * child ran carries both captured streams, so no consumer can be handed an
 * outcome whose diagnostic was dropped on the way:
 *
 * - `spawn-failed` — no child ran (missing executable, bad cwd, …): the
 *   spawn error's code and message.
 * - `timed-out` — the child outlived `SpawnGitRun.timeout` and was killed.
 * - `over-budget` — a stream outgrew `SpawnGitRun.maxBuffer`; the child was
 *   killed and its captures are truncated.
 * - `signalled` — the child was terminated by a signal it did not ask for.
 * - `exited` — the child exited with `status`; this is the only arm a status
 *   protocol (`0` answered, `1` the clean negative answer) ever reads.
 */
export type GitSpawnOutcome =
  | Readonly<{ kind: "spawn-failed"; code: string | null; message: string }>
  | GitCapture & Readonly<{ kind: "timed-out"; timeoutMs: number | null; signal: NodeJS.Signals | null }>
  | GitCapture & Readonly<{ kind: "over-budget"; maxBuffer: number }>
  | GitCapture & Readonly<{ kind: "signalled"; signal: NodeJS.Signals }>
  | GitCapture & Readonly<{ kind: "exited"; status: number }>;

/** An outcome that exited with one of the statuses its caller's protocol accepts. */
export type GitExit<S extends number = number> = Extract<GitSpawnOutcome, { kind: "exited" }> & Readonly<{ status: S }>;

/** The status-returning seam as a port: production passes `spawnGit`, tests
 *  pass a fake returning `GitSpawnOutcome` values — no process, no mock of
 *  `node:child_process`, and the fake sees the caller's logical argv. */
export type GitSpawn = (args: readonly string[], run: SpawnGitRun) => GitSpawnOutcome;

/** The raw result a `spawnSync` implementation hands back, as loosely as Node
 *  and Bun actually shape it: Bun answers a missing executable with neither
 *  `status` nor captured streams, and a scripted test double may hand back
 *  strings. Everything past `parseGitSpawnResult` sees only the closed ADT. */
export type RawGitSpawnResult = Readonly<{
  error?: (Error & { code?: unknown }) | null;
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: Buffer | string | null;
  stderr?: Buffer | string | null;
}>;

const captured = (stream: Buffer | string | null | undefined): Buffer =>
  stream === null || stream === undefined ? Buffer.alloc(0) : Buffer.from(stream);

/** Parse one raw spawn result into its closed outcome. Pure: the run supplies
 *  the bounds a timed-out or over-budget arm names. */
export function parseGitSpawnResult(raw: RawGitSpawnResult, run: Pick<SpawnGitRun, "maxBuffer" | "timeout">): GitSpawnOutcome {
  const capture: GitCapture = Object.freeze({ stdout: captured(raw.stdout), stderr: captured(raw.stderr) });
  const signal = raw.signal ?? null;
  const error = raw.error ?? null;
  const code = error !== null && typeof error.code === "string" ? error.code : null;
  if (code === "ETIMEDOUT") return Object.freeze({ kind: "timed-out", timeoutMs: run.timeout ?? null, signal, ...capture });
  if (code === "ENOBUFS") return Object.freeze({ kind: "over-budget", maxBuffer: run.maxBuffer, ...capture });
  if (error !== null) return Object.freeze({ kind: "spawn-failed", code, message: error.message });
  if (signal !== null) return Object.freeze({ kind: "signalled", signal, ...capture });
  if (typeof raw.status === "number") return Object.freeze({ kind: "exited", status: raw.status, ...capture });
  return Object.freeze({
    kind: "spawn-failed",
    code: null,
    message: "the spawn reported no exit status, no signal and no error",
  });
}

/**
 * Run one Git command under the policy without throwing on its exit status:
 * for callers whose protocol reads `status` itself (`check-ignore`'s 0/1,
 * `ls-files --error-unmatch`, `merge-base`'s 0/1). Every ending — including a
 * spawn failure, a timeout and an over-budget capture — arrives as one arm of
 * the closed `GitSpawnOutcome`.
 */
export function spawnGit(args: readonly string[], run: SpawnGitRun): GitSpawnOutcome {
  const { argv, base } = policyBoundSpawn(args, run);
  return parseGitSpawnResult(spawnSync("git", argv, {
    ...base,
    encoding: "buffer",
    ...(run.timeout === undefined ? {} : { timeout: run.timeout }),
    ...(run.input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input: run.input, stdio: ["pipe", "pipe", "pipe"] }),
    windowsHide: true,
  }), run);
}

/** Whether the outcome is an exit its caller's status protocol accepts. */
export function gitExitedWith<S extends number>(outcome: GitSpawnOutcome, accepted: readonly S[]): outcome is GitExit<S> {
  return outcome.kind === "exited" && (accepted as readonly number[]).includes(outcome.status);
}

/** The clean negative answer of a 0/1 status protocol (`check-ignore -q`,
 *  `rev-parse --verify --quiet`, `merge-base`): exit 1 with nothing on either
 *  stream. An exit 1 that wrote anything is an error, never a "no". */
export function gitCleanNegative(outcome: GitSpawnOutcome): outcome is GitExit<1> {
  return gitExitedWith(outcome, [1]) && gitStdoutText(outcome).trim() === "" && gitStderrText(outcome) === "";
}

/** A captured stdout as UTF-8 text, untrimmed. */
export const gitStdoutText = (capture: GitCapture): string => capture.stdout.toString("utf-8");

/** A captured stderr as trimmed UTF-8 text: the diagnostic, or `""`. */
export const gitStderrText = (capture: GitCapture): string => capture.stderr.toString("utf-8").trim();

/** A rendered outcome: `head` names the ending ("exited 128", "terminated on
 *  signal SIGKILL", …); `detail` is Git's own stderr, the spawn error, or the
 *  explanation of a silence — `null` only when the ending itself says it all. */
export type GitDiagnosis = Readonly<{ head: string; detail: string | null }>;

const FATAL_EXIT_STATUS = 128;

/** Whether the outcome is a FATAL exit whose stderr arrived empty. Git writes
 *  a diagnostic for every fatal exit (`die()` exits 128, usage errors 129), so
 *  this is a capture lost between the child and this process — never Git's
 *  own silence, and never an answer a caller may classify. */
export function gitDiagnosticLost(outcome: GitSpawnOutcome): outcome is GitExit {
  return outcome.kind === "exited" && outcome.status >= FATAL_EXIT_STATUS && gitStderrText(outcome) === "";
}

function silentExitDetail(outcome: GitExit): string {
  const bytes = `stderr empty, stdout ${outcome.stdout.byteLength} bytes`;
  return gitDiagnosticLost(outcome)
    ? `${bytes} — Git writes a diagnostic for every fatal exit, so the child's stderr was lost before it reached the engine`
    : bytes;
}

/** Render any outcome so a failure names its own cause. Pure. */
export function diagnoseGitOutcome(outcome: GitSpawnOutcome): GitDiagnosis {
  const stderrOr = (capture: GitCapture, silent: string | null): string | null => {
    const diagnostic = gitStderrText(capture);
    return diagnostic === "" ? silent : diagnostic;
  };
  return Object.freeze(match(outcome)
    .with({ kind: "spawn-failed" }, ({ message }) => ({ head: "could not start", detail: message }))
    .with({ kind: "timed-out" }, (timedOut) => ({
      head: timedOut.timeoutMs === null ? "timed out" : `timed out after ${timedOut.timeoutMs} ms`,
      detail: stderrOr(timedOut, null),
    }))
    .with({ kind: "over-budget" }, (overBudget) => ({
      head: `exceeded its ${overBudget.maxBuffer}-byte output budget`,
      detail: stderrOr(overBudget, null),
    }))
    .with({ kind: "signalled" }, (signalled) => ({ head: `terminated on signal ${signalled.signal}`, detail: stderrOr(signalled, null) }))
    .with({ kind: "exited" }, (exited) => ({
      head: `exited ${exited.status}`,
      detail: stderrOr(exited, exited.status === 0 ? null : silentExitDetail(exited)),
    }))
    .exhaustive());
}

/** `diagnoseGitOutcome` as one line: `head` or `head: detail`. */
export function describeGitOutcome(outcome: GitSpawnOutcome): string {
  const { head, detail } = diagnoseGitOutcome(outcome);
  return detail === null ? head : `${head}: ${detail}`;
}
