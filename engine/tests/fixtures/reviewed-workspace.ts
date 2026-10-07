import {
  reviewedWorkspaceObservation,
  type ObservedArtifact,
  type ReviewedWorkspaceObservation,
} from "../../src/core/reviewed-workspace";

/** A proven observation for fixtures whose inputs are known-good. */
export function observedWorkspace(
  taskId: string,
  scope: readonly string[],
  artifacts: readonly ObservedArtifact[],
): ReviewedWorkspaceObservation {
  const observed = reviewedWorkspaceObservation(taskId, scope, artifacts);
  if (!observed.ok) throw new Error(observed.error);
  return observed.value;
}
