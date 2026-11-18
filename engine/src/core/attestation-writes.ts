/**
 * Attestation is enforced, not instructed (ADR-0085, loom#199 Cause 6).
 *
 * A Task armed for attestation (`implementation_attestation`, `helper
 * orchestration attest`) has an implementation that is already judged: its
 * next attempt verifies and changes nothing. That used to be an instruction in
 * the brief. Agents edited anyway, and each edit surfaced only afterwards as
 * terminal drift. The edit guard now asks this module whether the calling
 * implementation Agent's Task may write, and refuses the write of an attesting
 * Task. Drift detection stays as the backstop.
 *
 * Pure.
 */

import type { Task } from "../types";

/** What the rule reads of a Task. */
export type AttestationTask = Pick<Task, "id" | "implementation_attestation">;

/** The TaskGraph's Tasks as the shell observed them, or why it could not. */
export type ObservedTasks =
  | Readonly<{ ok: true; tasks: readonly AttestationTask[] }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * Whether the implementation attempt of one Task may write:
 * - `implementing`: an ordinary attempt;
 * - `attesting`: armed for attestation, so it may not;
 * - `unobservable`: the TaskGraph could not be read or does not hold the Task,
 *   with the cause. The guard fails closed on this.
 */
export type TaskWriteMode =
  | Readonly<{ kind: "implementing" }>
  | Readonly<{ kind: "attesting" }>
  | Readonly<{ kind: "unobservable"; reason: string }>;

const IMPLEMENTING: TaskWriteMode = Object.freeze({ kind: "implementing" });
const ATTESTING: TaskWriteMode = Object.freeze({ kind: "attesting" });

/** The write mode of Task `taskId` in the observed TaskGraph. */
export function taskWriteMode(observed: ObservedTasks, taskId: string): TaskWriteMode {
  if (!observed.ok) return Object.freeze({ kind: "unobservable", reason: observed.reason });
  const task = observed.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return Object.freeze({ kind: "unobservable", reason: `the TaskGraph holds no Task ${taskId}` });
  return task.implementation_attestation === true ? ATTESTING : IMPLEMENTING;
}

/** The refusal an attesting attempt's write meets, naming its Task. */
export const attestationWriteRefusal = (taskId: string): string =>
  `BLOCKED: ${taskId} is in attestation mode. Its implementation is already judged, so this attempt verifies and ` +
  "changes nothing: run its tests and report what you find. If the code is wrong, say so in your result instead of " +
  "editing; the orchestrator reopens the Task for a real attempt.";

/** The refusal when the calling attempt's Task cannot be observed, with the cause. */
export const unobservableWriteModeRefusal = (taskId: string, reason: string): string =>
  `BLOCKED: cannot check whether ${taskId} is in attestation mode (${reason}); refusing the edit. ` +
  "Report this to the orchestrator: a corrupt or missing TaskGraph does not fix itself by retrying.";
