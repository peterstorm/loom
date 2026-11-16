/**
 * Repository paths the engine itself writes while a Task attempt is live.
 *
 * A Task's byte scope is judged against every Git-visible path that changed
 * during its attempt. The engine's State File write boundary changes paths on
 * its own behalf: the State File, and the lock and staging leaves it creates
 * beside the State File. None of them is a Task's write, so none may count
 * against a Task's scope, whether or not the project Git-ignores them.
 *
 * Ownership is exact: it is anchored to the one State File selected for the
 * settlement, never inferred from a directory namespace.
 *
 * Pure and total over repository-relative POSIX paths.
 */

/** The lock the State File's write boundary holds in the State File's directory. */
export const TASK_GRAPH_LOCK_NAME = ".task_graph" as const;

const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};

const leafOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The `<pid>-<epoch ms>-<base36>` token the no-follow writers append to a staged leaf. */
const STAGING_TOKEN = "[0-9]+-[0-9]+-[0-9a-z]*";

const escapeLeaf = (leaf: string): string => leaf.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * Exactly the lock leaves `withAnchoredDirectoryHandleLock` creates: the lock,
 * its stale-lock tomb, its recovery guard, the guard's prepared claim leaf and
 * the guard's tomb.
 */
const LOCK_LEAF = new RegExp(
  `^${escapeLeaf(TASK_GRAPH_LOCK_NAME)}` +
    `(?:\\.tomb-${STAGING_TOKEN}|\\.recovery(?:\\.claim-${STAGING_TOKEN}|\\.tomb-${STAGING_TOKEN})?)?$`,
  "u",
);

/**
 * A leaf the State File's write boundary creates beside the State File: the
 * lock and the leaves derived from it (`.recovery`, `.tomb-…`, the guard's
 * `.claim-…`), and the State File's own staging leaves (`.tmp-…`, `.claim-…`).
 * Any other leaf, however it is prefixed, stays a Task's write.
 */
export function isStateWriteCompanion(path: string, statePath: string): boolean {
  if (path === statePath || parentOf(path) !== parentOf(statePath)) return false;
  const leaf = leafOf(path);
  return LOCK_LEAF.test(leaf) ||
    new RegExp(`^${escapeLeaf(leafOf(statePath))}\\.(?:tmp|claim)-${STAGING_TOKEN}$`, "u").test(leaf);
}

/**
 * Whether the engine, not the Task, wrote a changed repository path: the
 * State File selected for this settlement or one of its write companions.
 * With no State File inside the repository, the engine owns nothing here.
 */
export function isEngineOwnedRuntimePath(path: string, statePath: string | null): boolean {
  return statePath !== null && (path === statePath || isStateWriteCompanion(path, statePath));
}
