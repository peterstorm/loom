/**
 * The one rule for which completed claims a spec amendment owes a
 * re-judgement (ADR-0087). The Requirement Coverage Projection and the Wave
 * Gate's re-anchoring both read it, so the claim spec-check judges is the
 * claim completion re-anchors.
 *
 * Pure leaf module: it reads the TaskGraph only.
 */

import type { Task, TaskGraph } from "../types";

/**
 * The claims of `task` that any spec amendment listed for re-judgement, when
 * the Task is still completed and still claims them, in audit order without
 * repeats. Whether one is still owed is the projection's to decide: it stays
 * owed while its recorded hash drifts from the current text.
 */
export function rejudgeClaimsOf(graph: Pick<TaskGraph, "spec_amendments">, task: Pick<Task, "id" | "status" | "spec_anchors">): readonly string[] {
  if (task.status !== "completed") return [];
  const anchors = task.spec_anchors ?? [];
  const listed = (graph.spec_amendments ?? []).flatMap(({ rejudge }) =>
    rejudge.flatMap((entry) => (entry.taskId === task.id && anchors.includes(entry.claim) ? [entry.claim] : [])));
  return Object.freeze([...new Set(listed)]);
}
