/**
 * How a Task was found for an implementation result, and the one place a Task
 * is guessed from `executing_tasks`.
 *
 * Modern implementation settlement never guesses: Claude Code binds a running
 * Agent to its exact attempt through the Implementation Binding sidecar, and Pi
 * carries the reserved attempt authority on the spawn slot. Only legacy graphs,
 * whose Agents named no Task, still fall back to a guess: the one Task
 * executing, or (Pi) the first Task id in the parent's spawn prompt, which in a
 * batch names every Task.
 *
 * What stops a guess from completing a Task is a type, but not this one: every
 * positive settlement requires an `ImplementationAttemptAuthority`, which only
 * engine registration mints and a Task id cannot construct. A guessed Task
 * settles only through the untrusted legacy resolution
 * (`applyUntrustedStopResolution`): its evidence is stored, but the Task stays
 * `pending` with `revalidation_required`, and the attribution is reported as
 * unproven. A guard test refuses any other module that picks a Task from the
 * executing set by indexing it (`[0]`, `.at(0)`), destructuring it, or testing
 * its length against one.
 */

/** How a Task was found. Only `named` is the result's own identity. */
export type TaskAttribution = "named" | "parent-prompt" | "sole-executing";

export type SoleExecutingInference =
  | Readonly<{ kind: "inferred"; taskId: string }>
  | Readonly<{ kind: "unattributable"; executingCount: number }>;

/** The sole executing Task, or how many executed when none can be inferred. */
export function inferSoleExecutingTask(executing: readonly string[]): SoleExecutingInference {
  const [only, ...rest] = executing;
  return only !== undefined && rest.length === 0
    ? Object.freeze({ kind: "inferred", taskId: only })
    : Object.freeze({ kind: "unattributable", executingCount: executing.length });
}

/** Why a Task is credited on a guess, or null when the result named it itself. */
export function unprovenAttributionReason(
  agentType: string,
  taskId: string,
  attribution: TaskAttribution,
): string | null {
  switch (attribution) {
    case "named":
      return null;
    case "parent-prompt":
      return `${agentType} named no Task: attribution came from the parent's spawn prompt, which names every Task of a ` +
        `batch, so ${taskId} is credited on that guess and not on evidence`;
    case "sole-executing":
      return `${agentType} named no Task: attribution was inferred because executing_tasks holds exactly one ` +
        `Task, so ${taskId} is credited on that guess and not on evidence`;
  }
}
