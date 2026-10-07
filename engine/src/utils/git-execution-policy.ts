/**
 * The ONE execution policy every engine-observation Git child runs under —
 * chosen here, applied by `utils/git.ts` (HEAD/authority probes and, wrapped
 * in its shadow administration directory, every diff and tracking probe) and
 * by `utils/git-leaves.ts` (`gitOutput`: the single leaf enumerator and every
 * revision read that the snapshot hasher, reviewed workspace, Review Packet,
 * Wave lint and task-local diff share).
 *
 * The policy is one invocation — argv and environment together, so no caller
 * can apply half of it:
 *
 * - A Git child receives only process-launch essentials, never ambient
 *   authority such as GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 *   GIT_LITERAL_PATHSPECS/GIT_GLOB_PATHSPECS, GIT_CONFIG_COUNT/KEY/VALUE
 *   config injection, or executable diff overrides.
 * - System and global config are excluded, so no config authored outside the
 *   repository reaches the observation.
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

const INHERITED_LAUNCH_ESSENTIALS = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP",
  "SystemRoot", "WINDIR", "PATHEXT",
] as const;

/** Config forced at command scope on every policy-bound Git child. */
const COMMAND_SCOPE_CONFIG: readonly (readonly [key: string, value: string])[] = Object.freeze([
  Object.freeze(["core.fsmonitor", "false"] as const),
]);

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

/** One policy-bound Git child: the argv to pass after `git`, and its environment. */
export type HardenedGitInvocation = Readonly<{
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}>;

/** The policy applied to one Git command: `args` behind the command-scope
 *  `-c` prefix, and the allow-listed environment read fresh from the process. */
export function hardenedGitInvocation(
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
