/**
 * The Task mutation check's pure core (ADR-0071): while an implementer still
 * holds its context, the engine mutates the lines its Task changed and names
 * every mutant the Task's tests did not kill, so the missing test is written
 * before the stop rather than found at the Wave Gate or in review.
 *
 * Every decision of the check lives here, and each has one home:
 * - `taskMutationDuty`: whether a Task owes the check at all, and over which
 *   files. `helper mutation-check`, the stop arm and the implementation brief
 *   (`taskMutationSection` in `core/implementation-brief.ts`) all ask it, so
 *   they cannot disagree about what the check covers.
 * - `taskMutationDigest`: the identity of what one run judged, over the Task's
 *   base and the bytes of every declared file. The record a run writes carries
 *   it; a stop recomputes it, so a record of other bytes is `stale`.
 * - `classifyTaskBaseline` and `classifyTaskMutantRun`: what one runner
 *   execution says. A red or unobservable baseline is never a survivor: a
 *   sibling Task's half-written bytes make the whole run `unavailable`.
 * - `taskMutationResult`: the one constructor of a run's result, which the
 *   tally of a run (`taskMutationResultOf`) and the record parser share. A
 *   result names what the run could judge: `clean` only when the tests killed
 *   at least one mutant and none survived, `inconclusive` when every mutant
 *   was no evidence either way, never "clean" over nothing judged.
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
import type { AffectedRunVerdict } from "./affected-stop-check-types";
import { sha256Bytes, sha256Hex } from "./digest";
import { taskRolePolicy } from "./distill-task";
import { loomHelperCommand } from "./loom-cli-command";
import { DECISION_RECORD_AGENT } from "./model-profiles";
import { failure, isNonEmpty, mapNonEmpty, nonEmpty, success, type DomainResult, type NonEmpty } from "./orchestration-contract/identity";
import { compareStrings } from "./ordering";
import { TASK_MUTATION_OPERATORS, type TaskMutant, type TaskMutationOperator } from "./owner-verification/mutation-plan";
import { contractTaskIdsOf } from "./owner-verification/obligations";
import type { MatrixTestRun } from "./owner-verification/types";
import { isRepoRelativePlanPath, normalizePlanPath } from "./plan-path-match";
import { isRecord, type UnknownRecord } from "./plain-record";
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

/** A verdict on a report the judge could read. */
type ReadVerdict = Exclude<AffectedRunVerdict, { kind: "unobservable" }>;

/**
 * What every classifier reads first: the run timed out, could not be
 * observed (no start, no readable report, a report the judge cannot read), or
 * its report's verdict. The report is judged by the affected stop check's own
 * judge, so a failure the Wave Gate excuses as expected RED is no failure
 * here either. A timeout is left to the caller: a baseline and a mutant read
 * it oppositely.
 */
type JudgedRun =
  | Readonly<{ kind: "timed-out"; elapsedMs: number }>
  | Readonly<{ kind: "unobservable"; reason: string }>
  | Readonly<{ kind: "judged"; verdict: ReadVerdict }>;

function judgedRun(run: MatrixTestRun, expectation: AcceptanceExpectation): JudgedRun {
  if (run.kind === "spawn-failed") return unobservable(`the runner could not start: ${run.message}`);
  if (run.kind === "timed-out") return run;
  const report = reportOf(run);
  if (!report.ok) return unobservable(report.error);
  const verdict = judgeAffectedRun(parseJunitTestcases(report.value), expectation);
  return verdict.kind === "unobservable" ? unobservable(verdict.reason) : Object.freeze({ kind: "judged", verdict });
}

const GREEN: TaskBaseline = Object.freeze({ kind: "green" });
const UNTESTED: TaskBaseline = Object.freeze({ kind: "untested" });

/** The baseline of one file. A timeout leaves it unobservable: nothing it ran can be trusted. */
export function classifyTaskBaseline(run: MatrixTestRun, expectation: AcceptanceExpectation): TaskBaseline {
  const judged = judgedRun(run, expectation);
  if (judged.kind === "timed-out") return unobservable(`the unmutated run exceeded its time limit after ${judged.elapsedMs} ms`);
  if (judged.kind === "unobservable") return judged;
  const { verdict } = judged;
  switch (verdict.kind) {
    case "passed":
      return verdict.observed === "zero-tests" ? UNTESTED : GREEN;
    case "excused":
      return GREEN;
    case "failing":
      return Object.freeze({ kind: "red", failures: mapNonEmpty(verdict.testcases, ({ name, file }) => `'${name}' (${file})`) });
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
  const judged = judgedRun(run, expectation);
  if (judged.kind === "timed-out") return KILLED;
  if (judged.kind === "unobservable") return judged;
  const { verdict } = judged;
  switch (verdict.kind) {
    case "passed":
      return verdict.observed === "zero-tests" ? INVALID : SURVIVED;
    case "excused":
      return SURVIVED;
    case "failing":
      return verdict.testcases.every(({ outcome }) => outcome === "collection-error") ? INVALID : KILLED;
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

declare const TASK_MUTATION_RESULT: unique symbol;

/**
 * What one `helper mutation-check` run found. `candidates` counts the mutation
 * sites on the Task's changed lines; the mutants selected from them are
 * `killed + invalid + survivors`, derived and never stored. `invalid` counts
 * the mutants that only broke collection or ran no test: no evidence either
 * way, so they are never survivors and never kills.
 * - `no-mutants`: no mutation site is on a changed line, so nothing was
 *   selected (and `candidates` is 0).
 * - `clean`: no survivor, and the tests killed at least one mutant.
 * - `survivors`: at least one mutant the tests did not kill.
 * - `inconclusive`: mutants were selected and every one was invalid, so the
 *   tests judged none of them. It is no pass: it never reads as clean.
 * - `unavailable`: the run could not decide.
 * `inconclusive` and `unavailable` never block a stop.
 *
 * Branded: only `taskMutationResult` and `taskMutationUnavailable` build one,
 * so a result's kind always agrees with its counts. A "clean" run that judged
 * no mutant cannot be written.
 */
export type TaskMutationResult = TaskMutationResultFields & { readonly [TASK_MUTATION_RESULT]: true };

/** A result's shape before its invariants are checked. */
type TaskMutationResultFields =
  | Readonly<{ kind: "no-mutants" }>
  | Readonly<{ kind: "clean"; killed: number; invalid: number; candidates: number }>
  | Readonly<{ kind: "survivors"; killed: number; invalid: number; candidates: number; survivors: NonEmpty<TaskSurvivor> }>
  | Readonly<{ kind: "inconclusive"; invalid: number; candidates: number }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** A run's tallies before the result's invariants are checked. */
export type TaskMutationTally = Readonly<{
  candidates: number;
  killed: number;
  invalid: number;
  survivors: readonly TaskSurvivor[];
}>;

/** The brand's one minting point, reached only once the invariants hold. */
const mintResult = (fields: TaskMutationResultFields): TaskMutationResult => Object.freeze(fields) as TaskMutationResult;

export const taskMutationUnavailable = (reason: string): TaskMutationResult => mintResult({ kind: "unavailable", reason });

const isCount = (raw: unknown): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;

/**
 * The only constructor of a decided result. It refuses a count that is not a
 * non-negative integer, more mutants than candidate sites, and candidate sites
 * from which no mutant was selected (the selection holds `min(candidates, cap)`
 * mutants, and the cap is positive). The kind follows from the tallies alone:
 * survivors when any mutant survived; otherwise no-mutants when none was
 * selected, inconclusive when none was killed, and clean only when one was.
 */
export function taskMutationResult({ candidates, killed, invalid, survivors }: TaskMutationTally): DomainResult<TaskMutationResult, string> {
  if (![candidates, killed, invalid].every(isCount)) return failure("the candidates, killed and invalid counts must be non-negative integers");
  const mutants = killed + invalid + survivors.length;
  if (mutants > candidates) return failure(`${mutants} mutant(s) were judged, more than the ${candidates} candidate site(s) they are selected from`);
  if (mutants === 0 && candidates > 0) return failure(`no mutant was selected from ${candidates} candidate site(s)`);
  const named = nonEmpty(survivors);
  if (named !== null) return success(mintResult({ kind: "survivors", killed, invalid, candidates, survivors: Object.freeze(named) }));
  if (mutants === 0) return success(mintResult({ kind: "no-mutants" }));
  if (killed === 0) return success(mintResult({ kind: "inconclusive", invalid, candidates }));
  return success(mintResult({ kind: "clean", killed, invalid, candidates }));
}

/** The mutants a decided result counts: those selected from its candidate sites. */
export function taskMutationMutants(result: TaskMutationResult): number {
  switch (result.kind) {
    case "no-mutants":
    case "unavailable":
      return 0;
    case "clean":
      return result.killed + result.invalid;
    case "survivors":
      return result.killed + result.invalid + result.survivors.length;
    case "inconclusive":
      return result.invalid;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

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

/**
 * The result of a run that judged every selected mutant, tallied through
 * `taskMutationResult`. Runs whose tally breaks its invariants (a defect in
 * the runner, never an answer) are `unavailable`, naming why.
 */
export function taskMutationResultOf(runs: readonly TaskMutantRun[], candidates: number): TaskMutationResult {
  const tallied = taskMutationResult({
    candidates,
    killed: runs.filter(({ outcome }) => outcome === "killed").length,
    invalid: runs.filter(({ outcome }) => outcome === "invalid").length,
    survivors: runs.flatMap(survivorOf),
  });
  return tallied.ok ? tallied.value : taskMutationUnavailable(`the run's tally is inconsistent: ${tallied.error}`);
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

const isList = (raw: unknown): raw is readonly unknown[] => Array.isArray(raw);
const isPosition = (raw: unknown): raw is number => isCount(raw) && raw > 0;
const isText = (raw: unknown): raw is string => typeof raw === "string" && raw !== "";

/** The keys a record of this shape holds, or the refusal naming any other. */
function exactKeys(raw: Readonly<UnknownRecord>, keys: readonly string[], path: string): string | null {
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

/** A counted field of a decided result: a non-negative integer, or the refusal naming it. */
function countAt(raw: Readonly<UnknownRecord>, key: string, path: string): DomainResult<number, string> {
  const value = raw[key];
  return isCount(value) ? success(value) : failure(`${path}.${key} must be a non-negative integer`);
}

function parseSurvivors(raw: unknown, path: string): DomainResult<NonEmpty<TaskSurvivor>, string> {
  if (!isList(raw)) return failure(`${path} must be an array`);
  const survivors: TaskSurvivor[] = [];
  for (const [index, entry] of raw.entries()) {
    const survivor = parseSurvivor(entry, `${path}[${index}]`);
    if (!survivor.ok) return survivor;
    survivors.push(survivor.value);
  }
  return isNonEmpty(survivors) ? success(survivors) : failure(`${path} must name at least one survivor`);
}

/**
 * The wire keys each decided kind holds besides `kind`, in serialized order.
 * Its keys are the decided kinds, in the order the parser names them: the
 * one list of them, exhaustive by its type.
 */
const DECIDED_KEYS: Readonly<Record<Exclude<TaskMutationResult["kind"], "unavailable">, readonly string[]>> = Object.freeze({
  "no-mutants": [],
  "clean": ["killed", "invalid", "candidates"],
  "survivors": ["killed", "invalid", "candidates", "survivors"],
  "inconclusive": ["invalid", "candidates"],
});

type DecidedKind = keyof typeof DECIDED_KEYS;

const isDecidedKind = (raw: unknown): raw is DecidedKind => typeof raw === "string" && Object.hasOwn(DECIDED_KEYS, raw);

/** Every kind a result's wire form may name, quoted, as the refusal of any other lists them. */
const RESULT_KINDS_TEXT = [...Object.keys(DECIDED_KEYS), "unavailable"].map((kind) => `"${kind}"`).join(", ");

/**
 * A decided result's wire form, through the one constructor: a document whose
 * counts make another kind than the one it names (a "clean" run with no kill,
 * say) is refused, never re-read as the kind its counts make.
 */
function parseDecided(raw: Readonly<UnknownRecord>, kind: DecidedKind, path: string): DomainResult<TaskMutationResult, string> {
  const shape = exactKeys(raw, ["kind", ...DECIDED_KEYS[kind]], path);
  if (shape !== null) return failure(shape);
  const counted = (key: string): DomainResult<number, string> => key in raw ? countAt(raw, key, path) : success(0);
  const candidates = counted("candidates");
  if (!candidates.ok) return candidates;
  const killed = counted("killed");
  if (!killed.ok) return killed;
  const invalid = counted("invalid");
  if (!invalid.ok) return invalid;
  const survivors = kind === "survivors" ? parseSurvivors(raw.survivors, `${path}.survivors`) : success([]);
  if (!survivors.ok) return survivors;
  const result = taskMutationResult({ candidates: candidates.value, killed: killed.value, invalid: invalid.value, survivors: survivors.value });
  if (!result.ok) return failure(`${path}: ${result.error}`);
  return result.value.kind === kind ? result : failure(`${path} names a ${kind} result, but its counts make it ${result.value.kind}`);
}

function parseResult(raw: unknown, path: string): DomainResult<TaskMutationResult, string> {
  if (!isRecord(raw)) return failure(`${path} must be an object`);
  if (isDecidedKind(raw.kind)) return parseDecided(raw, raw.kind, path);
  if (raw.kind !== "unavailable") return failure(`${path}.kind must be one of ${RESULT_KINDS_TEXT}`);
  const shape = exactKeys(raw, ["kind", "reason"], path);
  if (shape !== null) return failure(shape);
  return isText(raw.reason) ? success(taskMutationUnavailable(raw.reason)) : failure(`${path}.reason must be a non-empty string`);
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
 * over other bytes, or left survivors; a clean record, or one with no
 * mutation site on a changed line, passes; an inconclusive or unavailable
 * run, and every fault, is a note and the stop proceeds.
 */
export type TaskMutationStopVerdict =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "note"; note: string }>
  | Readonly<{ kind: "failing"; cause: TaskMutationBlockCause; command: string }>;

/** Why an inconclusive run judged nothing, as the helper and a stop note both say it. */
const inconclusiveText = (invalid: number): string =>
  `none of its ${invalid} mutant(s) could be judged, because each only broke test collection or ran no test`;

const proceeds = (taskId: string, why: string): TaskMutationStopVerdict =>
  Object.freeze({ kind: "note", note: `Task mutation check for ${taskId} did not decide (${why}); the stop proceeds` });

export function taskMutationStopVerdict(taskId: string, observation: TaskMutationObservation): TaskMutationStopVerdict {
  if (observation.kind === "off") return Object.freeze({ kind: "idle" });
  if (observation.kind === "unavailable") return proceeds(taskId, observation.reason);
  const { standing, command } = observation;
  if (standing.kind !== "current") return Object.freeze({ kind: "failing", cause: standing, command });
  const { result } = standing;
  switch (result.kind) {
    case "no-mutants":
    case "clean":
      return Object.freeze({ kind: "passed" });
    case "inconclusive":
      return proceeds(taskId, `its last run was inconclusive: ${inconclusiveText(result.invalid)}`);
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
  `${loomHelperCommand(packageRoot)} mutation-check --task ${quoteShellArgument(taskId)}`;

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

/** The line naming the mutants that were no evidence, or nothing when there were none. */
const invalidLines = (invalid: number): readonly string[] =>
  invalid === 0 ? [] : [`${invalid} more mutant(s) only broke test collection or ran no test, so they are no evidence either way.`];

/** What `helper mutation-check` prints for one run. */
export function renderTaskMutationReport(taskId: string, result: TaskMutationResult): string {
  const head = `Task mutation check for ${taskId}:`;
  switch (result.kind) {
    case "no-mutants":
      return `${head} clean — no mutants (no mutation site on a line this Task changed).`;
    case "clean":
      return [
        `${head} clean — your tests killed all ${result.killed} mutant(s) they could judge (of ${result.candidates} site(s) on changed lines).`,
        ...invalidLines(result.invalid),
      ].join("\n");
    case "survivors":
      return [
        `${head} ${result.survivors.length} of ${taskMutationMutants(result)} mutant(s) survived (of ${result.candidates} site(s) on changed lines).`,
        ...result.survivors.map(renderTaskSurvivor),
        ...invalidLines(result.invalid),
        ANSWER_SURVIVORS,
      ].join("\n");
    case "inconclusive":
      return `${head} inconclusive — ${inconclusiveText(result.invalid)} (of ${result.candidates} site(s) on changed lines). ` +
        "Check that your tests import the changed file and run. It did not decide and will not block your stop.";
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
