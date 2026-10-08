/**
 * The ONE execution policy every engine-observation Git child runs under, and
 * the ONE place such a child is spawned: `runGit` (throwing) and `spawnGit`
 * (status-returning). Callers are `utils/git.ts` (HEAD/authority probes and,
 * through its shadow administration directory, every diff, content-hashing
 * listing and tracking probe), `utils/git-leaves.ts` (`gitOutput`: the single
 * leaf enumerator and every revision read that the snapshot hasher, reviewed
 * workspace, Review Packet, Wave lint and task-local diff share),
 * `utils/workspace-digest.ts` (the workspace roster and root) and
 * `orchestration/remediation-candidate.ts` (tracking and ignore audits).
 *
 * The policy is one invocation — argv and environment together — and it is
 * private to this module, so no caller can apply half of it or hand-roll the
 * spawn options around it:
 *
 * - A Git child receives only process-launch essentials, never ambient
 *   authority such as GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 *   GIT_LITERAL_PATHSPECS/GIT_GLOB_PATHSPECS, GIT_CONFIG_COUNT/KEY/VALUE
 *   config injection, or executable diff overrides.
 * - System and global config are excluded, so no config authored outside the
 *   repository reaches the observation — and every observer agrees on one
 *   ignore rule set (an operator's global `core.excludesFile` is invisible to
 *   all of them alike).
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
 */
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";

const INHERITED_LAUNCH_ESSENTIALS = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP",
  "SystemRoot", "WINDIR", "PATHEXT",
] as const;

/** Config forced at command scope on every policy-bound Git child. */
const COMMAND_SCOPE_CONFIG: readonly (readonly [key: string, value: string])[] = Object.freeze([
  Object.freeze(["core.fsmonitor", "false"] as const),
]);

/** The stdout budget of one `bytes` capture — a path or revision listing, in
 *  the repository or the shadow directory alike — unless the run names its own. */
const GIT_OUTPUT_LIMIT = 100 * 1024 * 1024;

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

type HardenedGitInvocation = Readonly<{
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}>;

/** The policy applied to one Git command: `args` behind the command-scope
 *  `-c` prefix, and the allow-listed environment read fresh from the process. */
function hardenedGitInvocation(
  args: readonly string[],
  location?: GitRepositoryLocation,
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
    argv: Object.freeze([...COMMAND_SCOPE_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...args]),
    env: Object.freeze({
      ...env,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: String(COMMAND_SCOPE_CONFIG.length),
      ...configEnvironment,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      ...location,
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

type SpawnBase = Readonly<{ cwd?: string; env: NodeJS.ProcessEnv; maxBuffer?: number }>;

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
 * `status`, `stdout` and `stderr`, an over-budget capture `code: "ENOBUFS"` —
 * so each caller keeps its own failure contract.
 */
export function runGit<K extends GitOutput>(args: readonly string[], run: GitRun<K>): GitOutputValue[K] {
  const { argv, env } = hardenedGitInvocation(args, run.location);
  const maxBuffer = run.maxBuffer ?? (run.output === "bytes" ? GIT_OUTPUT_LIMIT : undefined);
  const base: SpawnBase = {
    ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
    env,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  };
  return RUNNERS[run.output](argv, base, run.stdin ?? "ignore");
}

/**
 * Run one Git command under the policy without throwing on its exit status:
 * for callers whose protocol reads `status` itself (`check-ignore`'s 0/1,
 * `ls-files --error-unmatch`). stdout and stderr are captured as bytes; a
 * spawn failure or an over-budget capture arrives as `error`.
 */
export function spawnGit(
  args: readonly string[],
  run: Readonly<{ cwd?: string; maxBuffer: number }>,
): SpawnSyncReturns<Buffer> {
  const { argv, env } = hardenedGitInvocation(args);
  return spawnSync("git", argv, {
    ...(run.cwd === undefined ? {} : { cwd: run.cwd }),
    env,
    encoding: "buffer",
    maxBuffer: run.maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
