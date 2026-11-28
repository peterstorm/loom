/**
 * `orchestration amend-export-binding` (ADR-0105): drop one export of a
 * pending Task's Export Binding, or rename it keeping its frozen alias, in the
 * live TaskGraph, so a binding the plan got wrong is corrected for that Task
 * instead of by re-populating every Task.
 *
 * It is the "edit one binding" case of an active-Wave plan edit (ADR-0081):
 * the same precondition (`reopenableWave`), lock and audit history
 * (`wave_plan_edits`, an `export-binding-amended` edit built by the one
 * constructor the State File parser also uses).
 *
 * The edit keeps every invariant the State File proves about the G2 fields:
 * when a drop removes the binding's last export, the stamp no longer binds the
 * path, so the binding's skeleton record and every Task's recorded skeleton
 * outcome at the path go with it (the same rule re-population applies,
 * ADR-0051). The bytes the engine wrote stay on disk; with no binding they are
 * the Task's own code, reported `exists, not skeletonized`, owing no
 * conformance.
 *
 * Pure: the shell proves quiescence and commits under the lock.
 */

import { isFlagToken } from "./cli-flag-token";
import { taskRolePolicy } from "./distill-task";
import { nonEmpty, type DomainResult } from "./orchestration-contract";
import { samePlanPath } from "./plan-path-match";
import { parseReviewPath } from "./review-packet";
import { applyExportChange, parseIdentifier, type ExportChangeProblem } from "./skeleton/bindings";
import type { ExportBinding, ExportBindingChange, Identifier } from "./skeleton/types";
import { parseTaskId, type TaskId } from "./task-id";
import { reopenableWave, waveReopeningRefusalMessage } from "./task-revalidation";
import { exportBindingAmendedEdit, parsePlanEditReason } from "./wave-plan-edit";
import type { ExportBindingAmendedEdit, Task, TaskGraph } from "../types";

export const AMEND_EXPORT_BINDING_USAGE =
  "Usage: helper orchestration amend-export-binding --task <id> --file <path> --export <name> " +
  "(--drop | --rebind <newName>) --reason <text>";

export type ExportBindingAmendmentRequest = Readonly<{
  taskId: TaskId;
  /** The bound file, a canonical repository-relative path. */
  path: string;
  change: ExportBindingChange;
  reason: string;
}>;

export type ExportBindingAmendmentRefusal = Readonly<{
  kind:
    | "not-executing"
    | "live-wave-gate"
    | "implementation-active"
    | "unknown-task"
    /** The Task's file_list does not list the path. */
    | "not-held"
    /** A graph populated before export bindings were stamped binds nothing. */
    | "no-binding-stamp"
    /** The stamp binds no such path, or the binding no such export. */
    | "not-bound"
    | "not-pending"
    | "completed-wave"
    /** The Task itself holds a reservation or an attempt (of a later Wave too). */
    | "live-attempt"
    | "distill-task"
    /** The contract is still `awaiting-red`: its contract Task's stop writes stubs from the stamp. */
    | "contract-not-frozen"
    /** Another Task that lists the path already settled its implementation against the binding. */
    | "shared-with-settled-task"
    | "invalid-rebind";
  message: string;
}>;

export type ExportBindingAmendmentOutcome =
  | Readonly<{ kind: "amended"; graph: TaskGraph; audit: ExportBindingAmendedEdit }>
  | Readonly<{ kind: "unchanged"; taskId: TaskId; path: string; change: ExportBindingChange }>;

const freeze = Object.freeze;
const refuse = (kind: ExportBindingAmendmentRefusal["kind"], message: string): DomainResult<never, ExportBindingAmendmentRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });

type Flag = "--task" | "--file" | "--export" | "--rebind" | "--reason";
const VALUED_FLAGS: readonly string[] = ["--task", "--file", "--export", "--rebind", "--reason"];
const isValuedFlag = (flag: string | undefined): flag is Flag => flag !== undefined && VALUED_FLAGS.includes(flag);

/**
 * Exactly one `--task`, `--file`, `--export` and non-blank `--reason`, and
 * exactly one of `--drop` and `--rebind <newName>`. Names are identifiers the
 * binding grammar admits; a rebind names a different one.
 */
export function parseExportBindingAmendmentArgs(args: readonly string[]): DomainResult<ExportBindingAmendmentRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${AMEND_EXPORT_BINDING_USAGE}` });
  const values = new Map<Flag, string>();
  let drop = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--drop") {
      if (drop) return fail("--drop is given twice");
      drop = true;
      continue;
    }
    if (!isValuedFlag(flag)) return fail(`unknown argument '${flag}'`);
    const value = args[index + 1];
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (values.has(flag)) return fail(`${flag} is given twice`);
    values.set(flag, flag === "--reason" ? value.trim() : value);
    index += 1;
  }
  const task = values.get("--task");
  if (task === undefined) return fail("--task must name the Task whose binding changes");
  const taskId = parseTaskId(task, "--task");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const file = values.get("--file");
  if (file === undefined) return fail("--file must name the bound file");
  const path = parseReviewPath(file, "--file");
  if (!path.ok) return fail(path.errors.join("; "));
  const rawName = values.get("--export");
  if (rawName === undefined) return fail("--export must name the bound export");
  const name = parseIdentifier(rawName);
  if (!name.ok) return fail(`--export '${rawName}' is no identifier (${name.error})`);
  const change = changeOf(name.value, drop, values.get("--rebind"));
  if (!change.ok) return fail(change.error);
  const reason = values.get("--reason");
  if (reason === undefined) return fail("--reason must say why the binding changes");
  const parsedReason = parsePlanEditReason(reason);
  if (!parsedReason.ok) return fail(`--reason ${parsedReason.error}`);
  return freeze({
    ok: true as const,
    value: freeze({ taskId: taskId.value, path: path.value, change: change.value, reason: parsedReason.value }),
  });
}

function changeOf(name: Identifier, drop: boolean, rebind: string | undefined): DomainResult<ExportBindingChange, string> {
  const fail = (error: string) => freeze({ ok: false as const, error });
  if (drop && rebind !== undefined) return fail("give --drop or --rebind, not both");
  if (drop) return freeze({ ok: true as const, value: freeze({ kind: "dropped" as const, name }) });
  if (rebind === undefined) return fail("give --drop or --rebind <newName>");
  const to = parseIdentifier(rebind);
  if (!to.ok) return fail(`--rebind '${rebind}' is no identifier (${to.error})`);
  if (to.value === name) return fail(`--rebind names '${name}' itself`);
  return freeze({ ok: true as const, value: freeze({ kind: "rebound" as const, name, to: to.value }) });
}

const sameChange = (left: ExportBindingChange, right: ExportBindingChange): boolean =>
  left.kind === right.kind && left.name === right.name && (left.kind === "dropped" || (right.kind === "rebound" && left.to === right.to));

/**
 * Whether an earlier audited amendment of this Task made exactly this change
 * at this path, and the stamp still shows it: the dropped name is gone, or the
 * old name is gone and the new one bound. A replay, never a typo.
 */
function alreadyApplied(graph: TaskGraph, task: Task, binding: ExportBinding | undefined, request: ExportBindingAmendmentRequest): boolean {
  const audited = (graph.wave_plan_edits ?? []).some((edit) =>
    edit.kind === "export-binding-amended" && edit.taskId === task.id && samePlanPath(edit.path, request.path) &&
    sameChange(edit.change, request.change));
  if (!audited) return false;
  const bound = (name: string): boolean => binding?.exports.some((entry) => entry.name === name) ?? false;
  return request.change.kind === "dropped"
    ? !bound(request.change.name)
    : !bound(request.change.name) && bound(request.change.to);
}

function renderChangeProblem(path: string, problem: ExportChangeProblem): string {
  switch (problem.kind) {
    case "unbound-export":
      return `${path}'s binding has no export '${problem.name}'`;
    case "duplicate-name":
      return `${path}'s binding already binds '${problem.name}'`;
    case "name-collides-with-alias":
      return `'${problem.name}' is also an alias of ${path}'s binding; a TypeScript skeleton cannot import a type and declare ` +
        "a value of one name (name-collides-with-alias)";
    default: {
      const unreachable: never = problem;
      return unreachable;
    }
  }
}

/** The precondition refusals shared with Task reopening, in this operation's words. */
function waveRefusal(graph: TaskGraph): DomainResult<never, ExportBindingAmendmentRefusal> | null {
  const reopenable = reopenableWave(graph);
  return reopenable.ok
    ? null
    : refuse(reopenable.error.kind, waveReopeningRefusalMessage(reopenable.error, "amending an export binding", "amend it"));
}

const listsPath = (task: Task, path: string): boolean => (task.file_list ?? []).some((listed) => samePlanPath(listed, path));

/** Why the Task cannot take the amendment now, or null: its own lifecycle, its role, the contract, the path's other holders. */
function taskRefusal(graph: TaskGraph, task: Task, binding: ExportBinding): DomainResult<never, ExportBindingAmendmentRefusal> | null {
  if (task.status !== "pending") {
    return refuse("not-pending", `${task.id} is ${task.status}; only a pending Task's binding is amended (reopen it first)`);
  }
  const completedWaves = new Set((graph.wave_gate_history ?? []).map(({ wave }) => wave));
  if (completedWaves.has(task.wave) || task.wave < (graph.current_wave ?? task.wave)) {
    return refuse("completed-wave", `${task.id} is in completed Wave ${task.wave}; its binding was judged with that Wave`);
  }
  if (task.active_implementation_attempt !== undefined || task.reserved_at !== undefined) {
    return refuse("live-attempt", `${task.id} holds an implementation reservation; amend its binding once the attempt settles`);
  }
  if (!taskRolePolicy(task).holdsSkeletons) {
    return refuse("distill-task", `${task.id} is a Distill Task; amend the binding through the Task that implements ${binding.path}`);
  }
  const contract = (graph.acceptance_contracts ?? []).find(({ id }) => id === binding.contract);
  if (contract?.freeze.state === "awaiting-red") {
    return refuse("contract-not-frozen", `${binding.contract} is still awaiting RED; its contract Task's stop writes stubs from this ` +
      "binding, so correct the plan and re-populate before the contract Wave freezes");
  }
  const settled = graph.tasks.find((other) =>
    other.id !== task.id && listsPath(other, binding.path) && taskRolePolicy(other).holdsSkeletons &&
    (other.status === "implemented" || other.status === "completed"));
  return settled === undefined
    ? null
    : refuse("shared-with-settled-task", `${binding.path} is also ${settled.id}'s, which is ${settled.status} against this binding`);
}

/** The graph with `binding` replaced by `exports`, or removed with its skeleton record and recorded outcomes when none is left. */
function amendedGraph(graph: TaskGraph, stamp: readonly ExportBinding[], binding: ExportBinding, exports: ExportBinding["exports"] | null): TaskGraph {
  if (exports !== null) {
    return freeze({
      ...graph,
      export_bindings: freeze(stamp.map((candidate) => (candidate === binding ? freeze({ ...binding, exports }) : candidate))),
    });
  }
  const atPath = (path: string): boolean => samePlanPath(path, binding.path);
  const tasks = graph.tasks.map((task) => (task.skeleton_outcomes?.some(({ path }) => atPath(path)) === true
    ? freeze({ ...task, skeleton_outcomes: freeze(task.skeleton_outcomes.filter(({ path }) => !atPath(path))) })
    : task));
  return freeze({
    ...graph,
    tasks: freeze(tasks),
    export_bindings: freeze(stamp.filter((candidate) => candidate !== binding)),
    ...(graph.skeletons === undefined ? {} : { skeletons: freeze(graph.skeletons.filter(({ path }) => !atPath(path))) }),
  });
}

/**
 * Amend one export of the binding of a path a pending Task lists. Idempotent:
 * repeating a change an earlier audit of the same Task made, and the stamp
 * still shows, changes nothing. Every refusal leaves the graph as it was.
 */
export function amendExportBinding(
  graph: TaskGraph,
  request: ExportBindingAmendmentRequest,
): DomainResult<ExportBindingAmendmentOutcome, ExportBindingAmendmentRefusal> {
  const blocked = waveRefusal(graph);
  if (blocked !== null) return blocked;
  const task = graph.tasks.find(({ id }) => id === request.taskId);
  if (task === undefined) return refuse("unknown-task", `${request.taskId} is not in the TaskGraph`);
  if (!listsPath(task, request.path)) {
    return refuse("not-held", `${request.path} is not in ${task.id}'s file_list; amend the binding through the Task that implements it`);
  }
  const stamp = graph.export_bindings;
  if (stamp === undefined) {
    return refuse("no-binding-stamp", "the TaskGraph was populated before export bindings were stamped, so it binds nothing to amend");
  }
  const binding = stamp.find((candidate) => samePlanPath(candidate.path, request.path));
  if (alreadyApplied(graph, task, binding, request)) {
    return freeze({ ok: true as const, value: freeze({ kind: "unchanged" as const, taskId: request.taskId, path: request.path, change: request.change }) });
  }
  if (binding === undefined) return refuse("not-bound", `${request.path} carries no export binding`);
  if (!binding.exports.some(({ name }) => name === request.change.name)) {
    return refuse("not-bound", `${binding.path}'s binding to ${binding.contract} has no export '${request.change.name}' ` +
      `(it binds ${binding.exports.map(({ name }) => name).join(", ")})`);
  }
  const blockedTask = taskRefusal(graph, task, binding);
  if (blockedTask !== null) return blockedTask;
  const applied = applyExportChange(binding.path, binding.exports, request.change);
  if (!applied.ok) return refuse("invalid-rebind", renderChangeProblem(binding.path, applied.error));
  const audit = exportBindingAmendedEdit({
    wave: task.wave, taskId: task.id, path: binding.path, contract: binding.contract,
    change: request.change, before: binding.exports, reason: request.reason,
  });
  // Every input was proven above (a parsed request, a stamped binding that holds the name); a refusal here is a broken invariant.
  if (!audit.ok) throw new Error(`amend-export-binding built an invalid audit: ${audit.error}`);
  const amended = amendedGraph(graph, stamp, binding, nonEmpty(applied.value));
  return freeze({
    ok: true as const,
    value: freeze({
      kind: "amended" as const,
      graph: freeze({ ...amended, wave_plan_edits: freeze([...(graph.wave_plan_edits ?? []), audit.value]) }),
      audit: audit.value,
    }),
  });
}
