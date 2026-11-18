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

/**
 * Whether the implementation attempt of one Task may write:
 * - `implementing`: an ordinary attempt;
 * - `attesting`: armed for attestation, so it may not;
 * - `unobservable`: the TaskGraph could not be read or does not hold the Task.
 *   The guard fails closed on this.
 */
export type TaskWriteMode = "implementing" | "attesting" | "unobservable";

/** What the rule reads of a Task. */
export type AttestationTask = Pick<Task, "id" | "implementation_attestation">;

/** The write mode of Task `taskId` in `tasks`; `null` tasks mean the TaskGraph could not be read. */
export function taskWriteMode(tasks: readonly AttestationTask[] | null, taskId: string): TaskWriteMode {
  const task = tasks?.find(({ id }) => id === taskId);
  if (task === undefined) return "unobservable";
  return task.implementation_attestation === true ? "attesting" : "implementing";
}

/** The refusal an attesting attempt's write meets, naming its Task. */
export const attestationWriteRefusal = (taskId: string): string =>
  `BLOCKED: ${taskId} is in attestation mode. Its implementation is already judged, so this attempt verifies and ` +
  "changes nothing: run its tests and report what you find. If the code is wrong, say so in your result instead of " +
  "editing; the orchestrator reopens the Task for a real attempt.";

/** The refusal when the calling attempt's Task cannot be observed. */
export const unobservableWriteModeRefusal = (taskId: string): string =>
  `BLOCKED: cannot read the TaskGraph to check whether ${taskId} is in attestation mode; refusing the edit. ` +
  "Retry once the TaskGraph is readable, or report this to the orchestrator.";
