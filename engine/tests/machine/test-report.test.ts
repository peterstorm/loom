import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVitestJson,
  parseJunitXml,
  mergeSummaries,
  judgeTestRun,
  outputFileFromCommand,
  findReport,
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

  it("exit 0 + clean report → passed, trusted", () => {
    expect(judgeTestRun(0, report)).toEqual({ passed: true, trusted: true });
  });

  it("exit 0 + report with failures → not passed, trusted", () => {
    expect(judgeTestRun(0, { ...report, failed: 1 })).toEqual({ passed: false, trusted: true });
  });

  it("exit 0 + report with 0 tests → not passed (nothing ran), trusted", () => {
    expect(judgeTestRun(0, { ...report, total: 0 })).toEqual({ passed: false, trusted: true });
  });

  it("exit 0 + no report → not passed, NOT trusted (echo-spoof shape)", () => {
    expect(judgeTestRun(0, null)).toEqual({ passed: false, trusted: false });
  });

  it("nonzero exit → not passed, trusted regardless of report", () => {
    expect(judgeTestRun(1, null)).toEqual({ passed: false, trusted: true });
    expect(judgeTestRun(2, report)).toEqual({ passed: false, trusted: true });
  });

  it("unknown exit → not passed, not trusted", () => {
    expect(judgeTestRun(null, report)).toEqual({ passed: false, trusted: false });
  });
});

describe("outputFileFromCommand", () => {
  it("extracts --outputFile=path", () => {
    expect(outputFileFromCommand("npx vitest run --reporter=json --outputFile=out.json")).toBe("out.json");
  });

  it("extracts --outputFile path and quoted forms", () => {
    expect(outputFileFromCommand("npx vitest --outputFile out.json")).toBe("out.json");
    expect(outputFileFromCommand('npx vitest --outputFile="my out.json"')).toBe("my out.json");
    expect(outputFileFromCommand("npx vitest --outputFile='o.json'")).toBe("o.json");
  });

  it("returns null when absent", () => {
    expect(outputFileFromCommand("npm test")).toBeNull();
  });
});

describe("findReport", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "loom-report-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads an explicit --outputFile vitest report", () => {
    writeFileSync(join(cwd, "out.json"), JSON.stringify({ numTotalTests: 3, numFailedTests: 0 }));
    const report = findReport("npx vitest run --reporter=json --outputFile=out.json", cwd, "", Date.now());
    expect(report).toEqual({ total: 3, failed: 0, source: "vitest-json" });
  });

  it("parses JSON from stdout when a JSON reporter was requested", () => {
    const stdout = JSON.stringify({ numTotalTests: 8, numFailedTests: 1 });
    const report = findReport("npx vitest run --reporter=json", cwd, stdout, Date.now());
    expect(report).toEqual({ total: 8, failed: 1, source: "vitest-json" });
  });

  it("finds fresh surefire XML reports", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="4" failures="0" errors="0"/>');
    const report = findReport("mvn test", cwd, "", Date.now());
    expect(report).toEqual({ total: 4, failed: 0, source: "junit-xml" });
  });

  it("finds reports one module level down (multi-module builds)", () => {
    const dir = join(cwd, "core/target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TEST-a.xml"), '<testsuite tests="2" failures="1" errors="0"/>');
    const report = findReport("mvn test", cwd, "", Date.now());
    expect(report).toEqual({ total: 2, failed: 1, source: "junit-xml" });
  });

  it("ignores stale reports — an old artifact cannot vouch for this run", () => {
    const dir = join(cwd, "target/surefire-reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "TEST-a.xml");
    writeFileSync(file, '<testsuite tests="4" failures="0" errors="0"/>');
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(file, old, old);
    expect(findReport("mvn test", cwd, "", Date.now())).toBeNull();
  });

  it("returns null when no artifact exists (echo-spoof shape)", () => {
    expect(findReport('echo "npm test: 5 passing"', cwd, 'npm test: 5 passing', Date.now())).toBeNull();
  });
});
