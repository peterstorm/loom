/**
 * The one place a Task is guessed from `executing_tasks`.
 *
 * Modern implementation settlement never guesses: Claude Code binds a running
 * Agent to its exact attempt through the Implementation Binding sidecar, and Pi
 * carries the reserved attempt authority on the spawn slot. Only legacy graphs,
 * whose Agents named no Task, still fall back to "the one Task executing". That
 * fallback is sound only when exactly one Task executes, and even then it is a
 * guess: the result is branded `InferredTaskId` so no caller can mistake it for
 * proven identity, and every consumer may only quarantine or release a legacy
 * reservation with it — never mint completion. A guard test refuses any other
 * module that reads `executing_tasks` to pick a Task.
 */

declare const INFERRED_TASK_ID: unique symbol;

/** A Task id inferred from the executing set, never proven by the Agent. */
export type InferredTaskId = string & { readonly [INFERRED_TASK_ID]: true };

export type SoleExecutingInference =
  | Readonly<{ kind: "inferred"; taskId: InferredTaskId }>
  | Readonly<{ kind: "unattributable"; executingCount: number }>;

/** The sole executing Task, or how many executed when none can be inferred. */
export function inferSoleExecutingTask(executing: readonly string[]): SoleExecutingInference {
  const [only, ...rest] = executing;
  return only !== undefined && rest.length === 0
    ? Object.freeze({ kind: "inferred", taskId: only as InferredTaskId })
    : Object.freeze({ kind: "unattributable", executingCount: executing.length });
}
