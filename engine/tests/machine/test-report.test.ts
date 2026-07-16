import { describe, it, expect } from "vitest";
import {
  parseReportSummary,
  parseVitestJson,
  parseJunitXml,
  mergeSummaries,
  judgeTestRun,
} from "../../src/machine/test-report";

describe("parseReportSummary (shared count-sanity gate)", () => {
  it("accepts sane non-negative integer counts with failed ≤ total", () => {
    expect(parseReportSummary(5, 0, "vitest-json")).toEqual({ total: 5, failed: 0, source: "vitest-json" });
    expect(parseReportSummary(3, 3, "junit-xml")).toEqual({ total: 3, failed: 3, source: "junit-xml" });
  });

  it("rejects non-number, fractional, negative, and failed>total counts (fail closed to null)", () => {
    expect(parseReportSummary("5", 0, "vitest-json")).toBeNull();
    expect(parseReportSummary(0.5, 0, "vitest-json")).toBeNull();
    expect(parseReportSummary(5, -1, "vitest-json")).toBeNull();
    expect(parseReportSummary(-1, 0, "vitest-json")).toBeNull();
    expect(parseReportSummary(2, 3, "junit-xml")).toBeNull();
  });
});

describe("parseVitestJson", () => {
  it("parses vitest/jest JSON summary", () => {
    const json = JSON.stringify({ numTotalTests: 12, numFailedTests: 2, success: false });
    expect(parseVitestJson(json)).toEqual({ total: 12, failed: 2, source: "vitest-json" });
  });

  it("rejects JSON without the summary fields", () => {
    expect(parseVitestJson(JSON.stringify({ tests: 5 }))).toBeNull();
    expect(parseVitestJson("not json")).toBeNull();
    expect(parseVitestJson("null")).toBeNull();
  });

  it("rejects insane counts — negatives, non-integers, failed > total (fail closed to untrusted)", () => {
    expect(parseVitestJson(JSON.stringify({ numTotalTests: -1, numFailedTests: 0 }))).toBeNull();
    expect(parseVitestJson(JSON.stringify({ numTotalTests: 5, numFailedTests: -2 }))).toBeNull();
    expect(parseVitestJson(JSON.stringify({ numTotalTests: 5.5, numFailedTests: 0 }))).toBeNull();
    expect(parseVitestJson(JSON.stringify({ numTotalTests: 5, numFailedTests: 0.5 }))).toBeNull();
    expect(parseVitestJson(JSON.stringify({ numTotalTests: 3, numFailedTests: 7 }))).toBeNull();
  });
});

describe("parseJunitXml", () => {
  it("sums tests, failures, and errors across testsuites", () => {
    const xml = `<?xml version="1.0"?>
      <testsuites>
        <testsuite name="a" tests="10" failures="1" errors="0"></testsuite>
        <testsuite name="b" tests="5" failures="0" errors="2"></testsuite>
      </testsuites>`;
    expect(parseJunitXml(xml)).toEqual({ total: 15, failed: 3, source: "junit-xml" });
  });

  it("returns null for XML without testsuite counts", () => {
    expect(parseJunitXml("<foo/>")).toBeNull();
    expect(parseJunitXml("<testsuite>")).toBeNull();
  });

  it("rejects a malformed report whose failures+errors exceed tests (fail closed to untrusted)", () => {
    expect(parseJunitXml('<testsuite tests="1" failures="1" errors="1"/>')).toBeNull();
  });
});

describe("mergeSummaries", () => {
  it("adds totals and failures", () => {
    expect(
      mergeSummaries([
        parseReportSummary(3, 1, "junit-xml")!,
        parseReportSummary(4, 0, "junit-xml")!,
      ]),
    ).toEqual({ total: 7, failed: 1, source: "junit-xml" });
  });

  it("returns null for empty input", () => {
    expect(mergeSummaries([])).toBeNull();
  });
});

describe("judgeTestRun — the R2 trust rule", () => {
  const report = parseReportSummary(5, 0, "vitest-json")!;

  it("exit 0 + clean report → trusted-pass", () => {
    expect(judgeTestRun(0, report)).toEqual({ verdict: "trusted-pass" });
  });

  it("exit 0 + report with failures → trusted-fail", () => {
    expect(judgeTestRun(0, parseReportSummary(5, 1, "vitest-json")!)).toEqual({ verdict: "trusted-fail" });
  });

  it("exit 0 + report with 0 tests → trusted-fail (nothing ran)", () => {
    expect(judgeTestRun(0, parseReportSummary(0, 0, "vitest-json")!)).toEqual({ verdict: "trusted-fail" });
  });

  it("exit 0 + no report → untrusted (echo-spoof shape)", () => {
    expect(judgeTestRun(0, null)).toEqual({ verdict: "untrusted" });
  });

  it("nonzero exit → trusted-fail regardless of report", () => {
    expect(judgeTestRun(1, null)).toEqual({ verdict: "trusted-fail" });
    expect(judgeTestRun(2, report)).toEqual({ verdict: "trusted-fail" });
  });

  it("unknown exit → untrusted", () => {
    expect(judgeTestRun(null, report)).toEqual({ verdict: "untrusted" });
  });
});

describe("mergeSummaries — source homogeneity enforced at runtime (round-10 Fix 16)", () => {
  it("mixed sources fail closed to null instead of mislabeling the sum", () => {
    expect(
      mergeSummaries([
        parseReportSummary(3, 1, "junit-xml")!,
        parseReportSummary(4, 0, "vitest-json")!,
      ]),
    ).toBeNull();
  });

  it("homogeneous sources still merge", () => {
    expect(
      mergeSummaries([
        parseReportSummary(1, 0, "vitest-json")!,
        parseReportSummary(2, 2, "vitest-json")!,
      ]),
    ).toEqual({ total: 3, failed: 2, source: "vitest-json" });
  });
});
