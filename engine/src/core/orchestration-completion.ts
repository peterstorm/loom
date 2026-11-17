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

/** One condition a finished orchestration still lacks; rendered to text only at the edge. */
export type CompletionShortfall =
  | Readonly<{ kind: "no-tasks" }>
  | Readonly<{ kind: "task-not-completed"; taskId: string; status: string }>
  | Readonly<{ kind: "wave-gate-active"; runId: string }>
  /** No run-scope retro is recorded, written or skipped (ADR-0083). */
  | Readonly<{ kind: "retro-missing" }>;

export type OrchestrationCompletion =
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "incomplete"; shortfalls: readonly [CompletionShortfall, ...CompletionShortfall[]] }>;

/** The operator's sentence for one shortfall. */
export function describeCompletionShortfall(shortfall: CompletionShortfall): string {
  switch (shortfall.kind) {
    case "no-tasks":
      return "the TaskGraph has no Tasks";
    case "task-not-completed":
      return `Task ${shortfall.taskId} is ${shortfall.status}, not completed`;
    case "wave-gate-active":
      return `Wave Gate run ${shortfall.runId} is still registered as active`;
    case "retro-missing":
      return "the run has no retrospective: run /retro (it records the retro with helper record-retro --file <path>), " +
        "or skip it deliberately with helper record-retro --skip --reason <text>";
    default: {
      const unreachable: never = shortfall;
      return unreachable;
    }
  }
}

/**
 * Complete when the graph has Tasks, every Task is `completed` (a Wave Gate
 * committed it), no Wave Gate run is registered as active, and a run-scope
 * retro is recorded, written or deliberately skipped (ADR-0083). Every unmet
 * condition is named.
 */
export function judgeOrchestrationCompletion(
  graph: Pick<TaskGraph, "tasks" | "active_wave_gate" | "retro_records">,
): OrchestrationCompletion {
  const [first, ...rest]: readonly CompletionShortfall[] = [
    ...(graph.tasks.length === 0 ? [{ kind: "no-tasks" as const }] : []),
    ...graph.tasks
      .filter((task) => task.status !== "completed")
      .map((task) => ({ kind: "task-not-completed" as const, taskId: task.id, status: task.status })),
    ...(graph.active_wave_gate === undefined
      ? []
      : [{ kind: "wave-gate-active" as const, runId: graph.active_wave_gate.runId }]),
    ...(runRetroRecorded(graph.retro_records) ? [] : [{ kind: "retro-missing" as const }]),
  ];
  if (first === undefined) return Object.freeze({ kind: "complete" });
  return Object.freeze({ kind: "incomplete", shortfalls: Object.freeze([first, ...rest] as const) });
}

/** The operator-facing refusal for an unfinished graph: every shortfall, then the
 *  two ways forward. */
export function renderCompletionRefusal(
  graphLeaf: string,
  shortfalls: readonly [CompletionShortfall, ...CompletionShortfall[]],
): string {
  return [
    `complete-orchestration: refusing — the orchestration is not finished (${graphLeaf} left in place):`,
    ...shortfalls.map((shortfall) => `  - ${describeCompletionShortfall(shortfall)}`),
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
