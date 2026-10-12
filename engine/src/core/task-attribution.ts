/**
 * The one place a Task is guessed from `executing_tasks`.
 *
 * Modern implementation settlement never guesses: Claude Code binds a running
 * Agent to its exact attempt through the Implementation Binding sidecar, and Pi
 * carries the reserved attempt authority on the spawn slot. Only legacy graphs,
 * whose Agents named no Task, still fall back to "the one Task executing". That
 * fallback is sound only when exactly one Task executes, and even then it is a
 * guess, so the result says so in its `kind`.
 *
 * What stops a guess from completing a Task is a type, but not this one: every
 * positive settlement requires an `ImplementationAttemptAuthority`, which only
 * engine registration mints and a Task id cannot construct. The legacy paths a
 * guess reaches (`applyUntrustedStopResolution`, quarantine and reservation
 * release) can never mint completion. A guard test refuses any other module
 * that picks a Task from the executing set by indexing it (`[0]`, `.at(0)`,
 * destructuring) or by testing its length against one.
 */

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
