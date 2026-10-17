/** Guarded Skill Machine policy over shared structured report facts. */

import type { TestReportSummary } from "../core/structured-test-report";

export {
  mergeSummaries,
  parseJunitXml,
  parseReportSummary,
  parseStructuredTestReportBytes,
  parseVitestJson,
  readJunitReport,
  type JunitReportRead,
  type StructuredReportError,
  type StructuredReportErrorReason,
  type StructuredReportParseResult,
  type TestReportSummary,
} from "../core/structured-test-report";

// --- Pure judgment ---

/**
 * The three possible trust verdicts on a TestRun. A "trusted pass" and a
 * "trusted fail" are ground truth; "untrusted" means the run proves
 * nothing either way (downstream falls back to labeled low-trust
 * evidence). An inconsistent {passed: true, trusted: false} state is
 * unrepresentable in this shape.
 */
export type TestVerdict =
  | { readonly verdict: "trusted-pass" }
  | { readonly verdict: "trusted-fail" }
  | { readonly verdict: "untrusted" };

/** The verdicts that constitute ground truth. */
export type TrustedTestVerdict = Extract<TestVerdict, { verdict: "trusted-pass" | "trusted-fail" }>;

/**
 * The TestRun trust rule:
 * - nonzero exit                                    → trusted-fail (a real failure is ground truth)
 * - exit 0 or unknown + report, ≥1 test, 0 failures → trusted-pass
 * - exit 0 or unknown + report with 0 tests         → trusted-fail (nothing ran)
 * - exit 0 or unknown + report with failures        → trusted-fail
 * - exit 0 or unknown + report recording a file
 *   that failed to collect or import                → trusted-fail
 * - exit 0 or unknown + no report                   → untrusted (fall back downstream)
 *
 * A collection error is a failure even when the counts show none: Vitest JSON
 * counts no testcase for a file that failed to import, so its counts alone
 * would read a run whose only failure is a broken file as a pass. The report's
 * recorded per-file results (INV-8: reconciled with those counts) carry it; an
 * unrecorded or counts-only summary is judged on its counts alone.
 *
 * An unknown exit does NOT sink a run that produced a report. A structured
 * JUnit/vitest-JSON report is STRONGER evidence about what happened than a
 * shell exit code: it enumerates the tests, and `findReport`'s freshness,
 * staleness, and write-veto guards already refuse a staged or pre-existing
 * artifact. Requiring an exit code on top of that gated trust on harness
 * capability rather than on evidence quality — harnesses exist whose Bash
 * tool response carries no exit code at all, and on those every run was
 * untrusted and the whole trust doctrine was inert.
 *
 * That reasoning holds only because the report is assumed to describe a
 * FINISHED run, and `attributeExit` nulls the exit for four reasons besides
 * "the harness reported none". Three of them still leave the test provably
 * finished (a later segment owns the exit; an `||` guard that a fresh report
 * disproves; a nonzero exit, which loses to `trusted-fail` above anyway). The
 * fourth — a BACKGROUNDED segment — does not, so `extract-evidence` records no
 * report for it at all rather than letting a mid-write report reach this rule.
 * The completeness precondition is enforced where completeness is knowable.
 *
 * A nonzero exit still overrules a green report: a runner that exits nonzero
 * after writing a passing report failed at something the report does not
 * describe, and the failure is the ground truth.
 */
export function judgeTestRun(exit: number | null, report: TestReportSummary | null): TestVerdict {
  if (exit !== null && exit !== 0) return { verdict: "trusted-fail" };
  if (report === null) return { verdict: "untrusted" };
  return report.total > 0 && report.failed === 0 && !recordsCollectionError(report)
    ? { verdict: "trusted-pass" }
    : { verdict: "trusted-fail" };
}

const recordsCollectionError = ({ files }: TestReportSummary): boolean =>
  files?.kind === "recorded" && files.results.some((result) => result.collectionError);
