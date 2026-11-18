/**
 * The Task owner check's pure core (ADR-0092): Owner Verification, run by the
 * implementer of a Task that writes an owned family before it stops, so a
 * matrix test that misses a sibling or lets a mutant of the owner survive is
 * answered in the implementer's own loop rather than at the Wave Gate.
 *
 * Every decision of the check lives here, and each has one home:
 * - `taskOwnerCheckDuty`: whether a Task owes the check, over which
 *   obligations, what each one's matrix test must reach at this stop, whether
 *   the Task answers its findings, and the runner its mutation needs.
 *   `helper owner-check`, the stop arm and the implementation brief all ask it.
 * - `taskOwnerCheckDigest`: the identity of what one run judged, over the
 *   Task's base, the owed obligations and the bytes of every family input.
 * - `taskOwnerCheckResult` / `taskOwnerCheckUnavailable`: the run's result,
 *   the gate's own `InvariantVerdict` per obligation, or why it could not run.
 * - `judgeTaskOwnerCheck`: a result read against the duty, each verdict
 *   paired with the obligation it judged; a verdict for an Invariant the duty
 *   does not owe is refused. `recordedTaskOwnerCheck` builds a record only
 *   through it, and the stop reads every record through it.
 * - `parseTaskOwnerCheckRecord` and `taskOwnerCheckRecordJson`: the record's
 *   wire form, in the envelope the Task records share (`task-record.ts`).
 * - `sortTaskOwnerFindings`: which findings the Task answers (they may block)
 *   and which it only reports. Only the matrix test answers a missing path or
 *   a survivor, so only a Task that lists the matrix test is held for one.
 * - `taskOwnerCheckStopVerdict` and the renderers.
 *
 * The coverage rule (`duePathsAtStop`, `isSettledAtStop`) and the mutation
 * plan are the Wave Gate's own, in `owner-verification/`. Nothing here is
 * completion evidence; the gate's Owner Verification is unchanged and stays
 * the control.
 *
 * Pure and total: no I/O, no clock, no throw.
 */

import { match } from "ts-pattern";
import type { TaskGraph } from "../types";
import { taskRolePolicy } from "./distill-task";
import { DECISION_RECORD_AGENT } from "./model-profiles";
import { failure, isNonEmpty, mapNonEmpty, nonEmpty, nonEmptyOf, success, type DomainResult, type NonEmpty } from "./orchestration-contract/identity";
import {
  contractTaskIdsOf,
  duePathsAtStop,
  isSettledAtStop,
  obligationsDigest,
  owesInWave,
  taskOwnerDuty,
  verifyOwed,
} from "./owner-verification/obligations";
import { parseInvariantVerdicts } from "./owner-verification/parse";
import type { InvariantVerdict, OwnerObligation, OwnerVerificationFailure } from "./owner-verification/types";
import { invariantVerdictFailures, renderMutationVerdict, renderOwnerVerificationFailure } from "./owner-verification/verdict";
import { isRepoRelativePlanPath, normalizePlanPath } from "./plan-path-match";
import { invariantRoles } from "./plan-paths";
import { isRecord } from "./plain-record";
import {
  exactKeys,
  parseTaskRecord,
  recordedTask,
  taskRecordDigest,
  taskRecordJson,
  type RecordedTask,
  type TaskFileBytes,
  type TaskRecord,
  type TaskRecordDigest,
  type TaskRecordObservation,
  type TaskRecordStanding,
  type TaskRecordStopVerdict,
  type TaskRecordWire,
} from "./task-record";
import type { AffectedRunner } from "./verification-manifest";

/** The longest one `helper owner-check` run may take; a run it cannot launch in time is refused, never half-judged. */
export const TASK_OWNER_CHECK_DEADLINE_MS = 480_000;

/** The tool-call timeout an implementer gives the helper: the deadline, plus room to open and remove its worktrees. */
export const TASK_OWNER_CHECK_BASH_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// The duty
// ---------------------------------------------------------------------------

/** Why a Task owes no owner check. Exactly one applies, in this precedence. */
export type TaskOwnerCheckOffReason =
  | "unknown-task"
  /** The TaskGraph predates owner verification: it carries no `owner_obligations` stamp. */
  | "unstamped"
  /** A Distill Task schedules no family and implements no rule (ADR-0068). */
  | "exempt-role"
  /** An ADR Task writes a decision record, not code. */
  | "decision-record-task"
  /** A Contract Task writes compiling stubs, which owe no owner verification. */
  | "contract-task"
  /** No obligation the Task touches is owed at its stop. */
  | "nothing-owed"
  /** An owed obligation needs mutation, but no `affectedRunner` is frozen (population refuses such a plan; the gate reports `runner-missing`). */
  | "no-affected-runner";

/** The one line each off reason reads as. */
export const TASK_OWNER_CHECK_OFF_TEXT: Readonly<Record<TaskOwnerCheckOffReason, string>> = Object.freeze({
  "unknown-task": "the TaskGraph holds no such Task",
  "unstamped": "the TaskGraph carries no owner-obligation stamp",
  "exempt-role": "a Distill Task implements no owned rule",
  "decision-record-task": "an ADR Task writes a decision record, not code",
  "contract-task": "a Contract Task's stubs owe no owner verification",
  "nothing-owed": "no owned Invariant this Task touches is owed at its stop: the Wave owes none of them, or its owner or matrix test " +
    "is another Task of this Wave's work in flight, which the Wave Gate judges",
  "no-affected-runner": "an owned Invariant this Task touches owes mutation, but no affectedRunner is frozen; the Wave Gate reports it as runner-missing",
});

/** One obligation a Task owes at its stop. */
export type StopObligation = Readonly<{
  obligation: OwnerObligation;
  /** What the matrix test must reach at this stop (`duePathsAtStop`): the owner, then each settled sibling. */
  due: NonEmpty<string>;
  /** Whether the Task lists the matrix test: only the matrix test answers a missing path or a survivor. */
  answers: boolean;
}>;

/**
 * A Task that owes the check: its obligations, its base and what the digest
 * covers, and the runner its mutation needs. A duty whose obligations owe
 * mutation always carries the frozen runner; one whose every obligation is
 * mutation-exempt carries none. A duty that owes mutation with no runner
 * cannot be built.
 */
export type OwedTaskOwnerCheck = Readonly<{
  kind: "owed";
  taskId: string;
  wave: number;
  /** The Task's base commit, or null when the Task records none. */
  startSha: string | null;
  /** In stamp order. */
  obligations: NonEmpty<StopObligation>;
  /** Every path the digest covers, each once: each owner, due path and matrix test, then every file the Task declares. */
  digested: NonEmpty<string>;
}> & (Readonly<{ mutation: "owed"; runner: AffectedRunner }> | Readonly<{ mutation: "exempt-only" }>);

export type TaskOwnerCheckDuty = Readonly<{ kind: "off"; reason: TaskOwnerCheckOffReason }> | OwedTaskOwnerCheck;

const off = (reason: TaskOwnerCheckOffReason): TaskOwnerCheckDuty => Object.freeze({ kind: "off", reason });

/** The graph the duty reads. */
export type TaskOwnerCheckGraph = Pick<TaskGraph, "tasks" | "acceptance_contracts" | "owner_obligations" | "verification_manifest">;

/** The list with every repeat after its first occurrence dropped; non-empty because its head always stays. */
function firstOccurrences<T>([head, ...tail]: NonEmpty<T>): NonEmpty<T> {
  return nonEmptyOf(head, ...tail.filter((value, index) => value !== head && tail.indexOf(value) === index));
}

/**
 * Whether `taskId` owes the Task owner check under `graph`, and over which
 * obligations. An obligation is owed at the stop when the Task touches its
 * family (`taskOwnerDuty`: the owner, a sibling or the matrix test), the
 * Task's Wave owes it at the gate (`owesInWave`), and its owner and matrix
 * test are both settled at this stop (`isSettledAtStop`): neither can be
 * judged while another Task of the Wave is still writing it.
 */
export function taskOwnerCheckDuty(graph: TaskOwnerCheckGraph, taskId: string): TaskOwnerCheckDuty {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return off("unknown-task");
  const fileList = task.file_list ?? [];
  const touched = taskOwnerDuty(graph, fileList);
  if (touched.kind === "unstamped") return off("unstamped");
  if (!taskRolePolicy(task).schedulesFamilies) return off("exempt-role");
  if (task.agent === DECISION_RECORD_AGENT) return off("decision-record-task");
  const contractTaskIds = contractTaskIdsOf(graph);
  if (contractTaskIds.has(task.id)) return off("contract-task");
  const owed = nonEmpty(touched.touched
    .filter((obligation) =>
      owesInWave(graph.tasks, contractTaskIds, task.wave, obligation) &&
      isSettledAtStop(graph.tasks, task, obligation.owner) &&
      isSettledAtStop(graph.tasks, task, obligation.matrixTest))
    .map((obligation): StopObligation => Object.freeze({
      obligation,
      due: duePathsAtStop(graph.tasks, task, obligation),
      answers: invariantRoles(fileList, obligation).matrixTest,
    })));
  if (owed === null) return off("nothing-owed");
  const [first, ...rest] = owed;
  const [lead, ...dueRest] = first.due;
  const digested = firstOccurrences<string>([
    lead,
    ...dueRest,
    first.obligation.matrixTest,
    ...rest.flatMap(({ obligation, due }) => [...due, obligation.matrixTest]),
    ...fileList.map(normalizePlanPath).filter(isRepoRelativePlanPath),
  ]);
  const fields = {
    kind: "owed" as const,
    taskId: task.id,
    wave: task.wave,
    startSha: task.start_sha === undefined || task.start_sha === "" ? null : task.start_sha,
    obligations: nonEmptyOf(first, ...rest),
    digested,
  };
  const runner = graph.verification_manifest?.affectedRunner;
  if (verifyOwed(owed.map(({ obligation }) => obligation)).length === 0) return Object.freeze({ ...fields, mutation: "exempt-only" });
  return runner === undefined ? off("no-affected-runner") : Object.freeze({ ...fields, mutation: "owed", runner });
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/**
 * The digest of a duty's base, its owed obligations (each with what its
 * matrix test must reach and whether the Task answers it) and the bytes of
 * the files given, by the shared rule (`taskRecordDigest`).
 */
export function taskOwnerCheckDigest(duty: OwedTaskOwnerCheck, files: readonly TaskFileBytes[]): TaskRecordDigest {
  const obligations = duty.obligations.map(({ obligation, due, answers }) => [obligation.invariant, due, answers]);
  const stamp = obligationsDigest(duty.obligations.map(({ obligation }) => obligation));
  return taskRecordDigest("loom-task-owner-check-digest-v1", [duty.startSha, stamp, obligations], files);
}

// ---------------------------------------------------------------------------
// One run's result, judged against the duty
// ---------------------------------------------------------------------------

/**
 * What one `helper owner-check` run found: the Wave Gate's own verdict for
 * each owed obligation, in duty order, or why the check could not run at all.
 * A verdict's infrastructure failure (a red baseline, a refused run, a
 * missing base) is the verdict's own and never makes the whole result
 * `unavailable`, so coverage is still judged when mutation could not be.
 */
export type TaskOwnerCheckResult =
  | Readonly<{ kind: "verdicts"; verdicts: NonEmpty<InvariantVerdict> }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export const taskOwnerCheckUnavailable = (reason: string): TaskOwnerCheckResult => Object.freeze({ kind: "unavailable", reason });

export const taskOwnerCheckResult = (verdicts: NonEmpty<InvariantVerdict>): TaskOwnerCheckResult =>
  Object.freeze({ kind: "verdicts", verdicts });

/** One verdict with the obligation it judged. */
export type JudgedObligation = Readonly<{ owed: StopObligation; verdict: InvariantVerdict }>;

/** A result read against the duty: each verdict paired with its obligation, or why the check could not decide. */
export type TaskOwnerCheckJudgement =
  | Readonly<{ kind: "judged"; judged: NonEmpty<JudgedObligation> }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Each verdict paired with the obligation of the duty it judged, or the refusal naming the first Invariant the duty does not owe. */
function pairVerdicts(duty: OwedTaskOwnerCheck, [head, ...tail]: NonEmpty<InvariantVerdict>): DomainResult<NonEmpty<JudgedObligation>, string> {
  const pairOf = (verdict: InvariantVerdict): DomainResult<JudgedObligation, string> => {
    const owed = duty.obligations.find(({ obligation }) => obligation.invariant === verdict.invariant);
    return owed === undefined
      ? failure(`it judged ${verdict.invariant}, which Task ${duty.taskId} does not owe at its stop`)
      : success(Object.freeze({ owed, verdict }));
  };
  const first = pairOf(head);
  if (!first.ok) return first;
  const rest: JudgedObligation[] = [];
  for (const verdict of tail) {
    const paired = pairOf(verdict);
    if (!paired.ok) return paired;
    rest.push(paired.value);
  }
  return success(nonEmptyOf(first.value, ...rest));
}

/** A result as the duty reads it: a result that judged an Invariant the duty does not owe is `unavailable`, never trusted. */
export function judgeTaskOwnerCheck(duty: OwedTaskOwnerCheck, result: TaskOwnerCheckResult): TaskOwnerCheckJudgement {
  if (result.kind === "unavailable") return result;
  const paired = pairVerdicts(duty, result.verdicts);
  return paired.ok
    ? Object.freeze({ kind: "judged", judged: paired.value })
    : Object.freeze({ kind: "unavailable", reason: `its record is not of this duty: ${paired.error}` });
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export const TASK_OWNER_CHECK_RECORD_KIND = "loom-task-owner-check-record" as const;
export const TASK_OWNER_CHECK_RECORD_SCHEMA_VERSION = 1 as const;

const WIRE: TaskRecordWire = Object.freeze({
  kind: TASK_OWNER_CHECK_RECORD_KIND,
  schemaVersion: TASK_OWNER_CHECK_RECORD_SCHEMA_VERSION,
  path: "taskOwnerCheckRecord",
});

/** What a Task's last owner-check run left: nothing (`not-run`), or its result bound to the digest of what it judged. */
export type TaskOwnerCheckRecord = TaskRecord<TaskOwnerCheckResult>;

export type RecordedTaskOwnerCheck = RecordedTask<TaskOwnerCheckResult>;

/**
 * The record of one run over `duty`. It refuses a duty with no Task id and a
 * result that judged an Invariant the duty does not owe, so a record the
 * helper writes always pairs with the duty it ran for.
 */
export function recordedTaskOwnerCheck(
  duty: OwedTaskOwnerCheck,
  digest: TaskRecordDigest,
  result: TaskOwnerCheckResult,
): DomainResult<RecordedTaskOwnerCheck, string> {
  if (duty.taskId === "") return failure("a Task owner record needs a Task id");
  if (result.kind === "verdicts") {
    const paired = pairVerdicts(duty, result.verdicts);
    if (!paired.ok) return failure(`the result is not of this duty: ${paired.error}`);
  }
  return success(recordedTask(duty.taskId, digest, result));
}

/** The record's wire document. Property order is fixed, so equal records serialize to equal bytes. */
export const taskOwnerCheckRecordJson = (record: RecordedTaskOwnerCheck): string => taskRecordJson(WIRE, record);

function parseResult(raw: unknown, path: string): DomainResult<TaskOwnerCheckResult, string> {
  if (!isRecord(raw)) return failure(`${path} must be an object`);
  if (raw.kind === "unavailable") {
    const shape = exactKeys(raw, ["kind", "reason"], path);
    if (shape !== null) return failure(shape);
    return typeof raw.reason === "string" && raw.reason !== ""
      ? success(taskOwnerCheckUnavailable(raw.reason))
      : failure(`${path}.reason must be a non-empty string`);
  }
  if (raw.kind !== "verdicts") return failure(`${path}.kind must be "verdicts" or "unavailable"`);
  const shape = exactKeys(raw, ["kind", "verdicts"], path);
  if (shape !== null) return failure(shape);
  const verdicts = parseInvariantVerdicts(raw.verdicts, `${path}.verdicts`);
  if (!verdicts.ok) return failure(verdicts.error.errors.join("; "));
  return isNonEmpty(verdicts.value) ? success(taskOwnerCheckResult(verdicts.value)) : failure(`${path}.verdicts must name at least one verdict`);
}

/** A record document as a record, or the first reason it is not one. */
export const parseTaskOwnerCheckRecord = (raw: unknown): DomainResult<RecordedTaskOwnerCheck, string> => parseTaskRecord(raw, WIRE, parseResult);

// ---------------------------------------------------------------------------
// Sorting findings
// ---------------------------------------------------------------------------

/**
 * One run's findings, sorted by who answers them. `blocking`: a missing path
 * or a survivor of an obligation whose matrix test the Task lists. `noted`:
 * every other finding, rendered as one line each (the same findings when the
 * Task does not list the matrix test, a red baseline, an infrastructure
 * verdict), which never holds a stop.
 */
export type TaskOwnerFindings = Readonly<{ blocking: readonly OwnerVerificationFailure[]; noted: readonly string[] }>;

export function sortTaskOwnerFindings(judged: readonly JudgedObligation[]): TaskOwnerFindings {
  const blocking: OwnerVerificationFailure[] = [];
  const noted: string[] = [];
  for (const { owed, verdict } of judged) {
    for (const found of invariantVerdictFailures(verdict)) {
      const answerable = found.kind === "missing-siblings" || found.kind === "survivor";
      if (answerable && owed.answers) blocking.push(found);
      else if (answerable) noted.push(`${renderOwnerVerificationFailure(found)} (only ${verdict.matrixTest} answers this, and this Task does not list it)`);
      else noted.push(renderOwnerVerificationFailure(found));
    }
  }
  return Object.freeze({ blocking: Object.freeze(blocking), noted: Object.freeze(noted) });
}

// ---------------------------------------------------------------------------
// The stop
// ---------------------------------------------------------------------------

/** How a Task's record stands against its family now (`taskRecordStanding`). */
export type TaskOwnerCheckStanding = TaskRecordStanding<TaskOwnerCheckResult>;

/** What a stop shell observed for the owner arm: the Task owes nothing, its record's standing with the duty and the refreshing command, or a fault. */
export type TaskOwnerCheckObservation = TaskRecordObservation<TaskOwnerCheckResult, Readonly<{ duty: OwedTaskOwnerCheck }>>;

/** Why the owner arm would hold a stop open. */
export type TaskOwnerCheckBlockCause =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "findings"; findings: NonEmpty<OwnerVerificationFailure>; noted: readonly string[] }>;

/**
 * The arm's verdict at one stop. It blocks for a check that never ran, ran
 * over other bytes, or left a finding the Task answers; a current record with
 * no finding passes; a record whose findings the Task does not answer, an
 * unavailable run, a record of another duty and every fault is a note, and
 * the stop proceeds.
 */
export type TaskOwnerCheckStopVerdict = TaskRecordStopVerdict<TaskOwnerCheckBlockCause>;

const proceeds = (taskId: string, why: string): TaskOwnerCheckStopVerdict =>
  Object.freeze({ kind: "note", note: `Task owner check for ${taskId} did not hold the stop (${why}); the stop proceeds and the Wave Gate judges` });

export function taskOwnerCheckStopVerdict(taskId: string, observation: TaskOwnerCheckObservation): TaskOwnerCheckStopVerdict {
  if (observation.kind === "off") return Object.freeze({ kind: "idle" });
  if (observation.kind === "unavailable") return proceeds(taskId, observation.reason);
  const { duty, standing, command } = observation;
  if (standing.kind !== "current") return Object.freeze({ kind: "failing", cause: standing, command });
  const judgement = judgeTaskOwnerCheck(duty, standing.result);
  if (judgement.kind === "unavailable") return proceeds(taskId, `its last run was unavailable: ${judgement.reason}`);
  const { blocking, noted } = sortTaskOwnerFindings(judgement.judged);
  if (isNonEmpty(blocking)) return Object.freeze({ kind: "failing", cause: Object.freeze({ kind: "findings", findings: blocking, noted }), command });
  if (noted.length > 0) return proceeds(taskId, noted.join("; "));
  return Object.freeze({ kind: "passed" });
}

// ---------------------------------------------------------------------------
// What the implementer reads
// ---------------------------------------------------------------------------

/** How a Task that lists the matrix test answers each kind of finding. */
export const ANSWER_OWNER_FINDINGS =
  "For a missing path, make the matrix test import it, directly or through a module that re-exports it. For a survivor, add an " +
  "assertion to the matrix test, run through the owner or a sibling entry point, that fails on the mutated line; then run the check " +
  "again. When no test can tell a survivor from the owner's code (an equivalent mutant), name it and say why in your final report: " +
  "a reasoned mutation exemption is a plan change the operator decides.";

const notedLines = (noted: readonly string[]): readonly string[] =>
  noted.length === 0 ? [] : ["Not blocking (the Wave Gate judges these):", ...noted.map((line) => `- ${line}`)];

/** One verdict's summary line: its coverage, then its mutation half in the gate's words. */
const verdictSummary = ({ verdict }: JudgedObligation): string => {
  const coverage = match(verdict.coverage)
    .with({ kind: "covered" }, () => "coverage reaches every path due at this stop")
    .with({ kind: "missing" }, ({ paths }) => `coverage misses ${paths.join(", ")}`)
    .with({ kind: "infrastructure" }, ({ failure: cause }) => `coverage infrastructure failure (${cause.kind}): ${cause.detail}`)
    .exhaustive();
  return `- ${verdict.invariant} (matrix test ${verdict.matrixTest}): ${coverage}; ${renderMutationVerdict(verdict.mutation)}`;
};

/** What `helper owner-check` prints for one run, read against the duty it ran for. */
export function renderTaskOwnerCheckReport(taskId: string, judgement: TaskOwnerCheckJudgement): string {
  const head = `Task owner check for ${taskId}:`;
  if (judgement.kind === "unavailable") return `${head} unavailable — ${judgement.reason}. It did not decide and will not block your stop.`;
  const { blocking, noted } = sortTaskOwnerFindings(judgement.judged);
  const summary = mapNonEmpty(judgement.judged, verdictSummary);
  if (blocking.length === 0) {
    return [`${head} ${noted.length === 0 ? "clean" : "nothing for this Task to answer"}.`, ...summary, ...notedLines(noted)].join("\n");
  }
  return [
    `${head} ${blocking.length} finding(s) this Task answers in its matrix test.`,
    ...summary,
    ...blocking.map((found) => `- ${renderOwnerVerificationFailure(found)}`),
    ...notedLines(noted),
    ANSWER_OWNER_FINDINGS,
  ].join("\n");
}

const blockCauseLines = (cause: TaskOwnerCheckBlockCause): readonly string[] =>
  match(cause)
    .with({ kind: "not-run" }, () => ["The check has not run for this Task."])
    .with({ kind: "stale" }, () => ["The family's files or your files changed after the check last ran, so its result is of other bytes."])
    .with({ kind: "findings" }, ({ findings, noted }) => [
      "Owner Verification found what the Wave Gate would block on:",
      ...findings.map((found) => `- ${renderOwnerVerificationFailure(found)}`),
      ...notedLines(noted),
      ANSWER_OWNER_FINDINGS,
    ])
    .exhaustive();

/** The owner arm's part of a block message: why it blocks, and the one command that answers it. */
export function renderTaskOwnerCheckBlock(cause: TaskOwnerCheckBlockCause, command: string, blocksRemaining: number): string {
  return [
    "LOOM TASK OWNER CHECK: an owned Invariant your Task writes is not yet answered by its matrix test.",
    ...blockCauseLines(cause),
    "",
    `Run it as one Bash call with a timeout of ${TASK_OWNER_CHECK_BASH_TIMEOUT_MS} ms, then your final verification run:`,
    `  ${command}`,
    `This check blocks at most ${blocksRemaining} more time(s); after that your stop proceeds and the Wave Gate judges.`,
  ].join("\n");
}
