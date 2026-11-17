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
 * path another Task of its Wave lists, takes no path a completed Wave sealed
 * (that is a Forward Fix), no protected verification path, no frozen
 * Acceptance Contract path it does not write, never drops a path an export
 * binding names, and still declares a test file when it owes I6. Its Proof is
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
import { isDistillTask } from "./distill-task";
import type { DomainResult } from "./orchestration-contract";
import { derivePendingTaskProof, redThenGreenScope, taskRedThenGreenEra } from "./proof-obligations";
import { parseReviewPath } from "./review-packet";
import { taskArtifactExpectation } from "./task-artifact-expectation";
import { parseTaskId, type TaskId } from "./task-id";
import { reopenableWave } from "./task-revalidation";
import { renderTaskScopeProblem, taskTestFileProblem } from "./task-scope-rules";
import { taskVerificationPolicy } from "./verification-policy";
import type { Task, TaskGraph, TaskRescopedEdit } from "../types";

export const MAX_RESCOPE_REASON_LENGTH = 500;

export const TASK_RESCOPE_USAGE =
  "Usage: helper orchestration rescope-task --task <id> [--add-file <path>]... [--remove-file <path>]... --reason <text>";

export type TaskRescopeRequest = Readonly<{
  taskId: TaskId;
  add: readonly string[];
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
 * repository-relative `--add-file` and `--remove-file` paths, at least one in
 * all, none named twice or on both sides.
 */
export function parseTaskRescopeArgs(args: readonly string[]): DomainResult<TaskRescopeRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${TASK_RESCOPE_USAGE}` });
  let task: string | undefined;
  let reason: string | undefined;
  const add: string[] = [];
  const remove: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--task" && flag !== "--reason" && flag !== "--add-file" && flag !== "--remove-file") return fail(`unknown argument '${flag}'`);
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
      (flag === "--add-file" ? add : remove).push(path.value);
    }
  }
  if (task === undefined) return fail("--task must name the Task to re-scope");
  const taskId = parseTaskId(task, "--task");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const named = [...add, ...remove];
  if (named.length === 0) return fail("name at least one --add-file or --remove-file");
  const repeated = named.find((path, index) => named.indexOf(path) !== index);
  if (repeated !== undefined) return fail(`${repeated} is named twice`);
  if (reason === undefined || reason.length === 0) return fail("--reason must say why the Task's scope changes");
  if (reason.length > MAX_RESCOPE_REASON_LENGTH) return fail(`--reason is at most ${MAX_RESCOPE_REASON_LENGTH} characters`);
  return freeze({ ok: true as const, value: freeze({ taskId: taskId.value, add: freeze(add), remove: freeze(remove), reason }) });
}

/** The request's additions `task` does not list yet, in request order. */
const newPaths = (task: Task, request: TaskRescopeRequest): readonly string[] =>
  request.add.filter((path) => !(task.file_list ?? []).includes(path));

/**
 * What the shell must read before `rescopeTask` can extend the Task's
 * population baseline: the added paths at its `start_sha`. Null when nothing
 * is owed (no such Task, nothing new added, or no population baseline); a
 * Task with a baseline but no `start_sha` is refused by `rescopeTask` itself.
 */
export function rescopeBaselineDuty(graph: TaskGraph, request: TaskRescopeRequest): RescopeBaselineDuty | null {
  const task = graph.tasks.find(({ id }) => id === request.taskId);
  if (task === undefined || task.artifact_baseline === undefined || task.start_sha === undefined || task.start_sha === "") return null;
  const paths = newPaths(task, request);
  return paths.length === 0 ? null : freeze({ revision: task.start_sha, paths });
}

/** Why `path` cannot join `task`'s scope in `graph`, or null. */
function addRefusal(graph: TaskGraph, task: Task, path: string, completedWaves: ReadonlySet<number>): string | null {
  if (isProtectedVerificationPath(path)) return `${path} is a protected verification path; no Task lists it`;
  for (const other of graph.tasks) {
    if (other.id === task.id || !(other.file_list ?? []).includes(path)) continue;
    if (completedWaves.has(other.wave)) {
      return `${path} belongs to ${other.id} of completed Wave ${other.wave}; change sealed code with a Forward Fix (helper orchestration add-forward-fix)`;
    }
    if (other.wave === task.wave) return `${path} is already ${other.id}'s, in the same Wave`;
  }
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
  if (task.start_sha === undefined || task.start_sha === "") {
    return `${task.id} carries a population baseline but no start_sha, so its added files cannot be read at its start`;
  }
  if (observed === null || observed.revision !== task.start_sha) {
    return `the added files were not read at ${task.id}'s start_sha ${task.start_sha}; retry so the shell reads them there`;
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
    file_list: freeze([...fileList]),
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
    const refusal = addRefusal(graph, task, path, completedWaves);
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
  for (const contract of graph.acceptance_contracts ?? []) {
    const writer = contractWriter(frozenPaths(contract), tasks.map(({ id, file_list }) => ({ id, file_list: file_list ?? [] })));
    if (!writer.ok || writer.value !== contract.contractTask) {
      return refuse("contract-writer", `${contract.id}'s frozen paths must stay with its contract Task ${contract.contractTask}`);
    }
  }
  const audit: TaskRescopedEdit = freeze({
    schemaVersion: 1,
    kind: "task-rescoped",
    wave: task.wave,
    taskId: task.id,
    added: freeze([...added]),
    removed: freeze(removed),
    baselineRevision: task.artifact_baseline === undefined || added.length === 0 ? null : (task.start_sha ?? null),
    reason: request.reason,
  });
  return freeze({
    ok: true as const,
    value: freeze({
      kind: "rescoped" as const,
      graph: freeze({ ...graph, tasks: freeze(tasks), wave_plan_edits: freeze([...(graph.wave_plan_edits ?? []), audit]) }),
      audit,
    }),
  });
}
