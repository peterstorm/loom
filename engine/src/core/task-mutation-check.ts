/**
 * The Task mutation check's pure core (ADR-0071): while an implementer still
 * holds its context, the engine mutates the lines its Task changed and names
 * every mutant the Task's tests did not kill, so the missing test is written
 * before the stop rather than found at the Wave Gate or in review.
 *
 * Every decision of the check lives here, and each has one home:
 * - `taskMutationDuty`: whether a Task owes the check at all, and over which
 *   files. `helper mutation-check` and the stop arm both ask it, so they
 *   cannot disagree about what the check covers.
 * - `taskMutationDigest`: the identity of what one run judged, over the Task's
 *   base and the bytes of every declared file. The record a run writes carries
 *   it; a stop recomputes it, so a record of other bytes is `stale`.
 * - `classifyTaskBaseline` and `classifyTaskMutantRun`: what one runner
 *   execution says. A red or unobservable baseline is never a survivor: a
 *   sibling Task's half-written bytes make the whole run `unavailable`.
 * - `taskMutationResultOf`: the tally of one run.
 * - `parseTaskMutationRecord` and `taskMutationRecordJson`: the record's wire
 *   form, parsed and never cast.
 * - `taskMutationStopVerdict` and the two renderers: what a stop does with
 *   the record it finds, and what the implementer reads.
 *
 * Nothing here is completion evidence. The record is a runtime file beside
 * the stop checks' block counters; no value below reaches Proof, a receipt or
 * the Wave Gate, whose own Owner Verification (ADR-0036) is unchanged.
 *
 * Pure and total: no I/O, no clock, no throw.
 */

import { match } from "ts-pattern";
import type { AcceptanceExpectation } from "./acceptance-contract/gate";
import { judgeAffectedRun } from "./affected-stop-check";
import { sha256Bytes, sha256Hex } from "./digest";
import { taskRolePolicy } from "./distill-task";
import { DECISION_RECORD_AGENT } from "./model-profiles";
import { failure, isNonEmpty, nonEmpty, success, type DomainResult, type NonEmpty } from "./orchestration-contract/identity";
import { compareStrings } from "./ordering";
import { TASK_MUTATION_OPERATORS, type TaskMutant, type TaskMutationOperator } from "./owner-verification/mutation-plan";
import { contractTaskIdsOf } from "./owner-verification/obligations";
import type { MatrixTestRun } from "./owner-verification/types";
import { isRepoRelativePlanPath, normalizePlanPath } from "./plan-path-match";
import { parseJunitTestcases } from "./structured-test-report";
import { frozenRedThenGreenEra } from "./proof-obligations";
import { quoteShellArgument } from "./shell-quoting";
import { isTestFileBySuffixes } from "./test-file-classification";
import { taskMutationCheckSetting, type AffectedRunner } from "./verification-manifest";
import type { TaskGraph } from "../types";

/** The longest one `helper mutation-check` run may take; a run it cannot fit is `unavailable`. */
export const TASK_MUTATION_DEADLINE_MS = 480_000;

/** The tool-call timeout an implementer gives the helper: the deadline, plus room to open and remove its worktrees. */
export const TASK_MUTATION_BASH_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// The duty
// ---------------------------------------------------------------------------

const MUTABLE_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const DECLARATION_FILE = /\.d\.[mc]?ts$/;

/** Whether the mutation operators can read `path`: TypeScript or JavaScript source, never a declaration file. */
export const isMutableSource = (path: string): boolean =>
  MUTABLE_SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) && !DECLARATION_FILE.test(path);

/** Why a Task owes no mutation check. Exactly one applies, in this precedence. */
export type TaskMutationOffReason =
  | "unknown-task"
  /** The operator's manifest sets `taskMutationCheck: "off"`. */
  | "switched-off"
  /** No `affectedRunner` is frozen, so nothing can run a mutant. */
  | "no-affected-runner"
  /** The manifest froze no Test-File Classification, so no implementation file can be told from a test. */
  | "no-frozen-classification"
  /** The Task's role is exempt (`TaskRolePolicy.taskMutationCheck`): a Distill Task. */
  | "exempt-role"
  /** An ADR Task writes a decision record, not code. */
  | "decision-record-task"
  /** A Contract Task writes the oracle and stubs the engine replaces. */
  | "contract-task"
  /** No declared implementation file is TypeScript or JavaScript beneath the runner's cwd. */
  | "no-mutable-files";

/** The one line each off reason reads as. */
export const TASK_MUTATION_OFF_TEXT: Readonly<Record<TaskMutationOffReason, string>> = Object.freeze({
  "unknown-task": "the TaskGraph holds no such Task",
  "switched-off": "the verification manifest sets taskMutationCheck to \"off\"",
  "no-affected-runner": "no affectedRunner is frozen in this TaskGraph, so no mutant can be run",
  "no-frozen-classification": "the verification manifest froze no test-file classification, so no implementation file can be told from a test",
  "exempt-role": "a Distill Task writes no test, so it owes no mutation check",
  "decision-record-task": "an ADR Task writes a decision record, not code",
  "contract-task": "a Contract Task writes the oracle, which nothing mutates",
  "no-mutable-files": "the Task declares no TypeScript or JavaScript implementation file beneath the affected runner's cwd",
});

/** A Task that owes the check: what is mutated, what the digest covers, and what runs the mutants. */
export type OwedTaskMutation = Readonly<{
  kind: "owed";
  taskId: string;
  wave: number;
  /** The Task's base commit, or null when the Task records none. */
  startSha: string | null;
  runner: AffectedRunner;
  /** The declared implementation files the operators can read, in `file_list` order. */
  mutable: NonEmpty<string>;
  /** Every declared file, tests included, in `file_list` order: what the digest covers. */
  declared: NonEmpty<string>;
}>;

export type TaskMutationDuty = Readonly<{ kind: "off"; reason: TaskMutationOffReason }> | OwedTaskMutation;

const off = (reason: TaskMutationOffReason): TaskMutationDuty => Object.freeze({ kind: "off", reason });

const beneath = (cwd: string, path: string): boolean => cwd === "." || path.startsWith(`${cwd}/`);

/**
 * Whether `taskId` owes the Task mutation check under `graph`, and over which
 * files. The files are the Task's own `file_list`, never a sibling's: its
 * implementation files (under the frozen Test-File Classification) that the
 * operators can read and the affected runner can reach are mutated, and every
 * declared file, tests included, is digested.
 */
export function taskMutationDuty(
  graph: Pick<TaskGraph, "tasks" | "verification_manifest" | "acceptance_contracts">,
  taskId: string,
): TaskMutationDuty {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) return off("unknown-task");
  const manifest = graph.verification_manifest;
  if (taskMutationCheckSetting(manifest) === "off") return off("switched-off");
  const runner = manifest?.affectedRunner;
  if (runner === undefined) return off("no-affected-runner");
  const era = frozenRedThenGreenEra(manifest);
  if (era.kind === "not-owed") return off("no-frozen-classification");
  if (taskRolePolicy(task).taskMutationCheck === "exempt") return off("exempt-role");
  if (task.agent === DECISION_RECORD_AGENT) return off("decision-record-task");
  if (contractTaskIdsOf(graph).has(task.id)) return off("contract-task");
  const { suffixes } = era.testFiles;
  const declared = nonEmpty([...new Set((task.file_list ?? []).map(normalizePlanPath).filter(isRepoRelativePlanPath))]);
  const mutable = nonEmpty((declared ?? []).filter((path) =>
    isMutableSource(path) && !isTestFileBySuffixes(path, suffixes) && beneath(runner.cwd, path)));
  if (declared === null || mutable === null) return off("no-mutable-files");
  const startSha = task.start_sha === undefined || task.start_sha === "" ? null : task.start_sha;
  return Object.freeze({ kind: "owed", taskId: task.id, wave: task.wave, startSha, runner, mutable, declared });
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

declare const TASK_MUTATION_DIGEST: unique symbol;

/** The identity of what one mutation run judged: only `taskMutationDigest` and the record parser hold one. */
export type TaskMutationDigest = string & { readonly [TASK_MUTATION_DIGEST]: true };

const DIGEST = /^[0-9a-f]{64}$/;
const mintDigest = (hex: string): TaskMutationDigest => hex as TaskMutationDigest;

/** One declared file as a run saw it: its bytes, or null when it does not exist. */
export type TaskFileBytes = Readonly<{ path: string; bytes: Uint8Array | null }>;

/**
 * The digest of a Task's base and declared files. It is independent of the
 * order the files are given in, and it changes when the base, the set of
 * paths, a file's presence or a single byte of a file changes.
 */
export function taskMutationDigest(startSha: string | null, files: readonly TaskFileBytes[]): TaskMutationDigest {
  const entries = files
    .map(({ path, bytes }): readonly [string, string | null] => [path, bytes === null ? null : sha256Bytes(bytes)])
    .sort(([left], [right]) => compareStrings(left, right));
  return mintDigest(sha256Hex(JSON.stringify(["loom-task-mutation-digest-v1", startSha, entries])));
}

// ---------------------------------------------------------------------------
// One runner execution
// ---------------------------------------------------------------------------

/**
 * The unmutated run over one file. `untested` is a report that ran no
 * testcase: every mutant of the file survives without being run. `red` and
 * `unobservable` end the whole check as `unavailable`.
 */
export type TaskBaseline =
  | Readonly<{ kind: "green" }>
  | Readonly<{ kind: "untested" }>
  | Readonly<{ kind: "red"; failures: NonEmpty<string> }>
  | Readonly<{ kind: "unobservable"; reason: string }>;

/** What one mutant's run says. `invalid` is a mutant that only broke collection, or ran no test: it is no evidence either way. */
export type TaskMutantOutcome =
  | Readonly<{ kind: "killed" }>
  | Readonly<{ kind: "survived" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "unobservable"; reason: string }>;

const unobservable = (reason: string): Readonly<{ kind: "unobservable"; reason: string }> => Object.freeze({ kind: "unobservable", reason });

/** The report one execution left, or why there is none to judge. */
function reportOf(run: Extract<MatrixTestRun, { kind: "exited" }>): DomainResult<Uint8Array, string> {
  const { report } = run;
  if (report.kind === "missing") {
    return failure(`the runner exited (code ${String(run.exitCode)}, signal ${String(run.signal)}) without writing its report; it may have found no test for the file`);
  }
  return report.kind === "unreadable" ? failure(`the runner's report could not be read: ${report.reason}`) : success(report.bytes);
}

/**
 * The baseline of one file. The report is judged by the affected stop check's
 * own judge, so a failure the Wave Gate excuses as expected RED is not red
 * here either.
 */
export function classifyTaskBaseline(run: MatrixTestRun, expectation: AcceptanceExpectation): TaskBaseline {
  if (run.kind === "spawn-failed") return unobservable(`the runner could not start: ${run.message}`);
  if (run.kind === "timed-out") return unobservable(`the unmutated run exceeded its time limit after ${run.elapsedMs} ms`);
  const report = reportOf(run);
  if (!report.ok) return unobservable(report.error);
  const verdict = judgeAffectedRun(parseJunitTestcases(report.value), expectation);
  switch (verdict.kind) {
    case "passed":
      return Object.freeze({ kind: verdict.observed === "zero-tests" ? "untested" : "green" });
    case "excused":
      return Object.freeze({ kind: "green" });
    case "failing": {
      const [first, ...rest] = verdict.testcases;
      return Object.freeze({ kind: "red", failures: [first, ...rest].map(({ name, file }) => `'${name}' (${file})`) as [string, ...string[]] });
    }
    case "unobservable":
      return unobservable(verdict.reason);
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

const KILLED: TaskMutantOutcome = Object.freeze({ kind: "killed" });
const SURVIVED: TaskMutantOutcome = Object.freeze({ kind: "survived" });
const INVALID: TaskMutantOutcome = Object.freeze({ kind: "invalid" });

/**
 * One mutant's run, after a green baseline. A timeout is a kill: the mutant
 * changed what the tests do. A run whose every failure is a collection error,
 * or that ran no testcase, is `invalid`.
 */
export function classifyTaskMutantRun(run: MatrixTestRun, expectation: AcceptanceExpectation): TaskMutantOutcome {
  if (run.kind === "spawn-failed") return unobservable(`the runner could not start: ${run.message}`);
  if (run.kind === "timed-out") return KILLED;
  const report = reportOf(run);
  if (!report.ok) return unobservable(report.error);
  const verdict = judgeAffectedRun(parseJunitTestcases(report.value), expectation);
  switch (verdict.kind) {
    case "passed":
      return verdict.observed === "zero-tests" ? INVALID : SURVIVED;
    case "excused":
      return SURVIVED;
    case "failing":
      return verdict.testcases.every(({ outcome }) => outcome === "collection-error") ? INVALID : KILLED;
    case "unobservable":
      return unobservable(verdict.reason);
    default: {
      const unreachable: never = verdict;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// One run's result
// ---------------------------------------------------------------------------

/** One file's mutants, in plan order. */
export type FileMutants = Readonly<{ path: string; mutants: NonEmpty<TaskMutant> }>;

/** The selected mutants grouped by the file they rewrite, files in first-mutant order. */
export function mutantsByFile(mutants: readonly TaskMutant[]): readonly FileMutants[] {
  const paths = [...new Set(mutants.map(({ path }) => path))];
  return Object.freeze(paths.flatMap((path): readonly FileMutants[] => {
    const own = nonEmpty(mutants.filter((mutant) => mutant.path === path));
    return own === null ? [] : [Object.freeze({ path, mutants: own })];
  }));
}

/**
 * A mutant the Task's tests did not kill. `coverage` says whether any test ran
 * for its file: `untested` is a mutant of a file whose baseline ran none.
 */
export type TaskSurvivor = Readonly<{
  path: string;
  line: number;
  column: number;
  operator: TaskMutationOperator;
  original: string;
  replacement: string;
  coverage: "tested" | "untested";
}>;

/** What one mutant of a run came to, once its file's baseline was green or untested. */
export type TaskMutantRun = Readonly<{ mutant: TaskMutant; outcome: "killed" | "invalid" | "survived" | "untested" }>;

/**
 * What one `helper mutation-check` run found. `mutants` counts the mutants
 * selected and `candidates` the sites they were chosen from. `unavailable` is
 * a run that could not decide, and it never blocks.
 */
export type TaskMutationResult =
  | Readonly<{ kind: "clean"; mutants: number; candidates: number }>
  | Readonly<{ kind: "survivors"; mutants: number; candidates: number; survivors: NonEmpty<TaskSurvivor> }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export const taskMutationUnavailable = (reason: string): TaskMutationResult => Object.freeze({ kind: "unavailable", reason });

const survivorOf = ({ mutant, outcome }: TaskMutantRun): readonly TaskSurvivor[] =>
  outcome === "killed" || outcome === "invalid" ? [] : [Object.freeze({
    path: mutant.path,
    line: mutant.line,
    column: mutant.column,
    operator: mutant.operator,
    original: mutant.original,
    replacement: mutant.replacement,
    coverage: outcome === "untested" ? "untested" : "tested",
  })];

/** The result of a run that judged every selected mutant: its survivors, or clean when there are none. */
export function taskMutationResultOf(runs: readonly TaskMutantRun[], candidates: number): TaskMutationResult {
  const survivors = nonEmpty(runs.flatMap(survivorOf));
  return survivors === null
    ? Object.freeze({ kind: "clean", mutants: runs.length, candidates })
    : Object.freeze({ kind: "survivors", mutants: runs.length, candidates, survivors });
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export const TASK_MUTATION_RECORD_KIND = "loom-task-mutation-record" as const;
export const TASK_MUTATION_RECORD_SCHEMA_VERSION = 1 as const;

/**
 * What a Task's last mutation run left: nothing (`not-run`), or its result
 * bound to the digest of the bytes it judged.
 */
export type TaskMutationRecord =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "recorded"; taskId: string; digest: TaskMutationDigest; result: TaskMutationResult }>;

export type RecordedTaskMutation = Extract<TaskMutationRecord, { kind: "recorded" }>;

export const TASK_MUTATION_NOT_RUN: TaskMutationRecord = Object.freeze({ kind: "not-run" });

export const recordedTaskMutation = (taskId: string, digest: TaskMutationDigest, result: TaskMutationResult): RecordedTaskMutation =>
  Object.freeze({ kind: "recorded", taskId, digest, result });

/** The record's wire document. Property order is fixed, so equal records serialize to equal bytes. */
export function taskMutationRecordJson({ taskId, digest, result }: RecordedTaskMutation): string {
  return JSON.stringify({
    schemaVersion: TASK_MUTATION_RECORD_SCHEMA_VERSION,
    kind: TASK_MUTATION_RECORD_KIND,
    taskId,
    digest,
    result,
  });
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const isRecord = (raw: unknown): raw is UnknownRecord => typeof raw === "object" && raw !== null && !Array.isArray(raw);
const isCount = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
const isPosition = (raw: unknown): raw is number => isCount(raw) && raw > 0;
const isText = (raw: unknown): raw is string => typeof raw === "string" && raw !== "";

/** The keys a record of this shape holds, or the refusal naming any other. */
function exactKeys(raw: UnknownRecord, keys: readonly string[], path: string): string | null {
  const unknown = Object.keys(raw).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in raw));
  if (unknown.length > 0) return `${path} has unknown key(s) ${unknown.join(", ")}`;
  return missing.length > 0 ? `${path} lacks ${missing.join(", ")}` : null;
}

function parseSurvivor(raw: unknown, path: string): DomainResult<TaskSurvivor, string> {
  if (!isRecord(raw)) return failure(`${path} must be an object`);
  const shape = exactKeys(raw, ["path", "line", "column", "operator", "original", "replacement", "coverage"], path);
  if (shape !== null) return failure(shape);
  const operator = TASK_MUTATION_OPERATORS.find((candidate) => candidate === raw.operator);
  const coverage = (["tested", "untested"] as const).find((candidate) => candidate === raw.coverage);
  if (!isText(raw.path) || !isRepoRelativePlanPath(raw.path)) return failure(`${path}.path must be a repository-relative path`);
  if (!isPosition(raw.line) || !isPosition(raw.column)) return failure(`${path}.line and ${path}.column must be positive integers`);
  if (operator === undefined) return failure(`${path}.operator must be one of ${TASK_MUTATION_OPERATORS.join(", ")}`);
  if (typeof raw.original !== "string" || typeof raw.replacement !== "string") return failure(`${path}.original and ${path}.replacement must be strings`);
  if (coverage === undefined) return failure(`${path}.coverage must be "tested" or "untested"`);
  return success(Object.freeze({
    path: raw.path, line: raw.line, column: raw.column, operator, original: raw.original, replacement: raw.replacement, coverage,
  }));
}

function parseCounts(raw: UnknownRecord, path: string): DomainResult<Readonly<{ mutants: number; candidates: number }>, string> {
  const { mutants, candidates } = raw;
  if (!isCount(mutants) || !isCount(candidates)) return failure(`${path}.mutants and ${path}.candidates must be non-negative integers`);
  return mutants > candidates
    ? failure(`${path}.mutants (${mutants}) exceeds ${path}.candidates (${candidates})`)
    : success({ mutants, candidates });
}

function parseSurvivorsResult(raw: UnknownRecord, path: string): DomainResult<TaskMutationResult, string> {
  const counts = parseCounts(raw, path);
  if (!counts.ok) return counts;
  if (!Array.isArray(raw.survivors as unknown)) return failure(`${path}.survivors must be an array`);
  const survivors: TaskSurvivor[] = [];
  for (const [index, entry] of (raw.survivors as readonly unknown[]).entries()) {
    const survivor = parseSurvivor(entry, `${path}.survivors[${index}]`);
    if (!survivor.ok) return survivor;
    survivors.push(survivor.value);
  }
  if (!isNonEmpty(survivors)) return failure(`${path}.survivors must name at least one survivor`);
  return survivors.length > counts.value.mutants
    ? failure(`${path}.survivors names more survivors than ${path}.mutants`)
    : success(Object.freeze({ kind: "survivors", ...counts.value, survivors: Object.freeze(survivors) }));
}

function parseResult(raw: unknown, path: string): DomainResult<TaskMutationResult, string> {
  if (!isRecord(raw)) return failure(`${path} must be an object`);
  // The kind is a wire value the type system does not own, so the fallback names the unknown-kind arm.
  return match(raw.kind)
    .returnType<DomainResult<TaskMutationResult, string>>()
    .with("clean", () => {
      const shape = exactKeys(raw, ["kind", "mutants", "candidates"], path);
      if (shape !== null) return failure(shape);
      const counts = parseCounts(raw, path);
      return counts.ok ? success(Object.freeze({ kind: "clean", ...counts.value })) : counts;
    })
    .with("survivors", () => {
      const shape = exactKeys(raw, ["kind", "mutants", "candidates", "survivors"], path);
      return shape === null ? parseSurvivorsResult(raw, path) : failure(shape);
    })
    .with("unavailable", () => {
      const shape = exactKeys(raw, ["kind", "reason"], path);
      if (shape !== null) return failure(shape);
      return isText(raw.reason) ? success(taskMutationUnavailable(raw.reason)) : failure(`${path}.reason must be a non-empty string`);
    })
    .otherwise(() => failure(`${path}.kind must be "clean", "survivors" or "unavailable"`));
}

/** A record document as a record, or the first reason it is not one. */
export function parseTaskMutationRecord(raw: unknown): DomainResult<RecordedTaskMutation, string> {
  const path = "taskMutationRecord";
  if (!isRecord(raw)) return failure(`${path} must be an object`);
  const shape = exactKeys(raw, ["schemaVersion", "kind", "taskId", "digest", "result"], path);
  if (shape !== null) return failure(shape);
  if (raw.schemaVersion !== TASK_MUTATION_RECORD_SCHEMA_VERSION) return failure(`${path}.schemaVersion must be ${TASK_MUTATION_RECORD_SCHEMA_VERSION}`);
  if (raw.kind !== TASK_MUTATION_RECORD_KIND) return failure(`${path}.kind must be "${TASK_MUTATION_RECORD_KIND}"`);
  if (!isText(raw.taskId)) return failure(`${path}.taskId must be a non-empty string`);
  if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) return failure(`${path}.digest must be a sha256 hex digest`);
  const result = parseResult(raw.result, `${path}.result`);
  return result.ok ? success(recordedTaskMutation(raw.taskId, mintDigest(raw.digest), result.value)) : result;
}

// ---------------------------------------------------------------------------
// The stop
// ---------------------------------------------------------------------------

/** How a Task's record stands against its files now: its result, when it judged these very bytes. */
export type TaskMutationStanding =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "current"; result: TaskMutationResult }>;

/** The record's standing for `taskId` at `digest`: a record of another Task or of other bytes is stale. */
export function taskMutationStanding(record: TaskMutationRecord, taskId: string, digest: TaskMutationDigest): TaskMutationStanding {
  if (record.kind === "not-run") return Object.freeze({ kind: "not-run" });
  return record.taskId === taskId && record.digest === digest
    ? Object.freeze({ kind: "current", result: record.result })
    : Object.freeze({ kind: "stale" });
}

/**
 * What a stop shell observed for the mutation arm: the Task owes nothing, or
 * its record's standing with the command that refreshes it, or the fault that
 * kept the shell from reading either.
 */
export type TaskMutationObservation =
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "observed"; standing: TaskMutationStanding; command: string }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** The observation of a stop that asks nothing of the mutation arm. */
export const NO_TASK_MUTATION_CHECK: TaskMutationObservation = Object.freeze({ kind: "off" });

/** Why the mutation arm would hold a stop open. */
export type TaskMutationBlockCause =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "survivors"; survivors: NonEmpty<TaskSurvivor> }>;

/**
 * The arm's verdict at one stop. It blocks for a check that never ran, ran
 * over other bytes, or left survivors; a clean record passes; a run that
 * could not decide, and every fault, is a note and the stop proceeds.
 */
export type TaskMutationStopVerdict =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "note"; note: string }>
  | Readonly<{ kind: "failing"; cause: TaskMutationBlockCause; command: string }>;

const proceeds = (taskId: string, why: string): TaskMutationStopVerdict =>
  Object.freeze({ kind: "note", note: `Task mutation check for ${taskId} did not decide (${why}); the stop proceeds` });

export function taskMutationStopVerdict(taskId: string, observation: TaskMutationObservation): TaskMutationStopVerdict {
  if (observation.kind === "off") return Object.freeze({ kind: "idle" });
  if (observation.kind === "unavailable") return proceeds(taskId, observation.reason);
  const { standing, command } = observation;
  if (standing.kind !== "current") return Object.freeze({ kind: "failing", cause: standing, command });
  const { result } = standing;
  switch (result.kind) {
    case "clean":
      return Object.freeze({ kind: "passed" });
    case "unavailable":
      return proceeds(taskId, `its last run was unavailable: ${result.reason}`);
    case "survivors":
      return Object.freeze({ kind: "failing", cause: Object.freeze({ kind: "survivors", survivors: result.survivors }), command });
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// What the implementer reads
// ---------------------------------------------------------------------------

/** The test that kills a surviving mutant of each operator. */
export const KILLING_TEST: Readonly<Record<TaskMutationOperator, string>> = Object.freeze({
  "guard-removal": "a test that makes the guard's condition true and asserts the exit it causes (the throw, or what the early return yields)",
  "condition-negation": "a test for each branch of the condition, asserting what differs between them",
  "comparison-flip": "a test at the boundary value, on both sides of the comparison",
  "logical-swap": "a test in which exactly one operand holds, so `&&` and `||` disagree",
  "boolean-literal-flip": "a test that asserts the behaviour this literal selects",
  "return-value-replacement": "a test that asserts the returned value, not only that the call completes",
  "statement-removal": "a test that asserts the effect of this statement",
});

/**
 * The one command that runs the check for `taskId`, from the repository the
 * TaskGraph lives in, through the Loom package at `packageRoot`. The brief and
 * a block both print it, so an implementer is never told two forms.
 */
export const taskMutationCommand = (packageRoot: string, taskId: string): string =>
  `bun ${quoteShellArgument(`${packageRoot}/engine/src/cli.ts`)} helper mutation-check --task ${quoteShellArgument(taskId)}`;

const SNIPPET_CHARS = 120;

/** Source text on one line, cut to `SNIPPET_CHARS`. */
const snippet = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_CHARS ? flat : `${flat.slice(0, SNIPPET_CHARS)}…`;
};

/** One survivor as both the helper and a block name it: where, which operator, the change, and the test that kills it. */
export function renderTaskSurvivor({ path, line, column, operator, original, replacement, coverage }: TaskSurvivor): string {
  return [
    `- ${path}:${line}:${column} ${operator}: \`${snippet(original)}\` → \`${snippet(replacement)}\`` +
      (coverage === "untested" ? " (no test ran for this file)" : ""),
    `  killed by: ${KILLING_TEST[operator]}`,
  ].join("\n");
}

const ANSWER_SURVIVORS =
  "For each survivor, add the test that kills it and run the check again, or, when no test can tell the mutant from your code " +
  "(an equivalent mutant), name it and say why in your final report.";

/** What `helper mutation-check` prints for one run. */
export function renderTaskMutationReport(taskId: string, result: TaskMutationResult): string {
  switch (result.kind) {
    case "clean":
      return result.mutants === 0
        ? `Task mutation check for ${taskId}: clean — no mutants (no mutation site on a line this Task changed).`
        : `Task mutation check for ${taskId}: clean — your tests killed all ${result.mutants} mutant(s) (of ${result.candidates} site(s) on changed lines).`;
    case "survivors":
      return [
        `Task mutation check for ${taskId}: ${result.survivors.length} of ${result.mutants} mutant(s) survived (of ${result.candidates} site(s) on changed lines).`,
        ...result.survivors.map(renderTaskSurvivor),
        ANSWER_SURVIVORS,
      ].join("\n");
    case "unavailable":
      return `Task mutation check for ${taskId}: unavailable — ${result.reason}. It did not decide and will not block your stop.`;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

const blockCauseLines = (cause: TaskMutationBlockCause): readonly string[] =>
  match(cause)
    .with({ kind: "not-run" }, () => ["The check has not run for this Task."])
    .with({ kind: "stale" }, () => ["Your files changed after the check last ran, so its result is of other bytes."])
    .with({ kind: "survivors" }, ({ survivors }) =>
      ["Mutants of your changed lines survived your tests:", ...survivors.map(renderTaskSurvivor), ANSWER_SURVIVORS])
    .exhaustive();

/** The mutation arm's part of a block message: why it blocks, and the one command that answers it. */
export function renderTaskMutationBlock(cause: TaskMutationBlockCause, command: string, blocksRemaining: number): string {
  return [
    "LOOM TASK MUTATION CHECK: your Task's changed lines are not yet answered by its tests.",
    ...blockCauseLines(cause),
    "",
    `Run it as one Bash call with a timeout of ${TASK_MUTATION_BASH_TIMEOUT_MS} ms, then your final verification run:`,
    `  ${command}`,
    `This check blocks at most ${blocksRemaining} more time(s); after that your stop proceeds and the Wave Gate judges.`,
  ].join("\n");
}
