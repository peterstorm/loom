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
 * next gate start. The other Tasks of the Wave stay `implemented`.
 *
 * It shares its Wave precondition with Contract Revision (`reopenableWave`)
 * and adds only its own: the named Wave is the active one, it has not
 * completed, and an abandoned run names no successor.
 *
 * Pure: the shell supplies the locked graph and proves quiescence.
 */

import { match } from "ts-pattern";
import { isFlagToken } from "./cli-flag-token";
import type { DomainResult, NonEmpty } from "./orchestration-contract";
import { parseTaskId, type TaskId } from "./task-id";
import { deriveTaskImplementationDispatch } from "./task-implementation-dispatch";
import {
  reopenableWave,
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
  | "lineage-not-dispatchable";

export type TaskReopeningRefusal = Readonly<{ kind: TaskReopeningRefusalKind; message: string }>;

export type TaskReopening =
  /** The Tasks were reopened: persist `graph`, which appends `audit`. */
  | Readonly<{ kind: "reopened"; graph: TaskGraph; audit: TaskReopeningAudit }>
  /** This exact reopening already committed and its Tasks still await
   *  re-implementation: nothing to write. */
  | Readonly<{ kind: "already-reopened"; audit: TaskReopeningAudit }>;

export const TASK_REOPENING_USAGE =
  'Usage: helper orchestration reopen-task --wave <N> --task <task-id> [--task <task-id>]... --reason "<why the Task must be re-implemented>"';

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const refuse = (kind: TaskReopeningRefusalKind, message: string): DomainResult<never, TaskReopeningRefusal> =>
  freeze({ ok: false as const, error: freeze({ kind, message }) });
const WAVE_NUMBER = /^[1-9][0-9]*$/;

/**
 * Exactly one `--wave <N>`, one or more distinct `--task <id>`, and one
 * non-blank `--reason` of at most `MAX_TASK_REOPENING_REASON_LENGTH`
 * characters, in any order. A value that is itself a flag is refused.
 */
export function parseTaskReopeningArgs(args: readonly string[]): DomainResult<TaskReopeningRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${TASK_REOPENING_USAGE}` });
  let wave: string | undefined;
  let reason: string | undefined;
  const tasks: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (flag !== "--wave" && flag !== "--task" && flag !== "--reason") return fail(`unknown argument '${flag}'`);
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (flag === "--task") {
      tasks.push(value);
    } else if (flag === "--wave") {
      if (wave !== undefined) return fail("--wave is given twice");
      wave = value;
    } else {
      if (reason !== undefined) return fail("--reason is given twice");
      reason = value.trim();
    }
  }
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
  return freeze({ ok: true as const, value: freeze({ wave: Number(wave), taskIds, reason }) });
}

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id) => right.includes(id));

/** Every target still sits in protected revalidation, awaiting its fresh settlement. */
const awaitingReimplementation = (task: Task | undefined): boolean =>
  task?.status === "pending" && task.revalidation_required === true;

/** The committed audit this request replays, when its Tasks still await re-implementation. */
function replayedAudit(graph: TaskGraph, request: TaskReopeningRequest): TaskReopeningAudit | undefined {
  const last = (graph.task_reopening_history ?? []).at(-1);
  if (last === undefined || last.wave !== request.wave || last.reason !== request.reason ||
      !sameIds(last.reopenedTaskIds, request.taskIds)) {
    return undefined;
  }
  return last.reopenedTaskIds.every((id) => awaitingReimplementation(graph.tasks.find((task) => task.id === id)))
    ? last
    : undefined;
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

/**
 * `ids` in TaskGraph order, so one reopening has one canonical audit whatever
 * order the operator named. Every id names a graph Task once `targetRefusal`
 * passed; were none to, the operator's order is kept rather than an empty list.
 */
function inGraphOrder(graph: TaskGraph, ids: NonEmpty<TaskId>): NonEmpty<TaskId> {
  const [first, ...rest] = graph.tasks.flatMap(({ id }) => ids.filter((requested) => requested === id));
  return first === undefined ? ids : Object.freeze([first, ...rest] as const);
}

/**
 * Reopen implemented Tasks of the active Wave for re-implementation, or
 * refuse with the exact precondition that failed: the shared Wave-reopening
 * precondition (`reopenableWave`), then this operation's own Wave and target
 * checks. Replaying a committed reopening whose Tasks still await
 * re-implementation changes nothing, and is answered first: a re-dispatched
 * reopened Task holds a reservation the precondition would refuse.
 */
export function reopenImplementedTasks(
  graph: TaskGraph,
  request: TaskReopeningRequest,
): DomainResult<TaskReopening, TaskReopeningRefusal> {
  const replay = replayedAudit(graph, request);
  if (replay !== undefined) return freeze({ ok: true as const, value: freeze({ kind: "already-reopened" as const, audit: replay }) });
  const reopenable = reopenableWave(graph);
  if (!reopenable.ok) return waveReopeningRefusal(reopenable.error);
  const refusal = waveRefusal(reopenable.value, request) ?? targetRefusal(graph, request);
  if (refusal !== null) return refusal;

  const reopenedTaskIds = inGraphOrder(graph, request.taskIds);
  const audit: TaskReopeningAudit = freeze({
    schemaVersion: 1,
    kind: "implemented-tasks-reopened",
    wave: request.wave,
    reopenedTaskIds,
    reason: request.reason,
    abandonedRunId: reopenable.value.abandonedRunId,
  });
  const reopened = returnWaveTasksToRevalidation(reopenable.value, reopenedTaskIds);
  return freeze({
    ok: true as const,
    value: freeze({
      kind: "reopened" as const,
      graph: { ...reopened, task_reopening_history: Object.freeze([...(graph.task_reopening_history ?? []), audit]) },
      audit,
    }),
  });
}
