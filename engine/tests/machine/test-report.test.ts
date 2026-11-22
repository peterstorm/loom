import { describe, it, expect } from "vitest";
import {
  executedTestCount,
  mergeSummaries,
  parseReportCounts,
  parseReportSummary,
  readTestReport,
  reportCounts,
} from "../../src/core/structured-test-report";
import { judgeTestRun } from "../../src/machine/test-report";
import { countedReport, reportSummary, summarizedReport } from "./report-summary";

describe("parseReportCounts (shared count-sanity gate)", () => {
  it("accepts sane non-negative integer counts with failed ≤ total", () => {
    expect(parseReportCounts(5, 0, "vitest-json")).toEqual({ total: 5, failed: 0, source: "vitest-json" });
    expect(parseReportCounts(3, 3, "junit-xml")).toEqual({ total: 3, failed: 3, source: "junit-xml" });
  });

  it("rejects non-number, fractional, negative, and failed>total counts (fail closed to null)", () => {
    expect(parseReportCounts("5", 0, "vitest-json")).toBeNull();
    expect(parseReportCounts(0.5, 0, "vitest-json")).toBeNull();
    expect(parseReportCounts(5, -1, "vitest-json")).toBeNull();
    expect(parseReportCounts(-1, 0, "vitest-json")).toBeNull();
    expect(parseReportCounts(2, 3, "junit-xml")).toBeNull();
  });
});

describe("testRunSummary — Vitest JSON", () => {
  it("parses vitest/jest JSON summary", () => {
    const json = JSON.stringify({ numTotalTests: 12, numFailedTests: 2, success: false });
    expect(summarizedReport(json, "vitest-json")).toEqual({ total: 12, failed: 2, source: "vitest-json" });
  });

  it("rejects JSON without the summary fields", () => {
    expect(summarizedReport(JSON.stringify({ tests: 5 }), "vitest-json")).toBeNull();
    expect(summarizedReport("not json", "vitest-json")).toBeNull();
    expect(summarizedReport("null", "vitest-json")).toBeNull();
  });

  it("rejects insane counts — negatives, non-integers, failed > total (fail closed to untrusted)", () => {
    expect(summarizedReport(JSON.stringify({ numTotalTests: -1, numFailedTests: 0 }), "vitest-json")).toBeNull();
    expect(summarizedReport(JSON.stringify({ numTotalTests: 5, numFailedTests: -2 }), "vitest-json")).toBeNull();
    expect(summarizedReport(JSON.stringify({ numTotalTests: 5.5, numFailedTests: 0 }), "vitest-json")).toBeNull();
    expect(summarizedReport(JSON.stringify({ numTotalTests: 5, numFailedTests: 0.5 }), "vitest-json")).toBeNull();
    expect(summarizedReport(JSON.stringify({ numTotalTests: 3, numFailedTests: 7 }), "vitest-json")).toBeNull();
  });
});

describe("testRunSummary — JUnit XML", () => {
  it("sums tests, failures, and errors across testsuites", () => {
    const xml = `<?xml version="1.0"?>
      <testsuites>
        <testsuite name="a" tests="10" failures="1" errors="0"></testsuite>
        <testsuite name="b" tests="5" failures="0" errors="2"></testsuite>
      </testsuites>`;
    expect(summarizedReport(xml, "junit-xml")).toEqual({ total: 15, failed: 3, source: "junit-xml" });
  });

  it("returns null for XML without testsuite counts", () => {
    expect(summarizedReport("<foo/>", "junit-xml")).toBeNull();
    expect(summarizedReport("<testsuite>", "junit-xml")).toBeNull();
  });

  it("rejects a malformed report whose failures+errors exceed tests (fail closed to untrusted)", () => {
    expect(summarizedReport('<testsuite tests="1" failures="1" errors="1"/>', "junit-xml")).toBeNull();
  });
});

describe("reportCounts — the executed-count rule", () => {
  it("counts actual Vitest executions rather than declared or skipped tests", () => {
    expect(countedReport(JSON.stringify({
      numTotalTests: 5,
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 2,
      numTodoTests: 0,
    }))).toEqual({ ok: true, value: { total: 3, failed: 1, source: "vitest-json" } });

    expect(countedReport(JSON.stringify({
      numTotalTests: 4,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 4,
      numTodoTests: 0,
    }))).toEqual({ ok: true, value: { total: 0, failed: 0, source: "vitest-json" } });
  });

  it("subtracts skipped JUnit cases from actual executions", () => {
    const report = '<testsuite tests="3" failures="0" errors="0" skipped="2"></testsuite>';
    expect(countedReport(report)).toEqual({
      ok: true,
      value: { total: 1, failed: 0, source: "junit-xml" },
    });
    const childOnlySkip = '<testsuite tests="1" failures="0"><testcase><skipped/></testcase></testsuite>';
    expect(countedReport(childOnlySkip)).toEqual({
      ok: true,
      value: { total: 0, failed: 0, source: "junit-xml" },
    });
  });

  it("parses Node's built-in JUnit summary and refuses all-skipped as positive execution", () => {
    const report = `<?xml version="1.0" encoding="utf-8"?>
      <testsuites><testcase name="skip"><skipped/></testcase>
      <!-- tests 1 --><!-- pass 0 --><!-- fail 0 --><!-- cancelled 0 -->
      <!-- skipped 1 --><!-- todo 0 --></testsuites>`;
    expect(countedReport(report)).toEqual({
      ok: true,
      value: { total: 0, failed: 0, source: "junit-xml" },
    });
  });

  it("fails closed for fatal UTF-8, no format, ambiguity, and malformed counts", () => {
    const invalidUtf8 = reportCounts(readTestReport(Uint8Array.from([0xc3, 0x28])));
    expect(invalidUtf8).toMatchObject({ ok: false, error: { reason: "invalid-utf8" } });
    expect(countedReport("plain output")).toMatchObject({
      ok: false, error: { reason: "unrecognized-format" },
    });
    expect(countedReport(JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      attachment: '<testsuite tests="1" failures="0"/>',
    }))).toMatchObject({ ok: false, error: { reason: "ambiguous-format" } });
    expect(countedReport(JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    }))).toMatchObject({ ok: false, error: { reason: "malformed-counts" } });
    expect(countedReport(
      '<testsuite tests="1" failures="0" skipped="2"></testsuite>',
    )).toMatchObject({ ok: false, error: { reason: "malformed-counts" } });
  });
});

describe("mergeSummaries", () => {
  it("adds totals and failures", () => {
    expect(
      mergeSummaries([
        reportSummary(3, 1, "junit-xml"),
        reportSummary(4, 0, "junit-xml"),
      ]),
    ).toEqual({ total: 7, failed: 1, source: "junit-xml" });
  });

  it("returns null for empty input", () => {
    expect(mergeSummaries([])).toBeNull();
  });
});

describe("judgeTestRun — the R2 trust rule", () => {
  const report = reportSummary(5, 0, "vitest-json");

  it("exit 0 + clean report → trusted-pass", () => {
    expect(judgeTestRun(0, report)).toEqual({ verdict: "trusted-pass" });
  });

  it("exit 0 + report with failures → trusted-fail", () => {
    expect(judgeTestRun(0, reportSummary(5, 1, "vitest-json"))).toEqual({ verdict: "trusted-fail" });
  });

  it("exit 0 + report with 0 tests → trusted-fail (nothing ran)", () => {
    expect(judgeTestRun(0, reportSummary(0, 0, "vitest-json"))).toEqual({ verdict: "trusted-fail" });
  });

  it("exit 0 + no report → untrusted (echo-spoof shape)", () => {
    expect(judgeTestRun(0, null)).toEqual({ verdict: "untrusted" });
  });

  it("nonzero exit → trusted-fail regardless of report", () => {
    expect(judgeTestRun(1, null)).toEqual({ verdict: "trusted-fail" });
    expect(judgeTestRun(2, report)).toEqual({ verdict: "trusted-fail" });
  });

  it("unknown exit + no report → untrusted (nothing to judge)", () => {
    expect(judgeTestRun(null, null)).toEqual({ verdict: "untrusted" });
  });

  // The report, not the exit code, is the evidence. Harnesses exist whose Bash
  // tool response carries no exit code at all; gating trust on one made the
  // whole doctrine inert there while a real JUnit/vitest report sat on disk.
  it("unknown exit + clean report → trusted-pass (the report is the evidence)", () => {
    expect(judgeTestRun(null, report)).toEqual({ verdict: "trusted-pass" });
  });

  it("unknown exit + report with failures → trusted-fail", () => {
    expect(judgeTestRun(null, reportSummary(5, 1, "vitest-json"))).toEqual({ verdict: "trusted-fail" });
  });

  it("unknown exit + report with 0 tests → trusted-fail (nothing ran)", () => {
    expect(judgeTestRun(null, reportSummary(0, 0, "vitest-json"))).toEqual({ verdict: "trusted-fail" });
  });

  // ADR-0100: a skipped, pending or todo test did not run. A report in which
  // every test was skipped takes the zero-test verdict above, not a pass.
  describe("an all-skipped report is the zero-test case: trusted-fail (nothing ran)", () => {
    const allSkippedVitest = JSON.stringify({
      numTotalTests: 3, numPassedTests: 0, numFailedTests: 0, numPendingTests: 2, numTodoTests: 1,
      testResults: [{
        name: "/repo/a.test.ts", status: "passed",
        assertionResults: [{ status: "pending" }, { status: "skipped" }, { status: "todo" }],
      }],
    });
    const allSkippedJunit = '<testsuites><testsuite name="a.test.ts" tests="2" failures="0" errors="0" skipped="2">' +
      '<testcase classname="a.test.ts" name="one"><skipped/></testcase>' +
      '<testcase classname="a.test.ts" name="two"><skipped/></testcase></testsuite></testsuites>';

    it("the TestRun summary keeps the declared total, and its executed count is the executed-count rule's 0", () => {
      const vitest = summarizedReport(allSkippedVitest, "vitest-json");
      const junit = summarizedReport(allSkippedJunit, "junit-xml");
      expect(vitest).toMatchObject({ total: 3, failed: 0 });
      expect(junit).toMatchObject({ total: 2, failed: 0 });
      expect(executedTestCount(vitest!)).toBe(0);
      expect(executedTestCount(junit!)).toBe(0);
      expect(countedReport(allSkippedVitest)).toMatchObject({ ok: true, value: { total: 0 } });
      expect(countedReport(allSkippedJunit)).toMatchObject({ ok: true, value: { total: 0 } });
    });

    it.each([0, null])("judgeTestRun reads an all-skipped Vitest JSON report as trusted-fail (exit %s)", (exit) => {
      expect(judgeTestRun(exit, summarizedReport(allSkippedVitest, "vitest-json"))).toEqual({ verdict: "trusted-fail" });
    });

    it.each([0, null])("judgeTestRun reads an all-skipped JUnit report as trusted-fail (exit %s)", (exit) => {
      expect(judgeTestRun(exit, summarizedReport(allSkippedJunit, "junit-xml"))).toEqual({ verdict: "trusted-fail" });
    });

    it("a summary-only all-skipped JUnit report mints the executed-count rule's zero and is trusted-fail", () => {
      const summary = summarizedReport('<testsuite tests="2" failures="0" skipped="2"/>', "junit-xml");
      expect(summary).toEqual({ total: 0, failed: 0, source: "junit-xml" });
      expect(judgeTestRun(0, summary)).toEqual({ verdict: "trusted-fail" });
    });

    it("an all-skipped ledger line with per-file results reads back as trusted-fail", () => {
      const readBack = parseReportSummary(2, 0, "junit-xml", {
        kind: "recorded",
        results: [{ file: "a.test.ts", executed: 2, failed: 0, skipped: 2, collectionError: false }],
      });
      expect(judgeTestRun(0, readBack)).toEqual({ verdict: "trusted-fail" });
    });

    it("one test that ran beside skipped ones is still a pass", () => {
      const partly = JSON.stringify({
        numTotalTests: 3, numPassedTests: 1, numFailedTests: 0, numPendingTests: 2, numTodoTests: 0,
        testResults: [{
          name: "/repo/a.test.ts", status: "passed",
          assertionResults: [{ status: "passed" }, { status: "pending" }, { status: "skipped" }],
        }],
      });
      expect(judgeTestRun(0, summarizedReport(partly, "vitest-json"))).toEqual({ verdict: "trusted-pass" });
    });
  });
});

describe("executedTestCount — what a TestRun summary proves ran", () => {
  it("is the recorded testcases less the skipped ones", () => {
    const summary = parseReportSummary(5, 1, "vitest-json", {
      kind: "recorded",
      results: [
        { file: "/repo/a.test.ts", executed: 3, failed: 1, skipped: 1, collectionError: false },
        { file: "/repo/b.test.ts", executed: 2, failed: 0, skipped: 2, collectionError: false },
      ],
    })!;
    expect(executedTestCount(summary)).toBe(2);
  });

  it("is the total of a summary that records no per-file results", () => {
    expect(executedTestCount(reportSummary(4, 1, "junit-xml"))).toBe(4);
  });
});

describe("testRunSummary — held to the executed-count rule", () => {
  it("keeps a declared-only Vitest summary the executed-count rule cannot count", () => {
    const json = JSON.stringify({ numTotalTests: 2, numFailedTests: 0 });
    expect(countedReport(json)).toMatchObject({ ok: false, error: { reason: "malformed-counts" } });
    expect(summarizedReport(json, "vitest-json")).toEqual({ total: 2, failed: 0, source: "vitest-json" });
  });

  it("refuses a report whose per-file results and summary counts disagree about what ran", () => {
    const disagreeing = JSON.stringify({
      numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      testResults: [{ name: "/repo/a.test.ts", status: "passed", assertionResults: [{ status: "skipped" }, { status: "skipped" }] }],
    });
    expect(countedReport(disagreeing)).toMatchObject({ ok: true, value: { total: 2 } });
    expect(summarizedReport(disagreeing, "vitest-json")).toBeNull();
  });

  it("refuses a report of the other format", () => {
    expect(summarizedReport('<testsuite tests="1"/>', "vitest-json")).toBeNull();
    expect(summarizedReport(JSON.stringify({ numTotalTests: 1, numFailedTests: 0 }), "junit-xml")).toBeNull();
  });
});

describe("mergeSummaries — skipped testcases never reappear as run", () => {
  it("a merge that loses per-file results sums each part's executed count", () => {
    const allSkipped = parseReportSummary(2, 0, "junit-xml", {
      kind: "recorded",
      results: [{ file: "a.test.ts", executed: 2, failed: 0, skipped: 2, collectionError: false }],
    })!;
    const merged = mergeSummaries([allSkipped, reportSummary(0, 0, "junit-xml")]);
    expect(merged).toEqual({ total: 0, failed: 0, source: "junit-xml" });
    expect(judgeTestRun(0, merged)).toEqual({ verdict: "trusted-fail" });
  });

  it("a merge that keeps per-file results keeps the declared totals", () => {
    const part = (file: string) => parseReportSummary(2, 0, "junit-xml", {
      kind: "recorded",
      results: [{ file, executed: 2, failed: 0, skipped: 1, collectionError: false }],
    })!;
    const merged = mergeSummaries([part("a.test.ts"), part("b.test.ts")])!;
    expect(merged.total).toBe(4);
    expect(executedTestCount(merged)).toBe(2);
  });
});

describe("mergeSummaries — source homogeneity enforced at runtime (round-10 Fix 16)", () => {
  it("mixed sources fail closed to null instead of mislabeling the sum", () => {
    expect(
      mergeSummaries([
        reportSummary(3, 1, "junit-xml"),
        reportSummary(4, 0, "vitest-json"),
      ]),
    ).toBeNull();
  });

  it("homogeneous sources still merge", () => {
    expect(
      mergeSummaries([
        reportSummary(1, 0, "vitest-json"),
        reportSummary(2, 2, "vitest-json"),
      ]),
    ).toEqual({ total: 3, failed: 2, source: "vitest-json" });
  });
});
