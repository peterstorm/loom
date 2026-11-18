/**
 * The Task owner check's pure core (ADR-0092): Owner Verification, run by the
 * implementer of a Task that writes an owned family before it stops, so a
 * matrix test that misses a sibling or lets a mutant of the owner survive is
 * answered in the implementer's own loop rather than at the Wave Gate.
 *
 * Every decision of the check lives here, and each has one home:
 * - `taskOwnerCheckDuty`: whether a Task owes the check, over which
 *   obligations, what each one's matrix test must reach at this stop, and
 *   whether the Task answers its findings. `helper owner-check`, the stop arm
 *   and the implementation brief all ask it.
 * - `taskOwnerCheckDigest`: the identity of what one run judged, over the
 *   Task's base, the owed obligations and the bytes of every family input.
 * - `taskOwnerCheckResult` / `taskOwnerCheckUnavailable`: the run's result,
 *   the gate's own `InvariantVerdict` per obligation, or why it could not run.
 * - `parseTaskOwnerCheckRecord` and `taskOwnerCheckRecordJson`: the record's
 *   wire form, parsed and never cast.
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
import { sha256Bytes, sha256Hex } from "./digest";
import { taskRolePolicy } from "./distill-task";
import { DECISION_RECORD_AGENT } from "./model-profiles";
import { failure, isNonEmpty, nonEmpty, success, type DomainResult, type NonEmpty } from "./orchestration-contract/identity";
import { compareStrings } from "./ordering";
import {
  contractTaskIdsOf,
  duePathsAtStop,
  isSettledAtStop,
  obligationsDigest,
  owesInWave,
  taskOwnerDuty,
} from "./owner-verification/obligations";
import { parseInvariantVerdicts } from "./owner-verification/parse";
import type { InvariantVerdict, OwnerObligation, OwnerVerificationFailure } from "./owner-verification/types";
import { invariantVerdictFailures, renderMutationVerdict, renderOwnerVerificationFailure } from "./owner-verification/verdict";
import { isRepoRelativePlanPath, normalizePlanPath } from "./plan-path-match";
import { invariantRoles } from "./plan-paths";
import { exactRecordErrors, isRecord, parseExactRecord, type UnknownRecord } from "./plain-record";
import type { TaskFileBytes } from "./task-mutation-check";
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
  | "nothing-owed";

/** The one line each off reason reads as. */
export const TASK_OWNER_CHECK_OFF_TEXT: Readonly<Record<TaskOwnerCheckOffReason, string>> = Object.freeze({
  "unknown-task": "the TaskGraph holds no such Task",
  "unstamped": "the TaskGraph carries no owner-obligation stamp",
  "exempt-role": "a Distill Task implements no owned rule",
  "decision-record-task": "an ADR Task writes a decision record, not code",
  "contract-task": "a Contract Task's stubs owe no owner verification",
  "nothing-owed": "no owned Invariant this Task touches is owed at its stop: the Wave owes none of them, or its owner or matrix test " +
    "is another Task of this Wave's work in flight, which the Wave Gate judges",
});

/** One obligation a Task owes at its stop. */
export type StopObligation = Readonly<{
  obligation: OwnerObligation;
  /** What the matrix test must reach at this stop (`duePathsAtStop`): the owner, then each settled sibling. */
  due: NonEmpty<string>;
  /** Whether the Task lists the matrix test: only the matrix test answers a missing path or a survivor. */
  answers: boolean;
}>;

/** A Task that owes the check: its obligations, its base, the runner and what the digest covers. */
export type OwedTaskOwnerCheck = Readonly<{
  kind: "owed";
  taskId: string;
  wave: number;
  /** The Task's base commit, or null when the Task records none. */
  startSha: string | null;
  /** The frozen runner; absent only when every owed obligation is mutation-exempt (population refuses otherwise). */
  runner: AffectedRunner | undefined;
  /** In stamp order. */
  obligations: NonEmpty<StopObligation>;
  /** Every path the digest covers, sorted and unique: each owner, due path and matrix test, and every file the Task declares. */
  digested: NonEmpty<string>;
}>;

export type TaskOwnerCheckDuty = Readonly<{ kind: "off"; reason: TaskOwnerCheckOffReason }> | OwedTaskOwnerCheck;

const off = (reason: TaskOwnerCheckOffReason): TaskOwnerCheckDuty => Object.freeze({ kind: "off", reason });

/** The graph the duty reads. */
export type TaskOwnerCheckGraph = Pick<TaskGraph, "tasks" | "acceptance_contracts" | "owner_obligations" | "verification_manifest">;

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
  const touched = taskOwnerDuty(graph, task.file_list ?? []);
  if (touched.kind === "unstamped") return off("unstamped");
  if (!taskRolePolicy(task).schedulesFamilies) return off("exempt-role");
  if (task.agent === DECISION_RECORD_AGENT) return off("decision-record-task");
  const contractTaskIds = contractTaskIdsOf(graph);
  if (contractTaskIds.has(task.id)) return off("contract-task");
  const fileList = task.file_list ?? [];
  const owed = nonEmpty(touched.touched
    .filter((obligation) =>
      owesInWave(graph.tasks, contractTaskIds, task.wave, obligation) &&
      isSettledAtStop(graph.tasks, task, obligation.owner) &&
      isSettledAtStop(graph.tasks, task, obligation.matrixTest))
    .map((obligation): StopObligation => Object.freeze({
      obligation,
      due: frozen(duePathsAtStop(graph.tasks, task, obligation)),
      answers: invariantRoles(fileList, obligation).matrixTest,
    })));
  if (owed === null) return off("nothing-owed");
  const declared = fileList.map(normalizePlanPath).filter(isRepoRelativePlanPath);
  // Never null: every owed obligation's due paths lead with its owner.
  const digested = nonEmpty([
    ...new Set([...owed.flatMap(({ obligation, due }) => [...due, obligation.matrixTest]), ...declared]),
  ].sort(compareStrings));
  if (digested === null) return off("nothing-owed");
  const startSha = task.start_sha === undefined || task.start_sha === "" ? null : task.start_sha;
  return Object.freeze({
    kind: "owed",
    taskId: task.id,
    wave: task.wave,
    startSha,
    runner: graph.verification_manifest?.affectedRunner,
    obligations: frozen(owed),
    digested: frozen(digested),
  });
}

/** A non-empty list frozen in place: `Object.freeze` would type it as `readonly T[]` and lose the tuple. */
function frozen<T>(list: NonEmpty<T>): NonEmpty<T> {
  Object.freeze(list);
  return list;
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

declare const TASK_OWNER_CHECK_DIGEST: unique symbol;

/** The identity of what one owner-check run judged: only `taskOwnerCheckDigest` and the record parser hold one. */
export type TaskOwnerCheckDigest = string & { readonly [TASK_OWNER_CHECK_DIGEST]: true };

const DIGEST = /^[0-9a-f]{64}$/;
const mintDigest = (hex: string): TaskOwnerCheckDigest => hex as TaskOwnerCheckDigest;

/**
 * The digest of a duty's base, its owed obligations (each with what its
 * matrix test must reach and whether the Task answers it) and the bytes of
 * the files given. Independent of the order the files are given in; any
 * change to the base, the obligations, the set of paths, a file's presence or
 * one byte changes it.
 */
export function taskOwnerCheckDigest(duty: OwedTaskOwnerCheck, files: readonly TaskFileBytes[]): TaskOwnerCheckDigest {
  const entries = files
    .map(({ path, bytes }): readonly [string, string | null] => [path, bytes === null ? null : sha256Bytes(bytes)])
    .sort(([left], [right]) => compareStrings(left, right));
  const obligations = duty.obligations.map(({ obligation, due, answers }) => [obligation.invariant, due, answers]);
  const stamp = obligationsDigest(duty.obligations.map(({ obligation }) => obligation));
  return mintDigest(sha256Hex(JSON.stringify(["loom-task-owner-check-digest-v1", duty.startSha, stamp, obligations, entries])));
}

// ---------------------------------------------------------------------------
// One run's result
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

/** The result of a run's verdicts: `unavailable` when it judged no obligation, which a run over an owed duty never does. */
export function taskOwnerCheckResult(verdicts: readonly InvariantVerdict[]): TaskOwnerCheckResult {
  const judged = nonEmpty(verdicts);
  return judged === null
    ? taskOwnerCheckUnavailable("the run judged no obligation")
    : Object.freeze({ kind: "verdicts", verdicts: frozen(judged) });
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export const TASK_OWNER_CHECK_RECORD_KIND = "loom-task-owner-check-record" as const;
export const TASK_OWNER_CHECK_RECORD_SCHEMA_VERSION = 1 as const;

/** What a Task's last owner-check run left: nothing (`not-run`), or its result bound to the digest of what it judged. */
export type TaskOwnerCheckRecord =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "recorded"; taskId: string; digest: TaskOwnerCheckDigest; result: TaskOwnerCheckResult }>;

export type RecordedTaskOwnerCheck = Extract<TaskOwnerCheckRecord, { kind: "recorded" }>;

export const TASK_OWNER_CHECK_NOT_RUN: TaskOwnerCheckRecord = Object.freeze({ kind: "not-run" });

export const recordedTaskOwnerCheck = (taskId: string, digest: TaskOwnerCheckDigest, result: TaskOwnerCheckResult): RecordedTaskOwnerCheck =>
  Object.freeze({ kind: "recorded", taskId, digest, result });

/** The record's wire document. Property order is fixed, so equal records serialize to equal bytes. */
export function taskOwnerCheckRecordJson({ taskId, digest, result }: RecordedTaskOwnerCheck): string {
  return JSON.stringify({
    schemaVersion: TASK_OWNER_CHECK_RECORD_SCHEMA_VERSION,
    kind: TASK_OWNER_CHECK_RECORD_KIND,
    taskId,
    digest,
    result,
  });
}

/** Null when `raw` holds exactly `keys`, or the refusal naming each missing and surplus key. */
function exactKeys(raw: Readonly<UnknownRecord>, keys: readonly string[], path: string): string | null {
  const shape = parseExactRecord(raw, keys, path);
  return shape.ok ? null : exactRecordErrors(shape, path, "an object").join("; ");
}

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
export function parseTaskOwnerCheckRecord(raw: unknown): DomainResult<RecordedTaskOwnerCheck, string> {
  const path = "taskOwnerCheckRecord";
  if (!isRecord(raw)) return failure(`${path} must be an object`);
  const shape = exactKeys(raw, ["schemaVersion", "kind", "taskId", "digest", "result"], path);
  if (shape !== null) return failure(shape);
  if (raw.schemaVersion !== TASK_OWNER_CHECK_RECORD_SCHEMA_VERSION) return failure(`${path}.schemaVersion must be ${TASK_OWNER_CHECK_RECORD_SCHEMA_VERSION}`);
  if (raw.kind !== TASK_OWNER_CHECK_RECORD_KIND) return failure(`${path}.kind must be "${TASK_OWNER_CHECK_RECORD_KIND}"`);
  if (typeof raw.taskId !== "string" || raw.taskId === "") return failure(`${path}.taskId must be a non-empty string`);
  if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) return failure(`${path}.digest must be a sha256 hex digest`);
  const result = parseResult(raw.result, `${path}.result`);
  return result.ok ? success(recordedTaskOwnerCheck(raw.taskId, mintDigest(raw.digest), result.value)) : result;
}

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

const isAnswerable = (failure: OwnerVerificationFailure): boolean => failure.kind === "missing-siblings" || failure.kind === "survivor";

/** A verdict the duty does not owe means the record is of another duty, which the digest already rules out: it is reported, never trusted. */
export function sortTaskOwnerFindings(duty: OwedTaskOwnerCheck, verdicts: readonly InvariantVerdict[]): TaskOwnerFindings {
  const blocking: OwnerVerificationFailure[] = [];
  const noted: string[] = [];
  for (const verdict of verdicts) {
    const owed = duty.obligations.find(({ obligation }) => obligation.invariant === verdict.invariant);
    if (owed === undefined) {
      noted.push(`${verdict.invariant}: the record judged an Invariant this Task does not owe at its stop`);
      continue;
    }
    for (const found of invariantVerdictFailures(verdict)) {
      if (owed.answers && isAnswerable(found)) blocking.push(found);
      else if (isAnswerable(found)) {
        noted.push(`${renderOwnerVerificationFailure(found)} (only ${verdict.matrixTest} answers this, and this Task does not list it)`);
      } else noted.push(renderOwnerVerificationFailure(found));
    }
  }
  return Object.freeze({ blocking: Object.freeze(blocking), noted: Object.freeze(noted) });
}

// ---------------------------------------------------------------------------
// The stop
// ---------------------------------------------------------------------------

/** How a Task's record stands against its family now: its result, when it judged these very bytes. */
export type TaskOwnerCheckStanding =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "current"; result: TaskOwnerCheckResult }>;

/** The record's standing for `taskId` at `digest`: a record of another Task or of other bytes is stale. */
export function taskOwnerCheckStanding(record: TaskOwnerCheckRecord, taskId: string, digest: TaskOwnerCheckDigest): TaskOwnerCheckStanding {
  if (record.kind === "not-run") return Object.freeze({ kind: "not-run" });
  return record.taskId === taskId && record.digest === digest
    ? Object.freeze({ kind: "current", result: record.result })
    : Object.freeze({ kind: "stale" });
}

/** What a stop shell observed for the owner arm: the Task owes nothing, its record's standing with the refreshing command, or a fault. */
export type TaskOwnerCheckObservation =
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "observed"; duty: OwedTaskOwnerCheck; standing: TaskOwnerCheckStanding; command: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** The observation of a stop that asks nothing of the owner arm. */
export const NO_TASK_OWNER_CHECK: TaskOwnerCheckObservation = Object.freeze({ kind: "off" });

/** Why the owner arm would hold a stop open. */
export type TaskOwnerCheckBlockCause =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "findings"; findings: NonEmpty<OwnerVerificationFailure>; noted: readonly string[] }>;

/**
 * The arm's verdict at one stop. It blocks for a check that never ran, ran
 * over other bytes, or left a finding the Task answers; a current record with
 * no finding passes; a record whose findings the Task does not answer, an
 * unavailable run and every fault is a note, and the stop proceeds.
 */
export type TaskOwnerCheckStopVerdict =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "note"; note: string }>
  | Readonly<{ kind: "failing"; cause: TaskOwnerCheckBlockCause; command: string }>;

const proceeds = (taskId: string, why: string): TaskOwnerCheckStopVerdict =>
  Object.freeze({ kind: "note", note: `Task owner check for ${taskId} did not hold the stop (${why}); the stop proceeds and the Wave Gate judges` });

export function taskOwnerCheckStopVerdict(taskId: string, observation: TaskOwnerCheckObservation): TaskOwnerCheckStopVerdict {
  if (observation.kind === "off") return Object.freeze({ kind: "idle" });
  if (observation.kind === "unavailable") return proceeds(taskId, observation.reason);
  const { duty, standing, command } = observation;
  if (standing.kind !== "current") return Object.freeze({ kind: "failing", cause: standing, command });
  const { result } = standing;
  if (result.kind === "unavailable") return proceeds(taskId, `its last run was unavailable: ${result.reason}`);
  const { blocking, noted } = sortTaskOwnerFindings(duty, result.verdicts);
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
const verdictSummary = (verdict: InvariantVerdict): string => {
  const coverage = match(verdict.coverage)
    .with({ kind: "covered" }, () => "coverage reaches every path due at this stop")
    .with({ kind: "missing" }, ({ paths }) => `coverage misses ${paths.join(", ")}`)
    .with({ kind: "infrastructure" }, ({ failure: cause }) => `coverage infrastructure failure (${cause.kind}): ${cause.detail}`)
    .exhaustive();
  return `- ${verdict.invariant} (matrix test ${verdict.matrixTest}): ${coverage}; ${renderMutationVerdict(verdict.mutation)}`;
};

/** What `helper owner-check` prints for one run. */
export function renderTaskOwnerCheckReport(duty: OwedTaskOwnerCheck, result: TaskOwnerCheckResult): string {
  const head = `Task owner check for ${duty.taskId}:`;
  if (result.kind === "unavailable") return `${head} unavailable — ${result.reason}. It did not decide and will not block your stop.`;
  const { blocking, noted } = sortTaskOwnerFindings(duty, result.verdicts);
  const summary = result.verdicts.map(verdictSummary);
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
