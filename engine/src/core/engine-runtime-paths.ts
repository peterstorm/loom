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

/**
 * A leaf the State File's write boundary creates beside the State File: the
 * lock, every leaf derived from the lock (`.recovery`, `.tomb-…`), and every
 * staging leaf derived from the State File (`.tmp-…`, `.claim-…`).
 */
export function isStateWriteCompanion(path: string, statePath: string): boolean {
  if (path === statePath || parentOf(path) !== parentOf(statePath)) return false;
  const leaf = leafOf(path);
  return leaf === TASK_GRAPH_LOCK_NAME ||
    leaf.startsWith(`${TASK_GRAPH_LOCK_NAME}.`) ||
    leaf.startsWith(`${leafOf(statePath)}.`);
}

/**
 * Whether the engine, not the Task, wrote a changed repository path: the
 * State File selected for this settlement or one of its write companions.
 * With no State File inside the repository, the engine owns nothing here.
 */
export function isEngineOwnedRuntimePath(path: string, statePath: string | null): boolean {
  return statePath !== null && (path === statePath || isStateWriteCompanion(path, statePath));
}
