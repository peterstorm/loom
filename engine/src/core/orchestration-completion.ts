/**
 * Orchestration Completion: when a TaskGraph's work is finished, the name its
 * archived copy takes, and the refusal an unfinished graph gets.
 *
 * A finished orchestration must leave the live graph path, because every Loom
 * guard (direct-edit block, spawn gates, state guard) keys on that path's
 * existence. Leaving it in place keeps the guards on after the last Wave Gate,
 * so post-gate review-and-fix in the same checkout is impossible (G4 slice 2
 * re-pilot, N3). Completion is judged here, purely; the shell archives the
 * exact bytes and removes the live graph under the TaskGraph lock.
 */

import { runRetroRecorded } from "./retro-record";
import type { TaskGraph } from "../types";

/** The completion reason a run without a run-scope retro record gets (ADR-0083). */
export const RETRO_MISSING_REASON =
  "the run has no retrospective: run /retro (it records the retro with helper record-retro --file <path>), " +
  "or skip it deliberately with helper record-retro --skip --reason <text>";

export type OrchestrationCompletion =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "incomplete"; reasons: readonly [string, ...string[]] }>;

/**
 * Complete when the graph has Tasks, every Task is `completed` (a Wave Gate
 * committed it), no Wave Gate run is registered as active, and a run-scope
 * retro is recorded, written or deliberately skipped (ADR-0083). Every unmet
 * condition is named.
 */
export function judgeOrchestrationCompletion(
  graph: Pick<TaskGraph, "tasks" | "active_wave_gate" | "retro_records">,
): OrchestrationCompletion {
  const [first, ...rest] = [
    ...(graph.tasks.length === 0 ? ["the TaskGraph has no Tasks"] : []),
    ...graph.tasks
      .filter((task) => task.status !== "completed")
      .map((task) => `Task ${task.id} is ${task.status}, not completed`),
    ...(graph.active_wave_gate === undefined
      ? []
      : [`Wave Gate run ${graph.active_wave_gate.runId} is still registered as active`]),
    ...(runRetroRecorded(graph.retro_records) ? [] : [RETRO_MISSING_REASON]),
  ];
  if (first === undefined) return Object.freeze({ kind: "complete" });
  const reasons: readonly [string, ...string[]] = Object.freeze([first, ...rest]);
  return Object.freeze({ kind: "incomplete", reasons });
}

/** The operator-facing refusal for an unfinished graph: every reason, then the
 *  two ways forward. */
export function renderCompletionRefusal(graphLeaf: string, reasons: readonly [string, ...string[]]): string {
  return [
    `complete-orchestration: refusing — the orchestration is not finished (${graphLeaf} left in place):`,
    ...reasons.map((reason) => `  - ${reason}`),
    "Finish the remaining Waves, or abort deliberately with `helper cleanup-state`.",
  ].join("\n");
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
