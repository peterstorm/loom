/**
 * Core: exact Implementation Attempt binding for a Claude implementation Agent.
 *
 * Claude Code fires SubagentStart BEFORE the child transcript exists, so the
 * Agent's exact attempt cannot be proven when it is spawned — and a
 * SubagentStart block is not honored anyway. Binding is therefore a state the
 * Agent moves through, settled lazily at points Claude does honor (PreToolUse,
 * SubagentStop):
 *
 *   pending ──first prompt names an executing Task with a modern attempt──▶ bound
 *      │
 *      └──prompt names no / an unknown / a non-executing Task, or a
 *         conflicting authority already owns the Agent──────────────────▶ refused
 *
 * Only `bound` admits writes. The Task comes ONLY from the Agent's own trusted
 * first prompt — never from "the only pending reservation": a Wave spawns
 * several implementers of the same type in parallel, so reservation-guessing
 * would be ambiguous and could bind an Agent to a sibling's Task.
 *
 * Pure: the shell (`handlers/implementation-binding`) observes the transcript,
 * the TaskGraph and the sidecar, and hands the observations in.
 */

import type { TaskGraph } from "../types";
import type { ImplementationAttemptAuthority } from "./implementation-completion";
import { extractTaskId } from "../utils/extract-task-id";

/** What the child's transcript says about its first user prompt. */
export type FirstPromptObservation =
  /** No transcript bytes yet — the harness has not flushed the child's prompt. */
  | Readonly<{ kind: "unwritten"; reason: string }>
  /** Bytes exist but carry no trusted authored first prompt. */
  | Readonly<{ kind: "untrusted"; reason: string }>
  | Readonly<{ kind: "prompt"; text: string }>;

/**
 * An Agent's exact-authority state. `pending` resolves by retrying once the
 * transcript is written; `refused` is re-derived on every attempt but cannot
 * change unless the TaskGraph does.
 */
export type ImplementationBinding =
  | Readonly<{ kind: "pending"; reason: string }>
  | Readonly<{ kind: "bound"; authority: ImplementationAttemptAuthority }>
  | Readonly<{ kind: "refused"; reason: string }>;

/** Which attempt the first prompt proves — before any sidecar is published. */
type AttemptIdentification =
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "identified"; authority: ImplementationAttemptAuthority }>
  | Readonly<{ kind: "refused"; reason: string }>;

/**
 * The exact attempt `prompt` names in `graph`. Total: every input maps to one
 * identification, and an `identified` authority is always the active attempt
 * of the Task the prompt itself names.
 */
export function identifyImplementationAttempt(
  prompt: FirstPromptObservation,
  graph: TaskGraph,
): AttemptIdentification {
  if (prompt.kind === "unwritten") return Object.freeze({ kind: "unavailable", reason: prompt.reason });
  if (prompt.kind === "untrusted") return Object.freeze({ kind: "refused", reason: prompt.reason });
  const taskId = extractTaskId(prompt.text);
  if (taskId === null) {
    return Object.freeze({ kind: "refused", reason: "trusted first user prompt contains no Task id" });
  }
  const task = graph.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return Object.freeze({ kind: "refused", reason: `trusted first user prompt names unknown Task ${taskId}` });
  }
  const attempt = task.active_implementation_attempt;
  if (!(graph.executing_tasks ?? []).includes(taskId) || attempt === undefined) {
    return Object.freeze({ kind: "refused", reason: `Task ${taskId} has no current modern implementation attempt` });
  }
  return Object.freeze({ kind: "identified", authority: attempt });
}
