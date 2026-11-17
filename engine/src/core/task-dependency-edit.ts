/**
 * `orchestration add-dependency` (ADR-0081, loom#199 Cause 2): add
 * `depends_on` edges to a pending Task of the active Wave, so the order of a
 * Wave's Tasks is data the engine enforces rather than free-text notes.
 *
 * An edge may point at a Task of the active Wave (satisfied once it settles
 * its implementation, `task-dependencies.ts`) or of an earlier Wave. An edge
 * that would close a cycle is refused with the cycle named. The edit is a
 * `dependency-added` `WavePlanEdit`, built by the one constructor the State
 * File parser also uses.
 *
 * Pure: the shell proves quiescence and commits under the lock.
 */

import { isFlagToken } from "./cli-flag-token";
import { isDistillTask } from "./distill-task";
import type { DomainResult } from "./orchestration-contract";
import { cycleClosedBy } from "./task-dependencies";
import { parseTaskId, type TaskId } from "./task-id";
import { reopenableWave } from "./task-revalidation";
import { dependencyAddedEdit, parsePlanEditReason } from "./wave-plan-edit";
import type { DependencyAddedEdit, TaskGraph } from "../types";

export const ADD_DEPENDENCY_USAGE =
  "Usage: helper orchestration add-dependency --task <id> --on <id> [--on <id>]... --reason <text>";

export type AddDependencyRequest = Readonly<{
  taskId: TaskId;
  /** The Tasks it must wait for, distinct, in the order named. */
  dependsOn: readonly TaskId[];
  reason: string;
}>;

export type AddDependencyRefusal = Readonly<{
  kind:
    | "not-executing"
    | "live-wave-gate"
    | "implementation-active"
    | "unknown-task"
    | "not-pending"
    | "not-active-wave"
    | "distill-task"
    | "attested"
    | "illegal-dependency"
    | "cycle";
  message: string;
}>;

export type AddDependency =
  | Readonly<{ kind: "added"; graph: TaskGraph; audit: DependencyAddedEdit }>
  | Readonly<{ kind: "unchanged"; taskId: TaskId }>;

const freeze = Object.freeze;
const refuse = (kind: AddDependencyRefusal["kind"], message: string): DomainResult<never, AddDependencyRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });

/** Exactly one `--task` and one non-blank `--reason`, and at least one distinct `--on` Task other than the Task itself. */
export function parseAddDependencyArgs(args: readonly string[]): DomainResult<AddDependencyRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${ADD_DEPENDENCY_USAGE}` });
  let task: string | undefined;
  let reason: string | undefined;
  const on: TaskId[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--task" && flag !== "--on" && flag !== "--reason") return fail(`unknown argument '${flag}'`);
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (flag === "--task") {
      if (task !== undefined) return fail("--task is given twice");
      task = value;
    } else if (flag === "--reason") {
      if (reason !== undefined) return fail("--reason is given twice");
      reason = value.trim();
    } else {
      const id = parseTaskId(value, "--on");
      if (!id.ok) return fail(id.error.errors.join("; "));
      if (on.includes(id.value)) return fail(`--on ${id.value} is given twice`);
      on.push(id.value);
    }
  }
  if (task === undefined) return fail("--task must name the Task that waits");
  const taskId = parseTaskId(task, "--task");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  if (on.length === 0) return fail("--on must name at least one Task to wait for");
  if (on.includes(taskId.value)) return fail(`${taskId.value} cannot depend on itself`);
  if (reason === undefined) return fail("--reason must say why the plan changes");
  const parsedReason = parsePlanEditReason(reason);
  if (!parsedReason.ok) return fail(`--reason ${parsedReason.error}`);
  return freeze({ ok: true as const, value: freeze({ taskId: taskId.value, dependsOn: freeze(on), reason: parsedReason.value }) });
}

/** The precondition refusals shared with Task reopening, in this operation's words. */
function waveRefusal(graph: TaskGraph): DomainResult<never, AddDependencyRefusal> | null {
  const reopenable = reopenableWave(graph);
  if (reopenable.ok) return null;
  const refusal = reopenable.error;
  switch (refusal.kind) {
    case "not-executing":
      return refuse("not-executing", `adding a dependency requires the execute Phase (current: ${refusal.phase})`);
    case "live-wave-gate":
      return refuse("live-wave-gate", `Wave Gate run ${refusal.runId} owns Wave ${refusal.wave}; abandon it with helper orchestration abandon, then retry`);
    case "implementation-active":
      return refuse("implementation-active", `implementation reservations are active: ${refusal.holders.join(", ")}; add the dependency once they settle`);
    default: {
      const unreachable: never = refusal;
      return unreachable;
    }
  }
}

/**
 * Add the request's edges to its Task, or refuse with the exact precondition
 * that failed. Idempotent: a request whose edges are all present changes
 * nothing. Edges are checked one at a time, so a cycle through two of the
 * requested edges is caught too.
 */
export function addDependency(graph: TaskGraph, request: AddDependencyRequest): DomainResult<AddDependency, AddDependencyRefusal> {
  const blocked = waveRefusal(graph);
  if (blocked !== null) return blocked;
  const task = graph.tasks.find(({ id }) => id === request.taskId);
  if (task === undefined) return refuse("unknown-task", `${request.taskId} is not in the TaskGraph`);
  const added = request.dependsOn.filter((id) => !task.depends_on.includes(id));
  if (added.length === 0) return freeze({ ok: true as const, value: freeze({ kind: "unchanged" as const, taskId: request.taskId }) });
  const wave = graph.current_wave ?? task.wave;
  if (task.wave !== wave) return refuse("not-active-wave", `${task.id} is in Wave ${task.wave}, not the active Wave ${wave}`);
  if (task.status !== "pending") return refuse("not-pending", `${task.id} is ${task.status}; only a pending Task gains a dependency (reopen it first)`);
  if (isDistillTask(task)) return refuse("distill-task", `${task.id} is a Distill Task; the engine orders it after every other Task of its Wave`);
  if (task.implementation_attestation === true) return refuse("attested", `${task.id} is armed for attestation; its implementation is already judged`);
  let tasks = graph.tasks;
  for (const id of added) {
    const dependency = tasks.find((candidate) => candidate.id === id);
    if (dependency === undefined) return refuse("unknown-task", `${id} is not in the TaskGraph`);
    if (dependency.wave > wave) {
      return refuse("illegal-dependency", `${id} is in later Wave ${dependency.wave}; ${task.id} can wait only for its own Wave or an earlier one`);
    }
    if (isDistillTask(dependency)) return refuse("illegal-dependency", `${id} is a Distill Task; it runs after every other Task of its Wave`);
    const cycle = cycleClosedBy(tasks, task.id, id);
    if (cycle !== null) return refuse("cycle", `${task.id} → ${id} would close the dependency cycle ${cycle.join(" → ")}`);
    tasks = tasks.map((candidate) =>
      candidate.id === task.id ? freeze({ ...candidate, depends_on: freeze([...candidate.depends_on, id]) }) : candidate);
  }
  const audit = dependencyAddedEdit({ wave, taskId: task.id, dependsOn: added, reason: request.reason });
  // Every input was proven above (parsed ids, at least one new edge, the reason); a refusal here is a broken invariant.
  if (!audit.ok) throw new Error(`add-dependency built an invalid audit: ${audit.error}`);
  return freeze({
    ok: true as const,
    value: freeze({
      kind: "added" as const,
      graph: freeze({ ...graph, tasks: freeze(tasks), wave_plan_edits: freeze([...(graph.wave_plan_edits ?? []), audit.value]) }),
      audit: audit.value,
    }),
  });
}
