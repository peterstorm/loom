/**
 * Dispatch holds: the one rule for an outstanding Task that is owed a
 * dispatch it may not have yet, because other Tasks of its Wave must settle
 * first. Status (`implementation-window.ts`), registration
 * (`validate-task-execution.ts`) and the brief all ask here, so status never
 * offers a dispatch registration would refuse or a brief would not render.
 *
 * Two holds exist:
 *
 * - `distill-pass`: a Distill Task waits for every other Task of its Wave
 *   (ADR-0068, `distillDispatchBlockers`).
 * - `dependency`: a Task waits for the Tasks of its own Wave it depends on
 *   until they settle their implementation (ADR-0081). A blocker that reached
 *   terminal escalation is named as such: the dependent is blocked, not waiting.
 *   A Forward Fix audit an older State File carries (ADR-0077, retired by
 *   ADR-0086) is read the same way: each held Task depends on its fix Task.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import { distillDispatchBlockers, distillWithheldMessage } from "./distill-task";
import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import { deriveTaskImplementationDispatch } from "./task-implementation-dispatch";
import type { ForwardFixAudit, Task } from "../types";

export type DispatchHold =
  | Readonly<{ kind: "distill-pass"; blockers: NonEmpty<string> }>
  /** Same-Wave dependencies not yet settled, each marked when it reached terminal escalation. */
  | Readonly<{ kind: "dependency"; blockers: NonEmpty<DependencyBlocker> }>;

/** One same-Wave dependency a Task waits for. */
export type DependencyBlocker = Readonly<{ id: string; escalated: boolean }>;

/** What the rule reads of a TaskGraph. */
export type DispatchHoldGraph = Readonly<{
  tasks: readonly Task[];
  forward_fix_history?: readonly ForwardFixAudit[];
}>;

/** A Task that has settled its implementation and holds no reservation. */
export const implementationSettled = (task: Task, reserved: ReadonlySet<string>): boolean =>
  (task.status === "implemented" || task.status === "completed") &&
  !reserved.has(task.id) && task.active_implementation_attempt === undefined;

/**
 * The Tasks `task` waits for: its `depends_on` edges, then the fix Task of
 * every legacy Forward Fix audit of its Wave that held it, without repeats.
 * This is the one wait relation: dispatch holds on it, and the plan edits
 * refuse a cycle in it (`waitRelation`).
 */
export function waitsFor(graph: DispatchHoldGraph, task: Task): readonly string[] {
  const fixes = (graph.forward_fix_history ?? [])
    .filter((audit) => audit.wave === task.wave && audit.heldTaskIds.some((id) => id === task.id))
    .map(({ fixTaskId }) => fixTaskId);
  return [...new Set([...task.depends_on, ...fixes])];
}

/** Every Task with the edges it waits on (`waitsFor`), for a cycle check over exactly what dispatch enforces. */
export const waitRelation = (graph: DispatchHoldGraph): readonly Readonly<{ id: string; wave: number; depends_on: readonly string[] }>[] =>
  graph.tasks.map((task) => Object.freeze({ id: task.id, wave: task.wave, depends_on: waitsFor(graph, task) }));

/**
 * The Tasks of `task`'s own Wave it waits for that have not settled, in edge
 * order, each marked when it escalated. Earlier-Wave and unknown edges are
 * registration's to refuse (`dependencyExecutionBlock`), and the State File
 * refuses an unknown one at load.
 */
function dependencyBlockers(graph: DispatchHoldGraph, reserved: ReadonlySet<string>, task: Task): readonly DependencyBlocker[] {
  return waitsFor(graph, task).flatMap((id) => {
    const dependency = graph.tasks.find((candidate) => candidate.id === id);
    return dependency === undefined || dependency.wave !== task.wave || implementationSettled(dependency, reserved)
      ? []
      // Reads the derivation's kind only; the stamp shapes nothing but a retry appendix.
      : [Object.freeze({ id, escalated: deriveTaskImplementationDispatch(dependency, undefined).kind === "escalated" })];
  });
}

/**
 * The hold on `task`, or null when it may be dispatched as far as its Wave is
 * concerned. `reserved` is every Task holding or about to hold a reservation
 * (a registering batch counts as reserved).
 */
export function dispatchHoldOf(graph: DispatchHoldGraph, reserved: ReadonlySet<string>, task: Task): DispatchHold | null {
  const distill = nonEmpty(distillDispatchBlockers(graph.tasks, reserved, task));
  if (distill !== null) return Object.freeze({ kind: "distill-pass", blockers: distill });
  const blockers = nonEmpty(dependencyBlockers(graph, reserved, task));
  return blockers === null ? null : Object.freeze({ kind: "dependency", blockers });
}

/** The ids of the blockers that reached terminal escalation, in edge order. */
export const escalatedBlockers = (blockers: readonly DependencyBlocker[]): readonly string[] =>
  blockers.flatMap(({ id, escalated }) => (escalated ? [id] : []));

/** Why `taskId` is withheld, in the words status, registration and the brief all use. */
export function dispatchHoldMessage(taskId: string, hold: DispatchHold): string {
  return match(hold)
    .with({ kind: "distill-pass" }, ({ blockers }) => distillWithheldMessage(taskId, blockers))
    .with({ kind: "dependency" }, ({ blockers }) => {
      const escalated = escalatedBlockers(blockers);
      return escalated.length > 0
        ? `${taskId} is blocked by escalated dependency ${escalated.join(", ")}; remediate it (helper orchestration remediate) ` +
          `before ${taskId} can run`
        : `${taskId} depends on ${blockers.map(({ id }) => id).join(", ")} of its Wave and runs after ` +
          `${blockers.length === 1 ? "it settles" : "they settle"}`;
    })
    .exhaustive();
}

/**
 * Status's contradiction for a held Task whose blockers can never settle:
 * none of them is dispatchable, active or escalated. The wording is the
 * hold's, so a new hold kind cannot fall into another kind's sentence.
 */
export function stuckDispatchHoldMessage(taskId: string, hold: DispatchHold): string {
  const subject = match(hold)
    .with({ kind: "distill-pass" }, () => "the distill pass")
    .with({ kind: "dependency" }, () => "the dependent Task")
    .exhaustive();
  return `${dispatchHoldMessage(taskId, hold)}; none of them is dispatchable, active or escalated, ` +
    `so ${subject} can never start; repair the Task Graph`;
}
