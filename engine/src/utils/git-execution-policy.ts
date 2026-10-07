/**
 * The ONE execution policy every engine-observation Git child runs under —
 * chosen here, applied by `utils/git.ts` (HEAD/authority probes and, wrapped
 * in its shadow administration directory, every diff and tracking probe) and
 * by `utils/git-leaves.ts` (`gitOutput`: the single leaf enumerator and every
 * revision read that the snapshot hasher, reviewed workspace, Review Packet,
 * Wave lint and task-local diff share).
 *
 * The policy is one allow-listed environment:
 *
 * - A Git child receives only process-launch essentials, never ambient
 *   authority such as GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 *   GIT_LITERAL_PATHSPECS/GIT_GLOB_PATHSPECS, GIT_CONFIG_COUNT/KEY/VALUE
 *   config injection, or executable diff overrides.
 * - System and global config are excluded, so no config authored outside the
 *   repository reaches the observation.
 * - `core.fsmonitor` is disabled as command-scope config (the environment
 *   form of `-c`, so it outranks every config file): it is the one
 *   repository-configured executable hook a read-only metadata command
 *   (`rev-parse`, `ls-files`, `ls-tree`, `cat-file`, `show`) can reach.
 *
 * Diffs, which can run repository-authored clean filters and diff drivers —
 * patches, and the repository change baseline's dirty-path listing
 * (`shadowChangedPaths`) — and the tracking probe additionally run inside `utils/git.ts`'s shadow
 * administration directory, which removes repository config entirely. Leaf
 * listing deliberately does NOT: the shadow directory has no `info/exclude`
 * and no repository `core.excludesFile`, which the enumerator's ignore rules
 * must honour, and `ls-files`/`ls-tree` run no filter or diff driver.
 */

const INHERITED_LAUNCH_ESSENTIALS = [
  "PATH", "HOME", "TMPDIR", "TEMP", "TMP",
  "SystemRoot", "WINDIR", "PATHEXT",
] as const;

/** The allow-listed environment of a policy-bound Git child, read fresh from the process. */
export function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_LAUNCH_ESSENTIALS) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
  };
}
