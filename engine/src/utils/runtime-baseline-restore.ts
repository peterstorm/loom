/** Imperative shell over the runtime-baseline restoration rules
 *  (`core/runtime-baseline-restore`): gather the Git facts, decide purely. */
import {
  describeRuntimeBaselineRestoreRefusal,
  inFlightAttemptBaseline,
  runtimeBaselineRestoreAt,
  runtimeBaselineRestoreCandidates,
  type RuntimeBaselineRestore,
  type RuntimeBaselineTask,
} from "../core/runtime-baseline-restore";
import { runtimeDomainPaths } from "../runtime-compatibility";
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
