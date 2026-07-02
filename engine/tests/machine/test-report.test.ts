import { describe, it, expect } from "vitest";
import {
  parseVitestJson,
  parseJunitXml,
  mergeSummaries,
  judgeTestRun,
} from "../../src/machine/test-report";

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
});

describe("mergeSummaries", () => {
  it("adds totals and failures", () => {
    expect(
      mergeSummaries([
        { total: 3, failed: 1, source: "junit-xml" },
        { total: 4, failed: 0, source: "junit-xml" },
      ]),
    ).toEqual({ total: 7, failed: 1, source: "junit-xml" });
  });

  it("returns null for empty input", () => {
    expect(mergeSummaries([])).toBeNull();
  });
});

describe("judgeTestRun — the R2 trust rule", () => {
  const report = { total: 5, failed: 0, source: "vitest-json" as const };

  it("exit 0 + clean report → trusted-pass", () => {
    expect(judgeTestRun(0, report)).toEqual({ verdict: "trusted-pass" });
  });

  it("exit 0 + report with failures → trusted-fail", () => {
    expect(judgeTestRun(0, { ...report, failed: 1 })).toEqual({ verdict: "trusted-fail" });
  });

  it("exit 0 + report with 0 tests → trusted-fail (nothing ran)", () => {
    expect(judgeTestRun(0, { ...report, total: 0 })).toEqual({ verdict: "trusted-fail" });
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
