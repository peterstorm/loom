/**
 * The shell side of attestation enforcement (ADR-0085), shared by both
 * harnesses: read a TaskGraph's Tasks and answer the calling implementation
 * Agent's write mode. Each harness only names the Task and where its TaskGraph
 * is: Claude Code by the caller's bound attempt and the session's recorded
 * graph, Pi by the child's write grant.
 */

import { taskWriteMode, type ObservedTasks } from "../core/attestation-writes";
import type { CallerWriteMode } from "../core/block-direct-edits";
import type { StateManager } from "../state-manager";

/** Where a TaskGraph is: a manager for it, or `null` when none resolves. */
export type TaskGraphSource = () => StateManager | null;

/** The Tasks of the TaskGraph `source` resolves, or why they cannot be read (`label` names the graph). */
export function readAttestationTasks(source: TaskGraphSource, label: string): ObservedTasks {
  try {
    const graph = source();
    return graph === null
      ? Object.freeze({ ok: false as const, reason: `no TaskGraph resolves for ${label}` })
      : Object.freeze({ ok: true as const, tasks: graph.load().tasks });
  } catch (e) {
    return Object.freeze({
      ok: false as const,
      reason: `the TaskGraph of ${label} cannot be read: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

/** The write mode of Task `taskId`, read from the TaskGraph `source` resolves. */
export const callerWriteModeOf = (taskId: string, source: TaskGraphSource, label: string): CallerWriteMode =>
  Object.freeze({ taskId, mode: taskWriteMode(readAttestationTasks(source, label), taskId) });
