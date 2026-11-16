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
 * - `forward-fix`: a Task a Forward Fix holds waits for that fix Task, so its
 *   retry judges the fixed code rather than failing on the same breach
 *   (`forward_fix_history`, written by `addForwardFix` in `forward-fix.ts`).
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import { distillDispatchBlockers, distillWithheldMessage } from "./distill-task";
import { nonEmpty, type NonEmpty } from "./orchestration-contract";
import type { TaskId } from "./task-id";
import type { ForwardFixAudit, Task } from "../types";

export type DispatchHold =
  | Readonly<{ kind: "distill-pass"; blockers: NonEmpty<string> }>
  | Readonly<{ kind: "forward-fix"; fixTaskIds: NonEmpty<TaskId> }>;

/** What the rule reads of a TaskGraph. */
export type DispatchHoldGraph = Readonly<{
  tasks: readonly Task[];
  forward_fix_history?: readonly ForwardFixAudit[];
}>;

/** A Task that has settled its implementation and holds no reservation. */
const settled = (task: Task, reserved: ReadonlySet<string>): boolean =>
  (task.status === "implemented" || task.status === "completed") &&
  !reserved.has(task.id) && task.active_implementation_attempt === undefined;

/**
 * The fix Tasks still holding `task`: every Forward Fix of its Wave that
 * names it and whose fix Task has not settled, in audit order. A fix Task
 * missing from the roster holds nothing: the loader refuses such a graph.
 */
function forwardFixHolders(graph: DispatchHoldGraph, reserved: ReadonlySet<string>, task: Task): readonly TaskId[] {
  const holders = (graph.forward_fix_history ?? [])
    .filter((audit) => audit.wave === task.wave && audit.heldTaskIds.some((id) => id === task.id))
    .flatMap(({ fixTaskId }) => {
      const fix = graph.tasks.find(({ id }) => id === fixTaskId);
      return fix === undefined || settled(fix, reserved) ? [] : [fixTaskId];
    });
  return Object.freeze([...new Set(holders)]);
}

/**
 * The hold on `task`, or null when it may be dispatched as far as its Wave is
 * concerned. `reserved` is every Task holding or about to hold a reservation
 * (a registering batch counts as reserved).
 */
export function dispatchHoldOf(graph: DispatchHoldGraph, reserved: ReadonlySet<string>, task: Task): DispatchHold | null {
  const distill = nonEmpty(distillDispatchBlockers(graph.tasks, reserved, task));
  if (distill !== null) return Object.freeze({ kind: "distill-pass", blockers: distill });
  const fixes = nonEmpty(forwardFixHolders(graph, reserved, task));
  return fixes === null ? null : Object.freeze({ kind: "forward-fix", fixTaskIds: fixes });
}

/** Why `taskId` is withheld, in the words status, registration and the brief all use. */
export function dispatchHoldMessage(taskId: string, hold: DispatchHold): string {
  return match(hold)
    .with({ kind: "distill-pass" }, ({ blockers }) => distillWithheldMessage(taskId, blockers))
    .with({ kind: "forward-fix" }, ({ fixTaskIds }) =>
      `${taskId} is held by Forward Fix ${fixTaskIds.join(", ")} and runs after it settles, so its next attempt ` +
      "judges the fixed code")
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
    .with({ kind: "forward-fix" }, () => "the held Task")
    .exhaustive();
  return `${dispatchHoldMessage(taskId, hold)}; none of them is dispatchable, active or escalated, ` +
    `so ${subject} can never start; repair the Task Graph`;
}
