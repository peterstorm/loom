/**
 * Task Reopening: the operator path that makes an `implemented` Task in the
 * active Wave dispatchable again, so a Wave Gate advisory (or a surviving
 * critical) on it can be fixed without discarding the Wave's settled evidence.
 *
 * The Wave Gate records only approval. To act on a Finding instead, the
 * operator abandons the run, reopens the affected Task here, re-dispatches it
 * through `helper orchestration brief`, and starts a fresh Wave Gate. The
 * reopened Task returns to protected revalidation through the transition a
 * Contract Revision uses (`returnWaveTasksToRevalidation`): its Findings stay
 * as prior Findings for the next Review Run, the Wave's review and suite
 * authority is retired, and only a fresh implementation settlement lets the
 * next gate start. The other Tasks of the Wave stay `implemented`, except its
 * Distill Task: the transition sweeps a settled one back with the named Tasks
 * (ADR-0068 §7), so the re-implemented code is distilled again. The audit
 * lists it among the reopened Tasks and again under `sweptDistillTaskIds`,
 * which is how a replay and the operator message tell a swept Task from a
 * named one. Naming the Distill Task alone reopens only it, and sweeps none.
 *
 * It shares its Wave precondition with Contract Revision (`reopenableWave`)
 * and adds only its own: the named Wave is the active one, it has not
 * completed, and an abandoned run names no successor.
 *
 * A reopening names what the Finding needs (ADR-0093): a full
 * re-implementation by default, or, with `--needs tests`, new or
 * strengthened tests only, whose Proof owes no I6 order and fails on any
 * production write (`core/reopen-scope`).
 *
 * Pure: the shell supplies the locked graph and proves quiescence.
 */

import { match } from "ts-pattern";
import { isFlagToken } from "./cli-flag-token";
import { isDistillTask } from "./distill-task";
import type { DomainResult, NonEmpty } from "./orchestration-contract";
import { derivePendingTaskProof, redThenGreenScope, writtenContract } from "./proof-obligations";
import {
  classifyTestsOnlyScope,
  REOPEN_NEEDS,
  reopeningNeedsOf,
  testsOnlyProofScope,
  type ReopenNeeds,
  type TestsOnlyReopenScope,
} from "./reopen-scope";
import { parseTaskId, type TaskId } from "./task-id";
import { taskVerificationPolicy } from "./verification-policy";
import { deriveTaskImplementationDispatch } from "./task-implementation-dispatch";
import {
  reopenableWave,
  reopenedTaskIdsOf,
  returnWaveTasksToRevalidation,
  type ReopenableWave,
  type WaveReopeningRefusal,
} from "./task-revalidation";
import type { Task, TaskGraph, TaskReopeningAudit } from "../types";

/** The longest reason a reopening records; it is an audit line, not a document. */
export const MAX_TASK_REOPENING_REASON_LENGTH = 512;

export type TaskReopeningRequest = Readonly<{
  wave: number;
  /** Distinct Task ids, in the order the operator named them. */
  taskIds: NonEmpty<TaskId>;
  reason: string;
  /** What the Finding needs (ADR-0093): `implementation` (the default) or `tests` only. */
  needs: ReopenNeeds;
}>;

export type TaskReopeningRefusalKind =
  | "not-executing"
  | "wrong-wave"
  | "wave-completed"
  | "live-wave-gate"
  | "successor-named"
  | "implementation-active"
  | "unknown-task"
  | "foreign-task"
  | "not-implemented"
  | "lineage-not-dispatchable"
  /** The same Tasks still await the last reopening, which named other `--needs`. */
  | "needs-conflict"
  /** A `--needs tests` target that a tests-only Proof cannot judge (ADR-0093). */
  | "tests-only-distill-task"
  | "tests-only-contract-task"
  | "tests-only-unclassified"
  | "tests-only-no-test-files"
  | "tests-only-regression-waived";

export type TaskReopeningRefusal = Readonly<{ kind: TaskReopeningRefusalKind; message: string }>;

export type TaskReopening =
  /** The Tasks were reopened: persist `graph`, which appends `audit`. The
   *  audit lists every reopened Task and, apart, the ones among them the
   *  engine swept back (`sweptDistillTaskIds`: the Wave's settled Distill
   *  Task, ADR-0068 §7). */
  | Readonly<{ kind: "reopened"; graph: TaskGraph; audit: TaskReopeningAudit }>
  /** This exact reopening already committed and its Tasks still await
   *  re-implementation: nothing to write. */
  | Readonly<{ kind: "already-reopened"; audit: TaskReopeningAudit }>;

export const TASK_REOPENING_USAGE =
  'Usage: helper orchestration reopen-task --wave <N> --task <task-id> [--task <task-id>]... --reason "<why the Task must be re-implemented>" [--needs implementation|tests]';

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const refuse = (kind: TaskReopeningRefusalKind, message: string): DomainResult<never, TaskReopeningRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });
const WAVE_NUMBER = /^[1-9][0-9]*$/;

const REOPENING_FLAGS = ["--wave", "--task", "--reason", "--needs"] as const;
type ReopeningFlag = (typeof REOPENING_FLAGS)[number];
const isReopeningFlag = (flag: string | undefined): flag is ReopeningFlag =>
  REOPENING_FLAGS.some((known) => known === flag);
const parseNeeds = (raw: string): ReopenNeeds | undefined => REOPEN_NEEDS.find((needs) => needs === raw);

/**
 * Exactly one `--wave <N>`, one or more distinct `--task <id>`, one non-blank
 * `--reason` of at most `MAX_TASK_REOPENING_REASON_LENGTH` characters, and at
 * most one `--needs implementation|tests` (absent is `implementation`), in any
 * order. A value that is itself a flag is refused.
 */
export function parseTaskReopeningArgs(args: readonly string[]): DomainResult<TaskReopeningRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${TASK_REOPENING_USAGE}` });
  const single = new Map<Exclude<ReopeningFlag, "--task">, string>();
  const tasks: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!isReopeningFlag(flag)) return fail(`unknown argument '${flag}'`);
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (flag === "--task") {
      tasks.push(value);
      continue;
    }
    if (single.has(flag)) return fail(`${flag} is given twice`);
    single.set(flag, value);
  }
  const wave = single.get("--wave");
  const reason = single.get("--reason")?.trim();
  const rawNeeds = single.get("--needs");
  const needs = rawNeeds === undefined ? "implementation" : parseNeeds(rawNeeds);
  if (needs === undefined) return fail(`--needs must be ${REOPEN_NEEDS.join(" or ")}, not '${rawNeeds}'`);
  if (wave === undefined || !WAVE_NUMBER.test(wave) || !Number.isSafeInteger(Number(wave))) {
    return fail("--wave must name the active Wave as a positive integer");
  }
  const parsed = tasks.map((raw) => parseTaskId(raw, "--task"));
  const invalid = parsed.flatMap((result) => result.ok ? [] : result.error.errors);
  if (invalid.length > 0) return fail(invalid.join("; "));
  const [first, ...rest] = parsed.flatMap((result) => result.ok ? [result.value] : []);
  if (first === undefined) return fail("--task must name at least one implemented Task");
  const taskIds: NonEmpty<TaskId> = Object.freeze([first, ...rest] as const);
  const repeated = taskIds.find((id, index) => taskIds.indexOf(id) !== index);
  if (repeated !== undefined) return fail(`--task ${repeated} is given twice`);
  if (reason === undefined || reason.length === 0) return fail("--reason must say why the Task must be re-implemented");
  if (reason.length > MAX_TASK_REOPENING_REASON_LENGTH) {
    return fail(`--reason is longer than ${MAX_TASK_REOPENING_REASON_LENGTH} characters`);
  }
  return freeze({ ok: true as const, value: freeze({ wave: Number(wave), taskIds, reason, needs }) });
}

/** The Distill Tasks an audit says the engine swept back; none when it records none. */
export const sweptDistillTaskIdsOf = (audit: Pick<TaskReopeningAudit, "sweptDistillTaskIds">): readonly TaskId[] =>
  audit.sweptDistillTaskIds ?? [];

/**
 * Whether `audit` reopened what `request` names: every named Task, and beyond
 * them only the Tasks the audit records as swept, which no request has to
 * name. The audit is the record of what the operator named; the roster is not
 * consulted.
 */
const reopenedWhatRequestNames = (audit: TaskReopeningAudit, request: TaskReopeningRequest): boolean => {
  const swept = sweptDistillTaskIdsOf(audit);
  return request.taskIds.every((id) => audit.reopenedTaskIds.includes(id)) &&
    audit.reopenedTaskIds.every((id) => request.taskIds.includes(id) || swept.includes(id));
};

/** Every target still sits in protected revalidation, awaiting its fresh settlement. */
const awaitingReimplementation = (task: Task | undefined): boolean =>
  task?.status === "pending" && task.revalidation_required === true;

/**
 * The last committed audit when it reopened this request's Wave and Tasks and
 * every one of them still awaits re-implementation: the request repeats it.
 */
function repeatedAudit(graph: TaskGraph, request: TaskReopeningRequest): TaskReopeningAudit | undefined {
  const last = (graph.task_reopening_history ?? []).at(-1);
  if (last === undefined || last.wave !== request.wave || !reopenedWhatRequestNames(last, request)) return undefined;
  return last.reopenedTaskIds.every((id) => awaitingReimplementation(graph.tasks.find((task) => task.id === id)))
    ? last
    : undefined;
}

/**
 * A repeat answered before any precondition: the same reason and `--needs`
 * replay it (null: nothing to refuse), while other `--needs` conflict with
 * it. A repeat with another reason falls through to the ordinary refusals,
 * as before `--needs` existed.
 */
function repeatOutcome(
  graph: TaskGraph,
  request: TaskReopeningRequest,
): DomainResult<TaskReopening, TaskReopeningRefusal> | null {
  const repeated = repeatedAudit(graph, request);
  if (repeated === undefined) return null;
  const recorded = reopeningNeedsOf(repeated);
  if (recorded !== request.needs) {
    return refuse("needs-conflict", `${repeated.reopenedTaskIds.join(", ")} already await the reopening that named ` +
      `--needs ${recorded}; a reopening names one scope, so let that attempt settle (or escalate) before reopening for ${request.needs}`);
  }
  return repeated.reason === request.reason
    ? freeze({ ok: true as const, value: freeze({ kind: "already-reopened" as const, audit: repeated }) })
    : null;
}

/** The shared Wave-reopening refusal, in this operation's words. */
const waveReopeningRefusal = (refusal: WaveReopeningRefusal): DomainResult<never, TaskReopeningRefusal> =>
  match(refusal)
    .with({ kind: "not-executing" }, ({ phase }) =>
      refuse("not-executing", `reopening a Task requires the execute Phase (current: ${phase})`))
    .with({ kind: "live-wave-gate" }, ({ runId, wave }) =>
      refuse("live-wave-gate", `Wave Gate run ${runId} owns Wave ${wave}'s verification; ` +
        "abandon it with helper orchestration abandon, then retry"))
    .with({ kind: "implementation-active" }, ({ holders }) =>
      refuse("implementation-active", `implementation reservations are active: ${holders.join(", ")}`))
    .exhaustive();

/** Task Reopening's own refusals over the reopenable Wave, after the shared precondition, or null. */
function waveRefusal(reopenable: ReopenableWave, request: TaskReopeningRequest): DomainResult<never, TaskReopeningRefusal> | null {
  const { graph, wave } = reopenable;
  if (wave !== request.wave) return refuse("wrong-wave", `Wave ${request.wave} is not the active Wave ${wave}`);
  if ((graph.wave_gate_history ?? []).some((entry) => entry.wave === wave)) {
    return refuse("wave-completed", `Wave ${wave} has completed; reopen the completed Wave instead (helper reopen-completed-wave)`);
  }
  const outcome = graph.active_wave_gate?.terminalOutcome;
  if (outcome?.kind === "terminal-abandoned" && outcome.supersededBy !== null) {
    return refuse("successor-named", `abandoned Wave Gate run ${reopenable.abandonedRunId} names successor ` +
      `${outcome.supersededBy}; reopening would orphan that successor's authority, so start it ` +
      "(or abandon it naming no successor) first");
  }
  return null;
}

/** The first target that cannot be reopened, in request order, or null. */
function targetRefusal(graph: TaskGraph, request: TaskReopeningRequest): DomainResult<never, TaskReopeningRefusal> | null {
  for (const id of request.taskIds) {
    const task = graph.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) return refuse("unknown-task", `${id} is not a Task of this TaskGraph`);
    if (task.wave !== request.wave) {
      return refuse("foreign-task", `${id} belongs to Wave ${task.wave}, not the active Wave ${request.wave}`);
    }
    if (task.status !== "implemented") {
      return refuse("not-implemented", `${id} is ${task.status}; only an implemented Task is reopened ` +
        "(a pending Task is already owed a dispatch)");
    }
    const derivation = deriveTaskImplementationDispatch(task);
    if (derivation.kind !== "dispatch") {
      const why = derivation.kind === "escalated"
        ? `its lineage reached terminal escalation ${derivation.receiptId}; remediate it first (helper orchestration remediate)`
        : `its implementation lineage cannot derive a dispatch (${derivation.kind})`;
      return refuse("lineage-not-dispatchable", `${id} cannot be re-dispatched: ${why}`);
    }
  }
  return null;
}

/** The tests-only scope each named Task takes, by id; empty for a full re-implementation. */
type TestsOnlyScopes = ReadonlyMap<string, TestsOnlyReopenScope>;
const NO_SCOPES: TestsOnlyScopes = new Map();

/**
 * Each named Task's tests-only scope under `--needs tests` (ADR-0093), or the
 * first target, in request order, whose Proof could not be tests-only:
 * a Distill Task (its Proof is `behaviour-preserved`), an Acceptance Contract
 * writer (its tests stay red by contract), a TaskGraph with no frozen
 * Test-File Classification, a `file_list` with no test file, or a policy that
 * waives regression (nothing would prove the tests pass). Swept Distill Tasks
 * take no scope: they are dispatched again as distill passes.
 */
function testsOnlyScopes(graph: TaskGraph, request: TaskReopeningRequest): DomainResult<TestsOnlyScopes, TaskReopeningRefusal> {
  if (request.needs === "implementation") return freeze({ ok: true as const, value: NO_SCOPES });
  const writers = redThenGreenScope(graph.verification_manifest, graph.acceptance_contracts ?? []);
  const scopes = new Map<string, TestsOnlyReopenScope>();
  for (const id of request.taskIds) {
    const task = graph.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) return refuse("unknown-task", `${id} is not a Task of this TaskGraph`);
    if (isDistillTask(task)) {
      return refuse("tests-only-distill-task", `${id} is a Distill Task; its pass preserves behaviour and adds no tests, so reopen it without --needs tests`);
    }
    const contract = writtenContract(writers, id);
    if (contract !== undefined) {
      return refuse("tests-only-contract-task", `${id} writes Acceptance Contract ${contract}, whose tests stay red by contract; reopen it without --needs tests`);
    }
    const regression = taskVerificationPolicy(task).regression;
    if (regression.kind === "waived") {
      return refuse("tests-only-regression-waived", `${id} waives regression (${regression.reason}), so nothing would prove the tests it adds pass; reopen it without --needs tests`);
    }
    const scope = classifyTestsOnlyScope(task.file_list ?? [], graph.verification_manifest);
    if (!scope.ok) {
      return scope.error.kind === "classification-unfrozen"
        ? refuse("tests-only-unclassified", "this TaskGraph froze no Test-File Classification, so a tests-only Proof cannot tell test files from implementation files; reopen without --needs tests")
        : refuse("tests-only-no-test-files", `${id}'s file_list names no test file; add one first (helper orchestration rescope-task after a full reopening) or reopen without --needs tests`);
    }
    scopes.set(id, scope.value);
  }
  return freeze({ ok: true as const, value: scopes });
}

/** A returned Task with its tests-only scope and the Proof that scope derives. */
const withTestsOnlyScope = (task: Task, scope: TestsOnlyReopenScope): Task => freeze({
  ...task,
  status: "pending" as const,
  revalidation_required: true as const,
  legacy_missing_proof: undefined,
  reopen_scope: scope,
  proof: derivePendingTaskProof({
    verificationPolicy: taskVerificationPolicy(task),
    declaredArtifacts: task.file_list ?? [],
    testsOnly: testsOnlyProofScope(scope),
  }),
});

/**
 * Reopen implemented Tasks of the active Wave for re-implementation, or
 * refuse with the exact precondition that failed: the shared Wave-reopening
 * precondition (`reopenableWave`), then this operation's own Wave and target
 * checks, then, under `--needs tests`, whether each named Task's Proof can be
 * tests-only. Replaying a committed reopening whose Tasks still await
 * re-implementation changes nothing, and is answered first: a re-dispatched
 * reopened Task holds a reservation the precondition would refuse. A repeat
 * naming other `--needs` is refused just as early.
 *
 * Under `--needs tests` each named Task returns to revalidation like any
 * other, then takes its tests-only scope and the pending Proof that scope
 * derives (ADR-0093); the audit records `needs: "tests"`.
 */
export function reopenImplementedTasks(
  graph: TaskGraph,
  request: TaskReopeningRequest,
): DomainResult<TaskReopening, TaskReopeningRefusal> {
  const repeat = repeatOutcome(graph, request);
  if (repeat !== null) return repeat;
  const reopenable = reopenableWave(graph);
  if (!reopenable.ok) return waveReopeningRefusal(reopenable.error);
  const refusal = waveRefusal(reopenable.value, request) ?? targetRefusal(graph, request);
  if (refusal !== null) return refusal;
  const scopes = testsOnlyScopes(graph, request);
  if (!scopes.ok) return scopes;

  const revalidated = returnWaveTasksToRevalidation(reopenable.value, request.taskIds);
  const reopened = scopes.value.size === 0 ? revalidated : {
    ...revalidated,
    graph: {
      ...revalidated.graph,
      tasks: revalidated.graph.tasks.map((task) => {
        const scope = scopes.value.get(task.id);
        return scope === undefined ? task : withTestsOnlyScope(task, scope);
      }),
    },
  };
  // The audited ids are every Task the transition returned, named and swept,
  // in TaskGraph order, so one reopening has one canonical audit whatever
  // order the operator named. The transition returns none only when no named
  // id is a Task of the roster, which `targetRefusal` has already refused in
  // these words; the branch is the narrowing the type needs, not a second rule.
  const reopenedIds = reopenedTaskIdsOf(reopened.returned);
  if (reopenedIds === null) return refuse("unknown-task", `${request.taskIds[0]} is not a Task of this TaskGraph`);
  const audit: TaskReopeningAudit = freeze({
    schemaVersion: 1,
    kind: "implemented-tasks-reopened",
    wave: request.wave,
    ...reopenedIds,
    reason: request.reason,
    abandonedRunId: reopenable.value.abandonedRunId,
    ...(request.needs === "tests" ? { needs: "tests" as const } : {}),
  });
  return freeze({
    ok: true as const,
    value: freeze({
      kind: "reopened" as const,
      graph: { ...reopened.graph, task_reopening_history: Object.freeze([...(graph.task_reopening_history ?? []), audit]) },
      audit,
    }),
  });
}
