/**
 * Pure transition for a fresh Wave Gate run superseding an operator-abandoned
 * one. Abandonment only stamps a terminal tombstone; the abandoned run's
 * review epoch, spec-check record and packet-bound review state stay behind and
 * contradict any successor (an epoch must belong to the active run). This
 * retires that review authority exactly as restart and orphan recovery do —
 * accepted findings and Review Generations survive — and reopens any review
 * the abandoned run accepted, because that acceptance's authority died with it.
 */
import type { TaskGraph } from "../types";
import { resetWaveGateReviewAuthority } from "./wave-gate-machine";

export function supersedeAbandonedWaveGateReview(
  graph: TaskGraph,
  abandonedRunId: string,
  taskIds: readonly string[],
): TaskGraph {
  const reset = resetWaveGateReviewAuthority(graph, taskIds);
  return {
    ...reset,
    tasks: reset.tasks.map((task) =>
      taskIds.includes(task.id) && task.accepted_review_authority?.run_id === abandonedRunId
        ? { ...task, review_status: "pending" as const, accepted_review_authority: undefined }
        : task),
  };
}
