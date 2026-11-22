/**
 * ADR-0100: a TestRun is a trusted pass only when its report proves a test
 * executed. Reports are generated as the text a runner writes and read through
 * the production projections, so the properties cover what capture mints, not
 * a hand-built summary.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { executedTestCount, mergeSummaries, type TestReportSummary } from "../../src/core/structured-test-report";
import { judgeTestRun } from "../../src/machine/test-report";
import { countedReport, summarizedReport } from "./report-summary";

type VitestStatus = "passed" | "failed" | "pending" | "skipped" | "todo";
type JunitOutcome = "passed" | "failed" | "skipped";

/** Skipped outcomes only, so a large share of generated reports ran nothing. */
const skippedVitest = fc.constantFrom<VitestStatus>("pending", "skipped", "todo");
const anyVitest = fc.constantFrom<VitestStatus>("passed", "failed", "pending", "skipped", "todo");
const anyJunit = fc.constantFrom<JunitOutcome>("passed", "failed", "skipped");

const fileStatuses = <T>(status: fc.Arbitrary<T>) =>
  fc.array(fc.array(status, { maxLength: 5 }), { minLength: 1, maxLength: 4 });

const vitestFiles = fc.oneof(fileStatuses(skippedVitest), fileStatuses(anyVitest));
const junitFiles = fc.oneof(fileStatuses(fc.constant<JunitOutcome>("skipped")), fileStatuses(anyJunit));

const count = <T>(items: readonly T[], ...wanted: T[]): number => items.filter((item) => wanted.includes(item)).length;

/** A Vitest JSON report: consistent summary counts, with or without its per-file results. */
function vitestReport(files: readonly (readonly VitestStatus[])[], withResults: boolean): string {
  const all = files.flat();
  return JSON.stringify({
    numTotalTests: all.length,
    numPassedTests: count(all, "passed"),
    numFailedTests: count(all, "failed"),
    numPendingTests: count(all, "pending", "skipped"),
    numTodoTests: count(all, "todo"),
    ...(withResults ? {
      testResults: files.map((statuses, index) => ({
        name: `/repo/f${index}.test.ts`,
        status: statuses.includes("failed") ? "failed" : "passed",
        assertionResults: statuses.map((status) => ({ status })),
      })),
    } : {}),
  });
}

/** A JUnit report: one suite per file, with its testcases or summary-only. */
function junitReport(files: readonly (readonly JunitOutcome[])[], withTestcases: boolean, prefix = "f"): string {
  const suites = files.map((outcomes, index) => {
    const file = `${prefix}${index}.test.ts`;
    const attributes = `name="${file}" tests="${outcomes.length}" failures="${count(outcomes, "failed")}" skipped="${count(outcomes, "skipped")}"`;
    if (!withTestcases) return `<testsuite ${attributes}/>`;
    const cases = outcomes.map((outcome, n) => {
      const body = outcome === "failed" ? "<failure/>" : outcome === "skipped" ? "<skipped/>" : "";
      return `<testcase classname="${file}" name="t${n}">${body}</testcase>`;
    });
    return `<testsuite ${attributes}>${cases.join("")}</testsuite>`;
  });
  return `<testsuites>${suites.join("")}</testsuites>`;
}

const executedZero = (text: string): boolean => {
  const counts = countedReport(text);
  return counts.ok && counts.value.total === 0;
};

const neverTrustedPass = (summary: TestReportSummary | null): void => {
  for (const exit of [0, null]) expect(judgeTestRun(exit, summary)).not.toEqual({ verdict: "trusted-pass" });
};

/** Every generated report as its text and the format capture reads it as. */
const reports = fc.oneof(
  fc.tuple(vitestFiles, fc.boolean()).map(([files, withResults]) => ({ text: vitestReport(files, withResults), format: "vitest-json" as const })),
  fc.tuple(junitFiles, fc.boolean()).map(([files, withTestcases]) => ({ text: junitReport(files, withTestcases), format: "junit-xml" as const })),
);

describe("TestRun verdict — nothing executed is never a pass (property)", () => {
  it("a report whose executed count is 0 never judges trusted-pass", () => {
    fc.assert(fc.property(reports, ({ text, format }) => {
      fc.pre(executedZero(text));
      neverTrustedPass(summarizedReport(text, format));
    }), { numRuns: 500 });
  });

  it("a TestRun summary's executed count is the executed-count rule's count of the same bytes", () => {
    fc.assert(fc.property(reports, ({ text, format }) => {
      const counts = countedReport(text);
      const summary = summarizedReport(text, format);
      expect(counts.ok).toBe(true);
      expect(summary).not.toBeNull();
      if (counts.ok && summary !== null) expect(executedTestCount(summary)).toBe(counts.value.total);
    }), { numRuns: 500 });
  });

  it("a report-dir merge of reports that each executed nothing never judges trusted-pass", () => {
    const part = fc.tuple(fileStatuses(fc.constant<JunitOutcome>("skipped")), fc.boolean());
    fc.assert(fc.property(fc.array(part, { minLength: 1, maxLength: 3 }), (parts) => {
      const summaries = parts
        .map(([files, withTestcases], index) => summarizedReport(junitReport(files, withTestcases, `p${index}-`), "junit-xml"))
        .filter((summary): summary is TestReportSummary => summary !== null);
      expect(summaries).toHaveLength(parts.length);
      neverTrustedPass(mergeSummaries(summaries));
    }), { numRuns: 300 });
  });
});
