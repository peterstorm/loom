/**
 * Matrix-test run classification (AD-7; FR-013, FR-016). Only the structured
 * report decides killed, survived and invalid; the exit code and signal only
 * ever turn an otherwise passing report into an infrastructure failure. A
 * timeout kills a mutant (and is infrastructure for the baseline); every
 * ambiguous observation is infrastructure, never a kill.
 *
 * | Observation                                   | Mutant                       | Baseline            |
 * |-----------------------------------------------|------------------------------|---------------------|
 * | timed out                                     | `timed-out` (a kill)         | `baseline-timed-out`|
 * | spawn failed / report missing, unreadable     | infrastructure               | infrastructure      |
 * | ≥1 failing non-collection testcase            | `killed`                     | `red`               |
 * | failures, every one a collection error        | `invalid`                    | `red`               |
 * | no attributed, executed testcase              | `matrix-test-not-collected`  | same                |
 * | every attributed testcase passes, exit 0      | `survived`                   | `green`             |
 * | every one passes, non-zero exit or a signal   | `exit-unexplained-by-report` | same                |
 *
 * Testcases are attributed to the matrix test through the one reported-file
 * rule (`attributeReportedFile`) and collection errors are recognized by the
 * one shared rule (`isCollectionErrorTestcase`). The tallied outcomes become a
 * verdict only through `verifiedMutationOf`, which refuses a run whose every
 * generated mutant is invalid (`no-valid-mutants`): such a run carries no
 * mutation evidence, so it is never a verified pass.
 */

import { match } from "ts-pattern";
import { failure, isNonEmpty, success, type NonEmpty } from "../orchestration-contract/identity";
import { attributeReportedFile } from "../report-file-attribution";
import { isCollectionErrorTestcase, parseJunitTestcases } from "../structured-test-report";
import type {
  BaselineOutcome,
  ClassifyBaselineFn,
  ClassifyMutantRunFn,
  MatrixTestRun,
  MutantOutcome,
  OwnerInfrastructureFailure,
  OwnerInfrastructureFailureKind,
  VerifiedMutation,
  VerifiedMutationFields,
  VerifiedMutationOfFn,
} from "./types";

/** What one run's report says about the matrix test, before the mutant/baseline reading. */
type RunReading =
  | Readonly<{ kind: "timed-out"; elapsedMs: number }>
  | Readonly<{ kind: "infrastructure"; failure: OwnerInfrastructureFailure }>
  | Readonly<{ kind: "failing"; failures: NonEmpty<string>; nonCollection: readonly string[] }>
  | Readonly<{ kind: "passing" }>;

const infrastructure = (kind: OwnerInfrastructureFailureKind, detail: string): RunReading =>
  ({ kind: "infrastructure", failure: { kind, detail } });

/** The one reading both classifiers share: the report first, the exit only for a passing report. */
function readRun(run: MatrixTestRun, matrixTest: string): RunReading {
  return match(run)
    .with({ kind: "timed-out" }, ({ elapsedMs }): RunReading => ({ kind: "timed-out", elapsedMs }))
    .with({ kind: "spawn-failed" }, ({ message }) => infrastructure("spawn-failed", `the runner could not start: ${message}`))
    .with({ kind: "exited" }, ({ exitCode, signal, report }) => match(report)
      .with({ kind: "missing" }, () => infrastructure("report-missing", `the runner exited (code ${String(exitCode)}, signal ${String(signal)}) without writing its report`))
      .with({ kind: "unreadable" }, ({ reason }) => infrastructure("report-unreadable", `the report could not be read: ${reason}`))
      .with({ kind: "produced" }, ({ bytes }) => readReport(bytes, exitCode, signal, matrixTest))
      .exhaustive())
    .exhaustive();
}

function readReport(bytes: Uint8Array, exitCode: number | null, signal: string | null, matrixTest: string): RunReading {
  const parsed = parseJunitTestcases(bytes);
  if (!parsed.ok) return infrastructure("report-unreadable", `the report does not parse: ${parsed.error.message}`);
  const executed = parsed.value.filter((testcase) =>
    testcase.outcome !== "skipped" && attributeReportedFile([matrixTest], testcase.classname, null) === matrixTest);
  if (executed.length === 0) {
    return infrastructure("matrix-test-not-collected", `the report holds no executed testcase of ${matrixTest}`);
  }
  const failed = executed.filter((testcase) => testcase.outcome === "failed");
  const failures = failed.map((testcase) => testcase.name);
  if (isNonEmpty(failures)) {
    return { kind: "failing", failures, nonCollection: failed.filter((testcase) => !isCollectionErrorTestcase(testcase)).map((testcase) => testcase.name) };
  }
  return exitCode === 0 && signal === null
    ? { kind: "passing" }
    : infrastructure("exit-unexplained-by-report", `every testcase of ${matrixTest} passed, but the runner exited with code ${String(exitCode)} and signal ${String(signal)}`);
}

export const classifyMutantRun: ClassifyMutantRunFn = (run, matrixTest) =>
  match(readRun(run, matrixTest))
    .with({ kind: "timed-out" }, (): MutantOutcome => ({ kind: "timed-out" }))
    .with({ kind: "infrastructure" }, ({ failure: cause }): MutantOutcome => ({ kind: "infrastructure", failure: cause }))
    .with({ kind: "failing" }, ({ failures, nonCollection }): MutantOutcome =>
      nonCollection.length > 0 ? { kind: "killed" } : { kind: "invalid", collectionErrors: failures })
    .with({ kind: "passing" }, (): MutantOutcome => ({ kind: "survived" }))
    .exhaustive();

export const classifyBaseline: ClassifyBaselineFn = (run, matrixTest) =>
  match(readRun(run, matrixTest))
    .with({ kind: "timed-out" }, ({ elapsedMs }): BaselineOutcome =>
      ({ kind: "infrastructure", failure: { kind: "baseline-timed-out", detail: `the unmutated matrix test ${matrixTest} exceeded its time limit after ${elapsedMs} ms` } }))
    .with({ kind: "infrastructure" }, ({ failure: cause }): BaselineOutcome => ({ kind: "infrastructure", failure: cause }))
    .with({ kind: "failing" }, ({ failures }): BaselineOutcome => ({ kind: "red", failures }))
    .with({ kind: "passing" }, (): BaselineOutcome => ({ kind: "green" }))
    .exhaustive();

const COUNT_FIELDS = ["killed", "timedOut", "invalid", "unmutated"] as const;

export const verifiedMutationOf: VerifiedMutationOfFn = (fields: VerifiedMutationFields) => {
  for (const field of COUNT_FIELDS) {
    const value = fields[field];
    if (!Number.isInteger(value) || value < 0) return failure({ kind: "count-not-a-count", field, value });
  }
  const generated = fields.killed + fields.timedOut + fields.invalid + fields.survivors.length;
  if (!fields.ownerChangedInWave && (generated > 0 || fields.unmutated > 0)) {
    return failure({ kind: "mutants-without-owner-change", generated, unmutated: fields.unmutated });
  }
  // Generated mutants that all failed only to collect carry no evidence either way.
  if (generated > 0 && fields.invalid === generated) return failure({ kind: "no-valid-mutants", generated });
  // The brand's one minting point: the counts were just checked to agree.
  return success(Object.freeze({
    kind: "verified" as const,
    generated,
    killed: fields.killed,
    timedOut: fields.timedOut,
    invalid: fields.invalid,
    survivors: Object.freeze([...fields.survivors]),
    unmutated: fields.unmutated,
    ownerChangedInWave: fields.ownerChangedInWave,
  }) as VerifiedMutation);
};
