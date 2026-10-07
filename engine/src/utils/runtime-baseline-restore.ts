/** Imperative shell over the runtime-baseline restoration rules
 *  (`core/runtime-baseline-restore`): gather the Git facts, decide purely,
 *  then resolve the restored baseline bytes into the write boundary value
 *  `captureLoomRuntimeIdentityAt` consumes. The ONE Git adapter here is
 *  git-leaves' `gitOutput`. */
import { isExactGitSha } from "../core/git-sha";
import {
  describeRuntimeBaselineRestoreRefusal,
  inFlightAttemptBaseline,
  runtimeBaselineRestoreAt,
  runtimeBaselineRestoreCandidates,
  type RuntimeBaselineRestore,
  type RuntimeBaselineTask,
} from "../core/runtime-baseline-restore";
import { runtimeDomainPaths, STRICT_RUNTIME_WRITE_BOUNDARY, type RuntimeWriteBoundary } from "../runtime-compatibility";
import { gitOutput, presentAtRevision } from "./git-leaves";
import { repositoryChangedPaths } from "./repository-change-baseline";

/**
 * The runtime-baseline restoration map for the in-flight `tasks`. An
 * unparseable or unrecorded attempt repository baseline THROWS its cause: the caller
 * fails closed (strict comparison everywhere) and can say why, instead of a
 * later write refusal reading as ordinary runtime drift.
 */
export function runtimeBaselineRestoreForTasks(
  root: string,
  tasks: readonly RuntimeBaselineTask[],
): RuntimeBaselineRestore {
  const dirtyNow = new Set(repositoryChangedPaths(root));
  if (dirtyNow.size === 0) return new Map();
  const candidates = runtimeBaselineRestoreCandidates({
    dirtyNow,
    domainPaths: runtimeDomainPaths(root),
    attemptRepositoryBaselines: tasks.flatMap((task) => inFlightAttemptBaseline(task) ?? []),
  });
  if (!candidates.ok) throw new Error(describeRuntimeBaselineRestoreRefusal(candidates.error));
  if (candidates.value.length === 0) return new Map();
  const revision = gitOutput(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  return runtimeBaselineRestoreAt(candidates.value, revision, presentAtRevision(root, revision, candidates.value));
}

/**
 * The exact bytes each restored path had at its mapped revision (`null` stays
 * excluded). A revision must be a full SHA-1 or SHA-256 object name, so it can
 * never smuggle another `git show` argument; anything else THROWS.
 */
export function runtimeBaselineBytes(
  root: string,
  restore: RuntimeBaselineRestore,
): ReadonlyMap<string, Uint8Array | null> {
  return new Map([...restore].map(([path, revision]): readonly [string, Uint8Array | null] => {
    if (revision === null) return [path, null];
    if (!isExactGitSha(revision)) {
      throw new Error(`runtime baseline restore: refusing non-SHA revision ${JSON.stringify(revision)}`);
    }
    return [path, Uint8Array.from(gitOutput(root, ["show", `${revision}:${path}`]))];
  }));
}

/** The write boundary for settling the in-flight `tasks`: strict when nothing
 *  restores, otherwise restoring at the resolved attempt-start bytes. Throws
 *  like `runtimeBaselineRestoreForTasks` and `runtimeBaselineBytes`. */
export function runtimeWriteBoundaryForTasks(
  root: string,
  tasks: readonly RuntimeBaselineTask[],
): RuntimeWriteBoundary {
  const restore = runtimeBaselineRestoreForTasks(root, tasks);
  return restore.size === 0
    ? STRICT_RUNTIME_WRITE_BOUNDARY
    : Object.freeze({ kind: "restoring", baseline: runtimeBaselineBytes(root, restore) });
}
