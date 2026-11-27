/**
 * Adding a Task to the active Wave, and withdrawing one never dispatched
 * (ADR-0086, loom#199 Cause 2): `helper orchestration add-task` and
 * `withdraw-task`.
 *
 * A Wave's plan sometimes needs a Task decompose did not foresee: a judgement
 * failed on code a completed Wave sealed, or a fix spans files no single Task
 * owns. `addTask` appends one pending Task to the active Wave. Its order
 * against the Wave's other Tasks is ordinary `depends_on` data: the Tasks it
 * waits for (`--depends-on`) and the pending Tasks that now wait for it
 * (`--before`), satisfied once a Task settles its implementation
 * (`dispatch-holds.ts`). A cycle is refused at write time. A path a
 * completed Wave sealed joins only when named with `--sealed-file`; every
 * other path follows `rescope-task`'s admission rule (`pathAdmissionRefusal`).
 *
 * This replaces the Forward Fix (ADR-0077), which needed a held Task whose
 * attempt had already failed, at least one sealed path, and a hold rule of
 * its own beside dependencies. An older State File's Forward Fix audits are
 * still read: each held Task waits for its fix Task as a same-Wave dependency.
 *
 * Completed Waves stay untouched as history: the new Task is reviewed by the
 * active Wave's gate like every other Task of the Wave. Its Distill Scope
 * stays as population froze it (ADR-0068). Both operations share the
 * Wave-reopening precondition (`reopenableWave`) with Task Reopening.
 *
 * Pure: the shell supplies the locked graph and proves quiescence.
 */

import { isFlagToken } from "./cli-flag-token";
import { coupledSetGaps, describeCoupledSetGap } from "./coupled-file-sets";
import { isDistillTask } from "./distill-task";
import type { DomainResult } from "./orchestration-contract";
import { redThenGreenScope, taskRedThenGreenEra } from "./proof-obligations";
import { parseReviewPath } from "./review-packet";
import { waitRelation } from "./dispatch-holds";
import { cycleClosedBy } from "./task-dependencies";
import { isUntouchedJoinedTask, pendingAuthoredTask } from "./task-graph-population";
import { parseTaskId, TASK_ID_PATTERN, type TaskId } from "./task-id";
import { pathAdmissionRefusal } from "./task-rescope";
import { reopenableWave, waveReopeningRefusalMessage, type ReopenableWave, type WaveReopeningRefusal } from "./task-revalidation";
import { renderTaskScopeProblem, taskTestFileProblem } from "./task-scope-rules";
import { serializeVerificationPolicy, type VerificationPolicy } from "./verification-policy";
import { newWaveGate, reconcileWaveBlock } from "./wave-gate-model";
import { retireUnownedWaveReviewAuthority } from "./wave-gate-registration";
import { parsePlanEditReason, taskAddedEdit, taskWithdrawnEdit } from "./wave-plan-edit";
import type { ForwardFixWithdrawal, Task, TaskAddedEdit, TaskGraph, TaskWithdrawnEdit } from "../types";

/** The implementation agents an added Task may be dispatched to. */
export const ADDED_TASK_AGENTS = Object.freeze(["code-implementer-agent", "frontend-agent", "security-agent"] as const);
export type AddedTaskAgent = (typeof ADDED_TASK_AGENTS)[number];

/** Whether the Task owes new tests, or existing tests are its proof. */
export type AddedTaskNewTests = "required" | "existing-tests-sufficient";

export type AddTaskRequest = Readonly<{
  /** The Task's file_list, distinct, in the order named (plain and sealed together). */
  files: readonly string[];
  /** The files named with `--sealed-file`, in the order named; a subset of `files`. */
  sealed: readonly string[];
  /** The Tasks it waits for, distinct, in the order named. */
  dependsOn: readonly TaskId[];
  /** The pending Tasks of the Wave that will wait for it, distinct, in the order named. */
  dependents: readonly TaskId[];
  agent: AddedTaskAgent;
  description: string;
  reason: string;
  newTests: AddedTaskNewTests;
}>;

/** One refusal of kind `K`, with the message the operator reads. */
export type Refusal<K extends string> = Readonly<{ kind: K; message: string }>;

/** The refusals of the active, open Wave both operations change: the shared Wave-reopening precondition, then this Wave's. */
export type OpenWaveRefusalKind = WaveReopeningRefusal["kind"] | "wave-completed" | "successor-named";

export type AddTaskRefusal = Refusal<
  | OpenWaveRefusalKind
  | "unknown-task"
  | "illegal-dependency"
  | "illegal-dependent"
  | "cycle"
  | "path-not-addable"
  | "unprovable-scope"
  | "coupled-set-split"
  /** The request breaks an invariant its parser proves (a request built by hand): refused, never thrown. */
  | "invalid-request"
>;

export type AddTask =
  /** The Task was appended: persist `graph`, which appends `edit`. */
  | Readonly<{ kind: "added"; graph: TaskGraph; edit: TaskAddedEdit; task: Task }>
  /** This exact Task was already added and has not been dispatched: nothing to write. */
  | Readonly<{ kind: "already-added"; edit: TaskAddedEdit }>;

export const ADD_TASK_USAGE =
  "Usage: helper orchestration add-task --file <path> [--file <path>]... [--sealed-file <path>]... " +
  "[--depends-on <task-id>]... [--before <task-id>]... --description \"<what the Task changes>\" --reason \"<why the plan changes>\" " +
  "[--agent code-implementer-agent|frontend-agent|security-agent] [--new-tests required|existing-tests-sufficient]";

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const okWith = <T>(value: T): DomainResult<T, never> => freeze({ ok: true as const, value });
const failWith = <E>(error: E): DomainResult<never, E> => freeze({ ok: false as const, error });
const refuse = <K extends string>(kind: K, message: string): DomainResult<never, Refusal<K>> =>
  failWith(freeze({ kind, message }));
const MAX_DESCRIPTION_LENGTH = 512;

const isAddedTaskAgent = (value: string): value is AddedTaskAgent =>
  (ADDED_TASK_AGENTS as readonly string[]).includes(value);

/**
 * `value` if the added Task's brief can carry it, or why not. The text lands
 * in the Task's description or plan context, which the brief carries: a line
 * break would break its one-line field, a `LOOM_` token could pass for engine
 * authority, and a `Task ID:` could rebind the brief. A `{word}` is fine: the
 * brief is engine-rendered, so the spawn gates never read protected text as a
 * template variable. A refused text never reaches protected state, where it
 * could not be corrected.
 */
function briefSafeText(value: string, flag: string): DomainResult<string, string> {
  if (/[\r\n]/.test(value)) return failWith(`${flag} must be one line`);
  if (/\bLOOM_[A-Z_]+/.test(value)) return failWith(`${flag} may not carry a LOOM_ token`);
  return /task id:/i.test(value) ? failWith(`${flag} may not carry a Task ID binding`) : okWith(value);
}

/** Collected flag values before they are parsed into a request. */
type AddTaskFlags = {
  description?: string;
  reason?: string;
  agent?: string;
  newTests?: string;
  files: Array<Readonly<{ raw: string; sealed: boolean }>>;
  dependsOn: string[];
  dependents: string[];
};

const SINGLE: Readonly<Record<string, "description" | "reason" | "agent" | "newTests">> = {
  "--description": "description",
  "--reason": "reason",
  "--agent": "agent",
  "--new-tests": "newTests",
};

function collectFlags(args: readonly string[]): DomainResult<AddTaskFlags, string> {
  const flags: AddTaskFlags = { files: [], dependsOn: [], dependents: [] };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const value = args[index + 1];
    // Own properties only: a flag spelled like an inherited Object member is unknown, not a key.
    const key = Object.hasOwn(SINGLE, flag) ? SINGLE[flag] : undefined;
    const repeatable = flag === "--file" || flag === "--sealed-file" || flag === "--depends-on" || flag === "--before";
    if (!repeatable && key === undefined) return failWith(`unknown argument '${flag}'`);
    if (value === undefined || isFlagToken(value)) return failWith(`${flag} needs a value`);
    if (flag === "--file" || flag === "--sealed-file") flags.files.push({ raw: value, sealed: flag === "--sealed-file" });
    else if (flag === "--depends-on") flags.dependsOn.push(value);
    else if (flag === "--before") flags.dependents.push(value);
    else if (key !== undefined) {
      if (flags[key] !== undefined) return failWith(`${flag} is given twice`);
      flags[key] = value.trim();
    }
  }
  return okWith(flags);
}

/** Distinct Task ids from `raw`, or the first invalid or repeated one. */
function distinctTaskIds(raw: readonly string[], flag: string): DomainResult<readonly TaskId[], string> {
  const ids: TaskId[] = [];
  for (const entry of raw) {
    const id = parseTaskId(entry, flag);
    if (!id.ok) return failWith(id.error.errors.join("; "));
    if (ids.includes(id.value)) return failWith(`${flag} ${id.value} is given twice`);
    ids.push(id.value);
  }
  return okWith(freeze(ids));
}

/**
 * At least one distinct `--file` or `--sealed-file` path; distinct
 * `--depends-on` and `--before` Task ids, none on both sides; exactly one
 * `--description` (at most 512 characters) and `--reason` (a plan-edit
 * reason), both one line the brief can carry; at most one `--agent` (default
 * `code-implementer-agent`) and `--new-tests` (default `required`). A value
 * that is itself a flag is refused.
 */
export function parseAddTaskArgs(args: readonly string[]): DomainResult<AddTaskRequest, string> {
  const fail = (problem: string) => failWith(`${problem}. ${ADD_TASK_USAGE}`);
  const collected = collectFlags(args);
  if (!collected.ok) return fail(collected.error);
  const flags = collected.value;
  const files: string[] = [];
  const sealed: string[] = [];
  for (const { raw, sealed: isSealed } of flags.files) {
    const path = parseReviewPath(raw, isSealed ? "--sealed-file" : "--file");
    if (!path.ok) return fail(path.errors.join("; "));
    if (files.includes(path.value)) return fail(`${path.value} is named twice`);
    files.push(path.value);
    if (isSealed) sealed.push(path.value);
  }
  if (files.length === 0) return fail("name at least one --file or --sealed-file");
  const dependsOn = distinctTaskIds(flags.dependsOn, "--depends-on");
  if (!dependsOn.ok) return fail(dependsOn.error);
  const dependents = distinctTaskIds(flags.dependents, "--before");
  if (!dependents.ok) return fail(dependents.error);
  const both = dependsOn.value.find((id) => dependents.value.includes(id));
  if (both !== undefined) return fail(`${both} is named with both --depends-on and --before, a cycle`);
  if (flags.description === undefined || flags.description.length === 0) return fail("--description must say what the Task changes");
  if (flags.description.length > MAX_DESCRIPTION_LENGTH) return fail(`--description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  const description = briefSafeText(flags.description, "--description");
  if (!description.ok) return fail(description.error);
  if (flags.reason === undefined) return fail("--reason must say why the plan changes");
  const parsedReason = parsePlanEditReason(flags.reason);
  if (!parsedReason.ok) return fail(`--reason ${parsedReason.error}`);
  const reason = briefSafeText(parsedReason.value, "--reason");
  if (!reason.ok) return fail(reason.error);
  const agent = flags.agent ?? "code-implementer-agent";
  if (!isAddedTaskAgent(agent)) return fail(`--agent must be one of ${ADDED_TASK_AGENTS.join(", ")}`);
  const newTests = flags.newTests ?? "required";
  if (newTests !== "required" && newTests !== "existing-tests-sufficient") {
    return fail("--new-tests must be required or existing-tests-sufficient");
  }
  return okWith(freeze({
    files: freeze(files),
    sealed: freeze(sealed),
    dependsOn: dependsOn.value,
    dependents: dependents.value,
    agent,
    description: description.value,
    reason: reason.value,
    newTests,
  }));
}

/** The Waves whose gate has completed. */
const completedWaves = (graph: TaskGraph): ReadonlySet<number> =>
  new Set((graph.wave_gate_history ?? []).map(({ wave }) => wave));

/**
 * The active, open Wave whose roster changes, or the exact refusal: the
 * shared Wave-reopening precondition, then that Wave not completed and not
 * under an abandoned run that names a successor (changing the roster would
 * orphan that successor's authority).
 */
function openWave(graph: TaskGraph, operation: string): DomainResult<ReopenableWave, Refusal<OpenWaveRefusalKind>> {
  const reopenable = reopenableWave(graph);
  if (!reopenable.ok) return refuse(reopenable.error.kind, waveReopeningRefusalMessage(reopenable.error, operation, "retry"));
  const { wave, abandonedRunId } = reopenable.value;
  if (completedWaves(graph).has(wave)) {
    return refuse("wave-completed", `Wave ${wave} has completed; ${operation} changes only the active, open Wave`);
  }
  const outcome = graph.active_wave_gate?.terminalOutcome;
  if (outcome?.kind === "terminal-abandoned" && outcome.supersededBy !== null) {
    return refuse("successor-named", `abandoned Wave Gate run ${abandonedRunId} names successor ` +
      `${outcome.supersededBy}; changing the Wave's Tasks would orphan that successor's authority, so start it ` +
      "(or abandon it naming no successor) first");
  }
  return reopenable;
}

/**
 * The Wave Gates once `wave`'s roster became `tasks`: its review and test bits
 * reset, implementation complete exactly when every Task of the Wave is, and
 * its block re-derived.
 */
function resetWaveGates(retired: TaskGraph, wave: number, tasks: readonly Task[]): TaskGraph["wave_gates"] {
  const existing = retired.wave_gates[String(wave)] ?? newWaveGate();
  const gate = {
    ...existing,
    impl_complete: tasks.filter((task) => task.wave === wave).every(({ status }) => status === "implemented" || status === "completed"),
    tests_passed: null,
    reviews_complete: false,
  };
  return reconcileWaveBlock({ ...retired.wave_gates, [String(wave)]: gate }, tasks, retired.spec_check, wave);
}

/** Every Task id the run ever withdrew: by `withdraw-task`, or by the retired withdraw-forward-fix. */
const withdrawnTaskIds = (graph: TaskGraph): readonly string[] => [
  ...(graph.wave_plan_edits ?? []).flatMap((edit) => (edit.kind === "task-withdrawn" ? [edit.taskId] : [])),
  ...(graph.forward_fix_withdrawals ?? []).map(({ audit }) => audit.fixTaskId),
];

/** The next free Task id after every id of the roster and every withdrawn one, so a withdrawn id is never minted again. */
function nextTaskId(graph: TaskGraph): TaskId {
  const ids = [...graph.tasks.map(({ id }) => id), ...withdrawnTaskIds(graph)];
  const highest = Math.max(0, ...ids.map((id) => TASK_ID_PATTERN.test(id) ? Number(id.slice(1)) : 0));
  const minted = parseTaskId(`T${highest + 1}`);
  if (!minted.ok) throw new Error(`unreachable: T${highest + 1} is not a Task id`);
  return minted.value;
}

/** The plan context an added Task's brief carries, from the request alone. */
export function addedTaskPlanContext(request: AddTaskRequest, wave: number): string {
  return [
    `Added to Wave ${wave} by the operator: ${request.reason}`,
    ...(request.sealed.length === 0 ? [] : [`Sealed paths (written by a completed Wave): ${request.sealed.join(", ")}.`]),
    ...(request.dependents.length === 0
      ? []
      : [`${request.dependents.join(", ")} wait${request.dependents.length === 1 ? "s" : ""} for this Task and run after it settles.`]),
    "Never weaken, skip or loosen a test another Task owns, or any budget it enforces.",
  ].join("\n");
}

/** The verification policy an added Task carries: regression always required, new tests as the request says. */
const addedTaskPolicy = (request: AddTaskRequest): VerificationPolicy => ({
  regression: { kind: "required" },
  newTests: request.newTests === "required" ? { kind: "required" } : { kind: "waived", reason: "existing-tests-sufficient" },
});

/**
 * The Task's pending record, written by population's own builder: the
 * request's dependencies, no Requirement trace, and the request's policy. Its
 * I6 era is the graph's.
 */
function addedTaskOf(graph: TaskGraph, request: AddTaskRequest, taskId: TaskId, wave: number): Task {
  const scope = redThenGreenScope(graph.verification_manifest, graph.acceptance_contracts ?? []);
  return pendingAuthoredTask(
    {
      id: taskId,
      description: request.description,
      agent: request.agent,
      wave,
      depends_on: request.dependsOn,
      plan_context: addedTaskPlanContext(request, wave),
      verification_policy: serializeVerificationPolicy(addedTaskPolicy(request)),
      file_list: request.files,
    },
    taskRedThenGreenEra(scope, taskId),
  );
}

/** Two lists with the same entries in the same order. */
const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

/**
 * The committed edit this request replays: a `task-added` edit, the latest
 * or an earlier one, that the request describes exactly, whose Task is still on the
 * roster exactly as it joined. A retry that arrives after a later edit is
 * still a replay, even one that gave the Task an incoming edge: the recorded
 * edit, not the Task's current `depends_on`, is what the request is compared to.
 */
function replayedEdit(graph: TaskGraph, request: AddTaskRequest): TaskAddedEdit | undefined {
  return (graph.wave_plan_edits ?? []).flatMap((edit) => (edit.kind === "task-added" ? [edit] : [])).find((edit) => {
    const task = graph.tasks.find(({ id }) => id === edit.taskId);
    return task !== undefined && isUntouchedJoinedTask(task) && edit.reason === request.reason &&
      sameList(edit.files, request.files) && sameList(edit.sealed ?? [], request.sealed) &&
      sameList(edit.dependsOn, request.dependsOn) && sameList(edit.dependents, request.dependents) &&
      task.description === request.description && task.agent === request.agent;
  });
}

/** The first dependency the new Task may not wait for, or null: unknown, in a later Wave, or a Distill Task. */
function dependencyRefusal(graph: TaskGraph, request: AddTaskRequest, wave: number): DomainResult<never, AddTaskRefusal> | null {
  for (const id of request.dependsOn) {
    const dependency = graph.tasks.find((task) => task.id === id);
    if (dependency === undefined) return refuse("unknown-task", `--depends-on ${id} is not in the TaskGraph`);
    if (dependency.wave > wave) {
      return refuse("illegal-dependency", `${id} is in later Wave ${dependency.wave}; the new Task can wait only for its own Wave or an earlier one`);
    }
    if (isDistillTask(dependency)) return refuse("illegal-dependency", `${id} is a Distill Task; it runs after every other Task of its Wave`);
  }
  return null;
}

/** The first Task that may not wait for the new Task, or null: it must be a pending, authored, unattested Task of the Wave. */
function dependentRefusal(graph: TaskGraph, request: AddTaskRequest, wave: number): DomainResult<never, AddTaskRefusal> | null {
  for (const id of request.dependents) {
    const dependent = graph.tasks.find((task) => task.id === id);
    if (dependent === undefined) return refuse("unknown-task", `--before ${id} is not in the TaskGraph`);
    if (dependent.wave !== wave) return refuse("illegal-dependent", `${id} is in Wave ${dependent.wave}, not the active Wave ${wave}`);
    if (dependent.status !== "pending") {
      return refuse("illegal-dependent", `${id} is ${dependent.status}; only a pending Task can wait for the new Task (reopen it first)`);
    }
    if (isDistillTask(dependent)) return refuse("illegal-dependent", `${id} is a Distill Task; the engine orders it after every other Task of its Wave`);
    if (dependent.implementation_attestation === true) {
      return refuse("illegal-dependent", `${id} is armed for attestation; its implementation is already judged`);
    }
  }
  return null;
}

/** The first path the new Task may not list, or null (`pathAdmissionRefusal`, shared with `rescope-task`). */
function pathRefusal(graph: TaskGraph, request: AddTaskRequest, owner: Readonly<{ id: string; wave: number }>): DomainResult<never, AddTaskRefusal> | null {
  for (const path of request.files) {
    const refusal = pathAdmissionRefusal(graph, owner, path, request.sealed.includes(path),
      { plain: "--file", sealed: "--sealed-file" });
    if (refusal !== null) return refuse("path-not-addable", refusal);
  }
  return null;
}

/**
 * Append a Task to the active Wave, or refuse with the exact precondition that
 * failed: the shared Wave-reopening precondition and the open Wave, the
 * dependencies and dependents, the paths, a test file when the Task owes I6,
 * the coupled file sets, and no dependency cycle. Replaying a committed
 * addition whose Task was never dispatched changes nothing.
 */
export function addTask(graph: TaskGraph, request: AddTaskRequest): DomainResult<AddTask, AddTaskRefusal> {
  const replay = replayedEdit(graph, request);
  if (replay !== undefined) return okWith(freeze({ kind: "already-added" as const, edit: replay }));
  const open = openWave(graph, "adding a Task");
  if (!open.ok) return open;
  const { wave, abandonedRunId } = open.value;
  const taskId = nextTaskId(graph);
  const edit = taskAddedEdit({
    wave, taskId, files: request.files, sealed: request.sealed, dependsOn: request.dependsOn,
    dependents: request.dependents, reason: request.reason, abandonedRunId,
  });
  if (!edit.ok) return refuse("invalid-request", edit.error);
  const refusal = dependencyRefusal(graph, request, wave) ?? dependentRefusal(graph, request, wave) ??
    pathRefusal(graph, request, { id: taskId, wave });
  if (refusal !== null) return refusal;
  const scopeProblem = taskTestFileProblem(
    { id: taskId, fileList: request.files, policy: addedTaskPolicy(request) },
    { manifest: graph.verification_manifest, contracts: graph.acceptance_contracts ?? [] },
  );
  if (scopeProblem !== null) return refuse("unprovable-scope", renderTaskScopeProblem(scopeProblem));
  // A Task that takes part of a coupled file set takes all of it (ADR-0082).
  const gap = coupledSetGaps(graph.tasks, { id: taskId, file_list: request.files })[0];
  if (gap !== undefined) return refuse("coupled-set-split", `${describeCoupledSetGap(gap)}; name every member`);

  const retired = retireUnownedWaveReviewAuthority(graph, wave, abandonedRunId);
  const task = addedTaskOf(retired, request, taskId, wave);
  let tasks: readonly Task[] = [...retired.tasks, task];
  for (const id of request.dependents) {
    // The wait relation includes legacy Forward Fix holds, which dispatch enforces too.
    const cycle = cycleClosedBy(waitRelation({ tasks, forward_fix_history: retired.forward_fix_history }), id, taskId);
    if (cycle !== null) return refuse("cycle", `${id} → ${taskId} would close the dependency cycle ${cycle.join(" → ")}`);
    tasks = tasks.map((candidate) =>
      candidate.id === id ? freeze({ ...candidate, depends_on: freeze([...candidate.depends_on, taskId]) }) : candidate);
  }
  const roster = Object.freeze(tasks);
  return okWith(freeze({
    kind: "added" as const,
    task,
    edit: edit.value,
    graph: freeze({
      ...retired,
      tasks: roster,
      wave_gates: resetWaveGates(retired, wave, roster),
      wave_plan_edits: Object.freeze([...(graph.wave_plan_edits ?? []), edit.value]),
    }),
  }));
}

// ---------------------------------------------------------------------------
// Withdrawing an added Task that was never dispatched
// ---------------------------------------------------------------------------

export type WithdrawTaskRequest = Readonly<{ taskId: TaskId; reason: string }>;

/** What a withdrawal recorded: a `task-withdrawn` edit, or, for a legacy Forward Fix Task, its moved audit. */
export type WithdrawalRecord =
  | Readonly<{ kind: "task-withdrawn"; edit: TaskWithdrawnEdit }>
  | Readonly<{ kind: "forward-fix-withdrawn"; withdrawal: ForwardFixWithdrawal }>;

export type WithdrawTask =
  /** The Task left the roster with every edge to it; `released` are the Tasks that waited for it. Persist `graph`. */
  | Readonly<{ kind: "withdrawn"; graph: TaskGraph; wave: number; taskId: string; released: readonly string[]; record: WithdrawalRecord }>
  /** This exact withdrawal already committed: nothing to write. */
  | Readonly<{ kind: "already-withdrawn"; wave: number; taskId: string }>;

export type WithdrawTaskRefusal = Refusal<
  | OpenWaveRefusalKind
  /** The named Task is no Task `add-task` (or the retired Forward Fix) appended to the active Wave. */
  | "not-an-added-task"
  /** The Task was already dispatched, so it has evidence to settle instead. */
  | "already-dispatched"
  /** The request breaks an invariant its parser proves (a request built by hand): refused, never thrown. */
  | "invalid-request"
>;

export const WITHDRAW_TASK_USAGE = "Usage: helper orchestration withdraw-task --task <task-id> --reason \"<why the Task is withdrawn>\"";

/** Exactly one `--task` and one `--reason`, in any order. */
export function parseWithdrawTaskArgs(args: readonly string[]): DomainResult<WithdrawTaskRequest, string> {
  const fail = (problem: string) => failWith(`${problem}. ${WITHDRAW_TASK_USAGE}`);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const value = args[index + 1];
    if (flag !== "--task" && flag !== "--reason") return fail(`unknown argument '${flag}'`);
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (values.has(flag)) return fail(`${flag} is given twice`);
    values.set(flag, value.trim());
  }
  const taskId = parseTaskId(values.get("--task"), "--task");
  if (!taskId.ok) return fail(taskId.error.errors.join("; "));
  const reason = values.get("--reason");
  if (reason === undefined) return fail("--reason must say why the Task is withdrawn");
  const parsedReason = parsePlanEditReason(reason);
  return parsedReason.ok
    ? okWith(freeze({ taskId: taskId.value, reason: parsedReason.value }))
    : fail(`--reason ${parsedReason.error}`);
}

/**
 * The committed withdrawal this request replays, as its Wave: the Task is off
 * the roster and a `task-withdrawn` edit (or a legacy Forward Fix withdrawal)
 * names it with the same reason.
 */
function replayedWithdrawal(graph: TaskGraph, request: WithdrawTaskRequest): number | undefined {
  if (graph.tasks.some(({ id }) => id === request.taskId)) return undefined;
  const edit = (graph.wave_plan_edits ?? []).find((candidate) =>
    candidate.kind === "task-withdrawn" && candidate.taskId === request.taskId && candidate.reason === request.reason);
  const legacy = (graph.forward_fix_withdrawals ?? []).find(({ audit, reason }) =>
    audit.fixTaskId === request.taskId && reason === request.reason);
  return edit?.wave ?? legacy?.audit.wave;
}

/** The roster without `taskId` and every edge to it, and the Tasks whose edge was dropped. */
function rosterWithout(tasks: readonly Task[], taskId: string): Readonly<{ tasks: readonly Task[]; released: readonly string[] }> {
  const released: string[] = [];
  const remaining = tasks.flatMap((candidate) => {
    if (candidate.id === taskId) return [];
    if (!candidate.depends_on.includes(taskId)) return [candidate];
    released.push(candidate.id);
    return [freeze({ ...candidate, depends_on: freeze(candidate.depends_on.filter((id) => id !== taskId)) })];
  });
  return freeze({ tasks: Object.freeze(remaining), released: Object.freeze(released) });
}

/**
 * Withdraw a Task appended to the active Wave after population and never
 * dispatched, or refuse with the exact precondition that failed. The Task is
 * one an earlier `task-added` edit appended, or the fix Task of a live legacy
 * Forward Fix audit (ADR-0077), whose audit then moves whole into
 * `forward_fix_withdrawals` as the retired command did. The Task leaves the
 * roster and every edge to it is dropped, which releases the Tasks that waited
 * for it. Replaying a committed withdrawal changes nothing.
 */
export function withdrawTask(graph: TaskGraph, request: WithdrawTaskRequest): DomainResult<WithdrawTask, WithdrawTaskRefusal> {
  const replay = replayedWithdrawal(graph, request);
  if (replay !== undefined) return okWith(freeze({ kind: "already-withdrawn" as const, wave: replay, taskId: request.taskId }));
  const open = openWave(graph, "withdrawing a Task");
  if (!open.ok) return open;
  const { wave, abandonedRunId } = open.value;
  const added = (graph.wave_plan_edits ?? []).some((edit) => edit.kind === "task-added" && edit.taskId === request.taskId);
  const audit = (graph.forward_fix_history ?? []).find(({ fixTaskId }) => fixTaskId === request.taskId);
  const task = graph.tasks.find(({ id }) => id === request.taskId);
  if ((!added && audit === undefined) || task === undefined || task.wave !== wave) {
    return refuse("not-an-added-task", `${request.taskId} is not a Task appended to the active Wave ${wave} after population ` +
      "(by add-task, or by the retired Forward Fix)");
  }
  if (!isUntouchedJoinedTask(task)) {
    return refuse("already-dispatched", `${request.taskId} was already dispatched; let it settle, or reopen it, instead of withdrawing it`);
  }
  const retired = retireUnownedWaveReviewAuthority(graph, wave, abandonedRunId);
  const { tasks, released: dropped } = rosterWithout(retired.tasks, request.taskId);
  const gates = resetWaveGates(retired, wave, tasks);
  if (audit !== undefined && !added) {
    const withdrawal: ForwardFixWithdrawal = freeze({ schemaVersion: 1, kind: "forward-fix-withdrawn", audit, reason: request.reason });
    return okWith(freeze({
      kind: "withdrawn" as const,
      wave,
      taskId: request.taskId,
      released: Object.freeze([...new Set([...audit.heldTaskIds, ...dropped])]),
      record: freeze({ kind: "forward-fix-withdrawn" as const, withdrawal }),
      graph: freeze({
        ...retired,
        tasks,
        wave_gates: gates,
        forward_fix_history: Object.freeze((graph.forward_fix_history ?? []).filter((entry) => entry !== audit)),
        forward_fix_withdrawals: Object.freeze([...(graph.forward_fix_withdrawals ?? []), withdrawal]),
      }),
    }));
  }
  const edit = taskWithdrawnEdit({ wave, taskId: request.taskId, reason: request.reason, abandonedRunId });
  if (!edit.ok) return refuse("invalid-request", edit.error);
  return okWith(freeze({
    kind: "withdrawn" as const,
    wave,
    taskId: request.taskId,
    released: dropped,
    record: freeze({ kind: "task-withdrawn" as const, edit: edit.value }),
    graph: freeze({
      ...retired,
      tasks,
      wave_gates: gates,
      wave_plan_edits: Object.freeze([...(graph.wave_plan_edits ?? []), edit.value]),
    }),
  }));
}
