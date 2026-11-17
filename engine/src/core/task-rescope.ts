/**
 * `orchestration rescope-task` (loom#198, Cause 3): add files to, or remove
 * files from, a pending Task of the active Wave or a later one, so a Task
 * whose scope cannot satisfy its policy (a new-tests Task with no test file)
 * is repaired in place instead of by re-populating every Task.
 *
 * It is the "edit one Task's file list" case of an active-Wave plan edit
 * (loom#199). Its audit is a `WavePlanEdit`, a union over edit kinds, so
 * adding a Task or a dependency later extends the same history.
 *
 * The edit keeps every invariant population checks: the Task still owns no
 * path another Task of its Wave lists, no protected verification path, no
 * frozen Acceptance Contract path it does not write, never drops a path an
 * export binding names, still declares a test file when it owes I6, and lists
 * every member of a coupled file set it lists part of (ADR-0082). A path a
 * completed Wave sealed joins only when named with `--add-sealed-file`
 * (ADR-0081), and the audit records it as sealed. Its Proof is
 * re-derived for the new file list and its attempt baseline is cleared for
 * the next registration to capture. When it carries a population baseline,
 * that baseline gains the added files as Git held them at the Task's
 * `start_sha`, so Proof judges them from the same boundary as the rest.
 *
 * Pure: the shell observes the added files' baselines (`rescopeBaselineDuty`
 * says which, at which revision) and commits the result.
 */

import { isFlagToken } from "./cli-flag-token";
import { isProtectedVerificationPath } from "./completion-suite";
import type { DeclaredArtifactBaseline } from "./artifact-baseline";
import { contractWriter, frozenPaths } from "./acceptance-contract";
import { coupledSetGaps, describeCoupledSetGap } from "./coupled-file-sets";
import { isDistillTask } from "./distill-task";
import type { DomainResult } from "./orchestration-contract";
import { derivePendingTaskProof, redThenGreenScope, taskRedThenGreenEra } from "./proof-obligations";
import { parseReviewPath } from "./review-packet";
import { taskArtifactExpectation } from "./task-artifact-expectation";
import { parseTaskId, type TaskId } from "./task-id";
import { reopenableWave } from "./task-revalidation";
import { renderTaskScopeProblem, taskTestFileProblem } from "./task-scope-rules";
import { taskVerificationPolicy } from "./verification-policy";
import { parsePlanEditReason, taskRescopedEdit } from "./wave-plan-edit";
import type { Task, TaskGraph, TaskRescopedEdit } from "../types";

export const TASK_RESCOPE_USAGE =
  "Usage: helper orchestration rescope-task --task <id> [--add-file <path>]... [--add-sealed-file <path>]... " +
  "[--remove-file <path>]... --reason <text>";

export type TaskRescopeRequest = Readonly<{
  taskId: TaskId;
  /** Every path to add, plain and sealed, in the order named. */
  add: readonly string[];
  /** The paths of `add` named with `--add-sealed-file`: each must be one a completed Wave sealed. */
  sealed: readonly string[];
  remove: readonly string[];
  reason: string;
}>;

export type TaskRescopeRefusal = Readonly<{
  kind:
    | "not-executing"
    | "live-wave-gate"
    | "implementation-active"
    | "unknown-task"
    | "not-pending"
    | "completed-wave"
    | "distill-task"
    | "attested"
    | "path-not-addable"
    | "path-not-removable"
    | "empty-file-list"
    | "unprovable-scope"
    | "contract-writer"
    | "coupled-set-split"
    | "baseline-unobserved";
  message: string;
}>;

/** Added files' bytes as the shell read them, and the commit it read them at. */
export type ObservedBaselines = Readonly<{ revision: string; entries: readonly DeclaredArtifactBaseline[] }>;

/** What the shell must observe before deciding: these paths at this revision. */
export type RescopeBaselineDuty = Readonly<{ revision: string; paths: readonly string[] }>;

type PendingTask = Extract<Task, Readonly<{ status: "pending" }>>;

export type TaskRescope =
  | Readonly<{ kind: "rescoped"; graph: TaskGraph; audit: TaskRescopedEdit }>
  | Readonly<{ kind: "unchanged"; taskId: TaskId }>;

const freeze = Object.freeze;
const refuse = (kind: TaskRescopeRefusal["kind"], message: string): DomainResult<never, TaskRescopeRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });

/**
 * Exactly one `--task`, one non-blank `--reason`, and any number of distinct
 * repository-relative `--add-file`, `--add-sealed-file` and `--remove-file`
 * paths, at least one in all, none named twice or on both sides.
 */
export function parseTaskRescopeArgs(args: readonly string[]): DomainResult<TaskRescopeRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${TASK_RESCOPE_USAGE}` });
  let task: string | undefined;
  let reason: string | undefined;
  const add: string[] = [];
  const sealed: string[] = [];
  const remove: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--task" && flag !== "--reason" && flag !== "--add-file" && flag !== "--add-sealed-file" && flag !== "--remove-file") {
      return fail(`unknown argument '${flag}'`);
    }
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (flag === "--task") {
      if (task !== undefined) return fail("--task is given twice");
      task = value;
    } else if (flag === "--reason") {
      if (reason !== undefined) return fail("--reason is given twice");
      reason = value.trim();
    } else {
      const path = parseReviewPath(value, flag);
      if (!path.ok) return fail(path.errors.join("; "));
      (flag === "--remove-file" ? remove : add).push(path.value);
      if (flag === "--add-sealed-file") sealed.push(path.value);
    }
  }
  if (task === undefined) return fail("--task must name the Task to re-scope");
  const taskId = parseTaskId(task, "--task");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const named = [...add, ...remove];
  if (named.length === 0) return fail("name at least one --add-file, --add-sealed-file or --remove-file");
  const repeated = named.find((path, index) => named.indexOf(path) !== index);
  if (repeated !== undefined) return fail(`${repeated} is named twice`);
  if (reason === undefined) return fail("--reason must say why the plan changes");
  const parsedReason = parsePlanEditReason(reason);
  if (!parsedReason.ok) return fail(`--reason ${parsedReason.error}`);
  return freeze({ ok: true as const, value: freeze({ taskId: taskId.value, add: freeze(add), sealed: freeze(sealed), remove: freeze(remove), reason: parsedReason.value }) });
}

/** The request's additions `task` does not list yet, in request order. */
const newPaths = (task: Task, request: TaskRescopeRequest): readonly string[] =>
  request.add.filter((path) => !(task.file_list ?? []).includes(path));

/**
 * The one rule for where added files' population baseline is read: the
 * Task's `start_sha` when it carries a population baseline and `added` is
 * non-empty; null otherwise, and also when it has a baseline but no
 * `start_sha` (which `rescopeTask` refuses for a request that adds a file).
 * It feeds the shell's read duty, the refusal and the audit alike.
 */
function baselineRevisionFor(task: Task, added: readonly string[]): string | null {
  if (task.artifact_baseline === undefined || added.length === 0) return null;
  return task.start_sha === undefined || task.start_sha === "" ? null : task.start_sha;
}

/**
 * What the shell must read before `rescopeTask` can extend the Task's
 * population baseline: the added paths at `baselineRevisionFor`'s revision.
 * Null when nothing is owed: no such Task, nothing new added, no population
 * baseline, or a baseline with no `start_sha` (which `rescopeTask` refuses
 * when the request adds a file).
 */
export function rescopeBaselineDuty(graph: TaskGraph, request: TaskRescopeRequest): RescopeBaselineDuty | null {
  const task = graph.tasks.find(({ id }) => id === request.taskId);
  if (task === undefined) return null;
  const paths = newPaths(task, request);
  const revision = baselineRevisionFor(task, paths);
  return revision === null ? null : freeze({ revision, paths });
}

/**
 * The removals that name a path the Task does not list and no earlier
 * audited edit of it removed: a typo or a stale path, never a replay.
 */
function unknownRemovals(graph: TaskGraph, task: Task, request: TaskRescopeRequest): readonly string[] {
  const listed = task.file_list ?? [];
  const removedBefore = new Set((graph.wave_plan_edits ?? []).flatMap((edit) =>
    edit.kind === "task-rescoped" && edit.taskId === task.id ? edit.removed : []));
  return request.remove.filter((path) => !listed.includes(path) && !removedBefore.has(path));
}

/**
 * Why `path` cannot join `task`'s scope in `graph`, or null. A path a
 * completed Wave sealed joins only when `namedSealed`, and a path named
 * sealed must be one.
 */
function addRefusal(graph: TaskGraph, task: Task, path: string, completedWaves: ReadonlySet<number>, namedSealed: boolean): string | null {
  if (isProtectedVerificationPath(path)) return `${path} is a protected verification path; no Task lists it`;
  let sealedBy: Task | undefined;
  for (const other of graph.tasks) {
    if (other.id === task.id || !(other.file_list ?? []).includes(path)) continue;
    if (other.wave === task.wave) return `${path} is already ${other.id}'s, in the same Wave`;
    if (completedWaves.has(other.wave)) sealedBy ??= other;
  }
  if (sealedBy !== undefined && !namedSealed) {
    return `${path} belongs to ${sealedBy.id} of completed Wave ${sealedBy.wave}; name it with --add-sealed-file to take sealed code into ${task.id}`;
  }
  if (sealedBy === undefined && namedSealed) return `${path} is not sealed by a completed Wave; add it with --add-file`;
  const frozen = (graph.acceptance_contracts ?? []).find((contract) =>
    contract.contractTask !== task.id && frozenPaths(contract).includes(path));
  return frozen === undefined ? null : `${path} is frozen by ${frozen.id}; only its contract Task ${frozen.contractTask} lists it`;
}

/** Why a listed `path` cannot leave its Task's file list in `graph`, or null. */
function removeRefusal(graph: TaskGraph, path: string): string | null {
  const bound = (graph.export_bindings ?? []).find((binding) => binding.path === path);
  return bound === undefined ? null : `${path} is bound to ${bound.contract} by the plan's export bindings; re-plan the binding first`;
}

/** The precondition refusals shared with Task reopening, in this operation's words. */
function waveRefusal(graph: TaskGraph): DomainResult<never, TaskRescopeRefusal> | null {
  const reopenable = reopenableWave(graph);
  if (reopenable.ok) return null;
  const refusal = reopenable.error;
  switch (refusal.kind) {
    case "not-executing":
      return refuse("not-executing", `re-scoping a Task requires the execute Phase (current: ${refusal.phase})`);
    case "live-wave-gate":
      return refuse("live-wave-gate", `Wave Gate run ${refusal.runId} owns Wave ${refusal.wave}; abandon it with helper orchestration abandon, then retry`);
    case "implementation-active":
      return refuse("implementation-active", `implementation reservations are active: ${refusal.holders.join(", ")}; re-scope once they settle`);
    default: {
      const unreachable: never = refusal;
      return unreachable;
    }
  }
}

/**
 * Why the added files' observed baselines cannot extend `task`'s population
 * baseline, or null when they can (or the Task carries none to extend).
 */
function baselineRefusal(task: PendingTask, added: readonly string[], observed: ObservedBaselines | null): string | null {
  if (task.artifact_baseline === undefined || added.length === 0) return null;
  const revision = baselineRevisionFor(task, added);
  if (revision === null) {
    return `${task.id} carries a population baseline but no start_sha, so its added files cannot be read at its start`;
  }
  if (observed === null || observed.revision !== revision) {
    return `the added files were not read at ${task.id}'s start_sha ${revision}; retry so the shell reads them there`;
  }
  const unread = added.filter((path) => !observed.entries.some(({ artifact }) => artifact === path));
  return unread.length === 0 ? null : `the start_sha baseline of ${unread.join(", ")} was not observed`;
}

/**
 * The Task with its new file list: a Proof re-derived for it, the population
 * baseline extended by `observed` (absent when the Task had none), the attempt
 * baseline cleared, and recorded skeleton outcomes of removed paths dropped.
 */
function rescopedTask(graph: TaskGraph, task: PendingTask, fileList: readonly string[], observed: ObservedBaselines | null): Task {
  const scope = redThenGreenScope(graph.verification_manifest, graph.acceptance_contracts ?? []);
  const baselineOf = new Map([...(task.artifact_baseline ?? []), ...(observed?.entries ?? [])].map((entry) => [entry.artifact, entry] as const));
  const artifactBaseline = task.artifact_baseline === undefined
    ? undefined
    : freeze(fileList.flatMap((path) => {
      const entry = baselineOf.get(path);
      return entry === undefined ? [] : [entry];
    }));
  const { attempt_artifact_baseline: _staleAttemptBaseline, ...rest } = task;
  return freeze({
    ...rest,
    file_list: freeze(fileList),
    ...(artifactBaseline === undefined ? {} : { artifact_baseline: artifactBaseline }),
    ...(task.skeleton_outcomes === undefined
      ? {}
      : { skeleton_outcomes: freeze(task.skeleton_outcomes.filter(({ path }) => fileList.includes(path))) }),
    proof: derivePendingTaskProof({
      verificationPolicy: taskVerificationPolicy(task),
      declaredArtifacts: fileList,
      declaredArtifactExpectation: taskArtifactExpectation(task),
      redThenGreen: taskRedThenGreenEra(scope, task.id),
    }),
  });
}

/**
 * Re-scope one pending Task. `observed` are the added files as the shell read
 * them at the revision `rescopeBaselineDuty` named; they must be read at the
 * Task's `start_sha` and cover every added path when the Task carries a
 * population baseline. Idempotent: a request whose additions are all present
 * and whose removals are all absent changes nothing.
 */
export function rescopeTask(
  graph: TaskGraph,
  request: TaskRescopeRequest,
  observed: ObservedBaselines | null,
): DomainResult<TaskRescope, TaskRescopeRefusal> {
  const blocked = waveRefusal(graph);
  if (blocked !== null) return blocked;
  const task = graph.tasks.find(({ id }) => id === request.taskId);
  if (task === undefined) return refuse("unknown-task", `${request.taskId} is not in the TaskGraph`);
  const unknown = unknownRemovals(graph, task, request);
  if (unknown.length > 0) return refuse("path-not-removable", `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not in ${task.id}'s file_list`);
  const current = task.file_list ?? [];
  const added = newPaths(task, request);
  const removed = current.filter((path) => request.remove.includes(path));
  if (added.length === 0 && removed.length === 0) {
    return freeze({ ok: true as const, value: freeze({ kind: "unchanged" as const, taskId: request.taskId }) });
  }
  if (task.status !== "pending") return refuse("not-pending", `${task.id} is ${task.status}; only a pending Task is re-scoped (reopen it first)`);
  const completedWaves = new Set((graph.wave_gate_history ?? []).map(({ wave }) => wave));
  if (completedWaves.has(task.wave) || task.wave < (graph.current_wave ?? task.wave)) {
    return refuse("completed-wave", `${task.id} is in completed Wave ${task.wave}; change sealed code with a Forward Fix`);
  }
  if (isDistillTask(task)) return refuse("distill-task", `${task.id} is a Distill Task; the engine derives its scope`);
  if (task.implementation_attestation === true) return refuse("attested", `${task.id} is armed for attestation; a re-scoped Task needs a fresh implementation, not an attestation`);
  for (const path of added) {
    const refusal = addRefusal(graph, task, path, completedWaves, request.sealed.includes(path));
    if (refusal !== null) return refuse("path-not-addable", refusal);
  }
  for (const path of removed) {
    const refusal = removeRefusal(graph, path);
    if (refusal !== null) return refuse("path-not-removable", refusal);
  }
  const fileList = [...current.filter((path) => !removed.includes(path)), ...added];
  if (fileList.length === 0) return refuse("empty-file-list", `${task.id} would list no file`);
  const scopeProblem = taskTestFileProblem(
    { id: task.id, fileList, policy: taskVerificationPolicy(task) },
    { manifest: graph.verification_manifest, contracts: graph.acceptance_contracts ?? [] },
  );
  if (scopeProblem !== null) return refuse("unprovable-scope", renderTaskScopeProblem(scopeProblem));
  const unobserved = baselineRefusal(task, added, observed);
  if (unobserved !== null) return refuse("baseline-unobserved", unobserved);
  const tasks = graph.tasks.map((candidate) => (candidate.id === task.id ? rescopedTask(graph, task, fileList, observed) : candidate));
  const gap = coupledSetGaps(tasks, { id: task.id, file_list: fileList })[0];
  if (gap !== undefined) return refuse("coupled-set-split", `${describeCoupledSetGap(gap)}; add the rest in the same re-scope`);
  for (const contract of graph.acceptance_contracts ?? []) {
    const writer = contractWriter(frozenPaths(contract), tasks.map(({ id, file_list }) => ({ id, file_list: file_list ?? [] })));
    if (!writer.ok || writer.value !== contract.contractTask) {
      return refuse("contract-writer", `${contract.id}'s frozen paths must stay with its contract Task ${contract.contractTask}`);
    }
  }
  const audit = taskRescopedEdit({
    wave: task.wave, taskId: task.id, added, removed, baselineRevision: baselineRevisionFor(task, added),
    sealed: added.filter((path) => request.sealed.includes(path)), reason: request.reason,
  });
  // Every input was proven above (parsed paths, a change, the reason); a refusal here is a broken invariant.
  if (!audit.ok) throw new Error(`rescope-task built an invalid audit: ${audit.error}`);
  return freeze({
    ok: true as const,
    value: freeze({
      kind: "rescoped" as const,
      graph: freeze({ ...graph, tasks: freeze(tasks), wave_plan_edits: freeze([...(graph.wave_plan_edits ?? []), audit.value]) }),
      audit: audit.value,
    }),
  });
}
