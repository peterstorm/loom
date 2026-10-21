/**
 * Orchestration Completion: when a TaskGraph's work is finished, and the name
 * its archived copy takes.
 *
 * A finished orchestration must leave the live graph path, because every Loom
 * guard (direct-edit block, spawn gates, state guard) keys on that path's
 * existence. Leaving it in place keeps the guards on after the last Wave Gate,
 * so post-gate review-and-fix in the same checkout is impossible (G4 slice 2
 * re-pilot, N3). Completion is judged here, purely; the shell archives the
 * exact bytes and removes the live graph under the TaskGraph lock.
 */

import type { TaskGraph } from "../types";

export type OrchestrationCompletion =
  | Readonly<{ kind: "complete"; taskCount: number }>
  | Readonly<{ kind: "incomplete"; reasons: readonly [string, ...string[]] }>;

/**
 * Complete when the graph has Tasks, every Task is `completed` (a Wave Gate
 * committed it), and no Wave Gate run is registered as active. Every unmet
 * condition is named.
 */
export function judgeOrchestrationCompletion(
  graph: Pick<TaskGraph, "tasks" | "active_wave_gate">,
): OrchestrationCompletion {
  const reasons = [
    ...(graph.tasks.length === 0 ? ["the TaskGraph has no Tasks"] : []),
    ...graph.tasks
      .filter((task) => task.status !== "completed")
      .map((task) => `Task ${task.id} is ${task.status}, not completed`),
    ...(graph.active_wave_gate === undefined
      ? []
      : [`Wave Gate run ${graph.active_wave_gate.runId} is still registered as active`]),
  ];
  const [first, ...rest] = reasons;
  return first === undefined
    ? Object.freeze({ kind: "complete", taskCount: graph.tasks.length })
    : Object.freeze({ kind: "incomplete", reasons: Object.freeze([first, ...rest]) as readonly [string, ...string[]] });
}

/**
 * The archive leaf for a completed graph, beside the live one:
 * `completed_task_graph-<issue|no-issue>-<UTC yyyymmddThhmmssZ>.json`.
 * The issue keeps archives of different orchestrations apart; the stamp keeps
 * repeated runs of one issue apart.
 */
export function completedGraphArchiveLeaf(graph: Pick<TaskGraph, "github_issue">, nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const issue = graph.github_issue === undefined ? "no-issue" : `issue-${graph.github_issue}`;
  return `completed_task_graph-${issue}-${stamp}.json`;
}
