/**
 * CT-1 acceptance: per-file results on TestRun facts.
 *
 * Capture is driven through `findReport`, the one report-discovery shell both
 * harness recorders call, against on-disk reports in the shapes the real
 * runners write: a Vitest JUnit report in Loom's completion-report directory,
 * a Vitest JSON report named by `--outputFile`, and Surefire JUnit reports in
 * `target/surefire-reports`. Read-back is driven through `parseEvidenceLine`,
 * the ledger's one line parser. Per-file results are read off the summary's
 * own `files` field, which every TestRun summary carries; only a missing
 * summary reads as `undefined`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestFileResult, TestReportFiles } from "../../src/core/red-then-green-types";
import { parseEvidenceLine } from "../../src/machine/evidence";
import { findReport } from "../../src/machine/report-discovery";
import type { Evidence, TestReportSummary } from "../../src/machine/types";

const EPOCH = "agent-7:code-implementer-agent";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loom-ct1-per-file-"));
  cleanup.push(dir);
  return dir;
}

function writeReport(dir: string, relativePath: string, content: string): string {
  const path = join(dir, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** The call started a moment before the report was written, as the PreToolUse stamp records it. */
const times = () => ({ nowMs: Date.now(), callStartMs: Date.now() - 1_000 });

// --- Real report shapes ---

/** Vitest 3 `--reporter=junit`: testcase classname is the file relative to the
 *  Vitest root; a file that failed to import is one synthetic testcase whose
 *  name equals its classname. */
const VITEST_JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="5" failures="2" errors="0" time="0.008966629">
    <testsuite name="tests/broken.test.ts" timestamp="2026-10-16T10:57:36.724Z" hostname="probe" tests="1" failures="1" errors="0" skipped="0" time="0">
        <testcase classname="tests/broken.test.ts" name="tests/broken.test.ts" time="0">
            <failure message="Cannot find module &apos;../missing&apos; imported from &apos;tests/broken.test.ts&apos;" type="Error">
Error: Cannot find module &apos;../missing&apos; imported from &apos;tests/broken.test.ts&apos;
 ❯ tests/broken.test.ts:2:1
Serialized Error: { code: &apos;ERR_MODULE_NOT_FOUND&apos; }
            </failure>
        </testcase>
    </testsuite>
    <testsuite name="tests/green.test.ts" timestamp="2026-10-16T10:57:36.728Z" hostname="probe" tests="2" failures="0" errors="0" skipped="0" time="0.002055458">
        <testcase classname="tests/green.test.ts" name="ledger &gt; AS-001: debits" time="0.000981755">
        </testcase>
        <testcase classname="tests/green.test.ts" name="ledger &gt; credits" time="0.00023293">
        </testcase>
    </testsuite>
    <testsuite name="tests/red.test.ts" timestamp="2026-10-16T10:57:36.729Z" hostname="probe" tests="2" failures="1" errors="0" skipped="0" time="0.006911171">
        <testcase classname="tests/red.test.ts" name="passes" time="0.000953099">
        </testcase>
        <testcase classname="tests/red.test.ts" name="fails" time="0.004782161">
            <failure message="expected 1 to be 2 // Object.is equality" type="AssertionError">
AssertionError: expected 1 to be 2 // Object.is equality
 ❯ tests/red.test.ts:3:29
            </failure>
        </testcase>
    </testsuite>
</testsuites>
`;

/** Vitest 3 `--reporter=json`: `testResults[].name` is the absolute file path;
 *  a file that failed to import is a failed entry with no assertionResults and
 *  contributes no test to the totals. */
function vitestJson(dir: string): string {
  return JSON.stringify({
    numTotalTestSuites: 4,
    numPassedTestSuites: 2,
    numFailedTestSuites: 2,
    numPendingTestSuites: 0,
    numTotalTests: 4,
    numPassedTests: 3,
    numFailedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
    snapshot: {
      added: 0, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [], filesUnmatched: 0,
      filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0,
      didUpdate: false,
    },
    startTime: 1792148255682,
    success: false,
    testResults: [
      {
        assertionResults: [],
        startTime: 1792148255900,
        endTime: 1792148255900,
        status: "failed",
        message: `Cannot find module '../missing' imported from '${dir}/tests/broken.test.ts'`,
        name: `${dir}/tests/broken.test.ts`,
      },
      {
        assertionResults: [
          { ancestorTitles: ["ledger"], fullName: "ledger AS-001: debits", status: "passed", title: "AS-001: debits", duration: 1, failureMessages: [], meta: {} },
          { ancestorTitles: ["ledger"], fullName: "ledger credits", status: "passed", title: "credits", duration: 0, failureMessages: [], meta: {} },
        ],
        startTime: 1792148255901,
        endTime: 1792148255903,
        status: "passed",
        message: "",
        name: `${dir}/tests/green.test.ts`,
      },
      {
        assertionResults: [
          { ancestorTitles: [], fullName: "passes", status: "passed", title: "passes", duration: 1, failureMessages: [], meta: {} },
          { ancestorTitles: [], fullName: "fails", status: "failed", title: "fails", duration: 4, failureMessages: ["AssertionError: expected 1 to be 2 // Object.is equality"], meta: {} },
        ],
        startTime: 1792148255902,
        endTime: 1792148255908,
        status: "failed",
        message: "",
        name: `${dir}/tests/red.test.ts`,
      },
    ],
  });
}

/** Maven Surefire 3: one TEST-<class>.xml per test class; classname is the JVM class. */
function surefireReport(className: string, cases: readonly Readonly<{ name: string; failure?: string }>[]): string {
  const failures = cases.filter((testcase) => testcase.failure !== undefined).length;
  const body = cases.map((testcase) => testcase.failure === undefined
    ? `  <testcase name="${testcase.name}" classname="${className}" time="0.004"/>`
    : `  <testcase name="${testcase.name}" classname="${className}" time="0.012">
    <failure message="${testcase.failure}" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: ${testcase.failure}
	at ${className}.${testcase.name}(${className.split(".").at(-1)}.java:21)
]]></failure>
  </testcase>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/maven-surefire-plugin/xsd/surefire-test-report.xsd" version="3.0.2" name="${className}" time="0.041" tests="${cases.length}" errors="0" skipped="0" failures="${failures}">
  <properties>
    <property name="java.version" value="21.0.2"/>
  </properties>
${body}
</testsuite>
`;
}

// --- Reading per-file results off a summary ---

/** The per-file results a summary carries; `undefined` only when there is no summary. */
const filesOf = (summary: TestReportSummary | null): TestReportFiles | undefined => summary?.files;

const isRecorded = (files: TestReportFiles | undefined): files is Extract<TestReportFiles, { kind: "recorded" }> =>
  files?.kind === "recorded";

const byFile = (left: TestFileResult, right: TestFileResult): number =>
  left.file < right.file ? -1 : left.file > right.file ? 1 : 0;

/** A summary's per-file results with the results in file order, so assertions
 *  decide which files were recorded and how, not the order they were listed. */
function perFile(summary: TestReportSummary | null): TestReportFiles | undefined {
  const files = filesOf(summary);
  return isRecorded(files) ? { kind: "recorded", results: [...files.results].sort(byFile) } : files;
}

const recorded = (results: readonly TestFileResult[]): TestReportFiles =>
  ({ kind: "recorded", results: [...results].sort(byFile) });

const result = (file: string, executed: number, failed: number, collectionError = false): TestFileResult =>
  ({ file, executed, failed, skipped: 0, collectionError });

// --- Ledger lines ---

function testRunLine(report: unknown, exit: number | null = 1): string {
  return JSON.stringify({
    epoch: EPOCH,
    event: { kind: "TestRun", command: "npm --prefix engine run test:unit", exit, report },
    callId: "toolu_ct1",
  });
}

/** The TestRun a ledger line reads back as; the line itself must stay readable. */
function readBack(line: string): Extract<Evidence, { kind: "TestRun" }> {
  const parsed = parseEvidenceLine(line);
  expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value.event.kind).toBe("TestRun");
  if (parsed.value.event.kind !== "TestRun") throw new Error("the line read back as another event kind");
  return parsed.value.event;
}

const CONSISTENT_RESULTS: readonly TestFileResult[] = [
  result("tests/broken.test.ts", 1, 1, true),
  result("tests/green.test.ts", 2, 0),
  result("tests/red.test.ts", 2, 1),
];

const reportWith = (files: unknown, total = 5, failed = 2) =>
  ({ total, failed, source: "junit-xml", files });

describe("TestRun per-file results at capture (CT-1)", () => {
  it("AS-001: a Vitest JUnit report records each reported test file with its executed and failed testcases", () => {
    const dir = projectDir();
    writeReport(dir, ".loom/completion-reports/verify.junit.xml", VITEST_JUNIT);

    const summary = findReport("npx vitest run --reporter=junit", dir, "", times());

    expect(summary).toMatchObject({ total: 5, failed: 2, source: "junit-xml" });
    expect(perFile(summary)).toEqual(recorded([
      result("tests/broken.test.ts", 1, 1, true),
      result("tests/green.test.ts", 2, 0),
      result("tests/red.test.ts", 2, 1),
    ]));
  });

  it("AS-001: a Vitest JSON report records each test file under the name the report gives it", () => {
    const dir = projectDir();
    const report = writeReport(dir, "reports/vitest.json", vitestJson(dir));

    const summary = findReport(`npx vitest run --reporter=json --outputFile=${report}`, dir, "", times());

    expect(summary).toMatchObject({ total: 4, failed: 1, source: "vitest-json" });
    expect(perFile(summary)).toEqual(recorded([
      result(`${dir}/tests/broken.test.ts`, 0, 0, true),
      result(`${dir}/tests/green.test.ts`, 2, 0),
      result(`${dir}/tests/red.test.ts`, 2, 1),
    ]));
  });

  it("AS-001: Surefire reports from one Maven run record each test class once", () => {
    const dir = projectDir();
    writeReport(dir, "target/surefire-reports/TEST-com.example.ledger.LedgerTest.xml", surefireReport(
      "com.example.ledger.LedgerTest",
      [{ name: "debitLowersBalance" }, { name: "creditRaisesBalance", failure: "expected: &lt;10&gt; but was: &lt;0&gt;" }],
    ));
    writeReport(dir, "target/surefire-reports/TEST-com.example.ledger.ReplayTest.xml", surefireReport(
      "com.example.ledger.ReplayTest",
      [{ name: "replayChangesNothing" }],
    ));

    const summary = findReport("mvn test", dir, "", times());

    expect(summary).toMatchObject({ total: 3, failed: 1, source: "junit-xml" });
    expect(perFile(summary)).toEqual(recorded([
      result("com.example.ledger.LedgerTest", 2, 1),
      result("com.example.ledger.ReplayTest", 1, 0),
    ]));
  });

  it("FR-001: a file whose only failure is a collection error is distinguishable from a file with a failing testcase", () => {
    const dir = projectDir();
    writeReport(dir, ".loom/completion-reports/verify.junit.xml", VITEST_JUNIT);
    const junit = perFile(findReport("npx vitest run --reporter=junit", dir, "", times()));
    const json = perFile(findReport(
      `npx vitest run --reporter=json --outputFile=${writeReport(dir, "reports/vitest.json", vitestJson(dir))}`,
      dir,
      "",
      times(),
    ));

    for (const [files, broken, red] of [
      [junit, "tests/broken.test.ts", "tests/red.test.ts"],
      [json, `${dir}/tests/broken.test.ts`, `${dir}/tests/red.test.ts`],
    ] as const) {
      expect(isRecorded(files)).toBe(true);
      if (!isRecorded(files)) continue;
      expect(files.results.find(({ file }) => file === broken)).toMatchObject({ collectionError: true });
      expect(files.results.find(({ file }) => file === red)).toMatchObject({ failed: 1, skipped: 0, collectionError: false });
    }
  });

  it("AS-001: the recorded per-file results survive the ledger round trip alongside command, exit and counts", () => {
    const dir = projectDir();
    writeReport(dir, ".loom/completion-reports/verify.junit.xml", VITEST_JUNIT);
    const summary = findReport("npx vitest run --reporter=junit", dir, "", times());

    const run = readBack(testRunLine(summary, 1));

    expect(run).toMatchObject({
      command: "npm --prefix engine run test:unit",
      exit: 1,
      report: { total: 5, failed: 2, source: "junit-xml" },
    });
    expect(perFile(run.report)).toEqual(recorded(CONSISTENT_RESULTS));
  });

  it("AS-004: a command that names one test file records exactly the files its report lists", () => {
    const dir = projectDir();
    const report = writeReport(dir, "reports/vitest.json", vitestJson(dir));

    const summary = findReport(
      `npx vitest run tests/green.test.ts tests/never-reported.test.ts --reporter=json --outputFile=${report}`,
      dir,
      "",
      times(),
    );

    const files = filesOf(summary);
    expect(isRecorded(files)).toBe(true);
    if (!isRecorded(files)) return;
    expect(files.results.map(({ file }) => file).sort()).toEqual([
      `${dir}/tests/broken.test.ts`,
      `${dir}/tests/green.test.ts`,
      `${dir}/tests/red.test.ts`,
    ]);
    expect(files.results.some(({ file }) => file.endsWith("never-reported.test.ts"))).toBe(false);
  });

  it("FR-002: the capture cwd never rewrites a reported file identity", () => {
    const dir = projectDir();
    const report = writeReport(dir, "reports/vitest.json", vitestJson(dir));
    const command = `npx vitest run tests/green.test.ts --reporter=json --outputFile=${report}`;
    mkdirSync(join(dir, "engine"), { recursive: true });

    const fromRoot = perFile(findReport(command, dir, "", times()));
    const fromSubdirectory = perFile(findReport(command, join(dir, "engine"), "", times()));

    expect(isRecorded(fromRoot)).toBe(true);
    expect(fromSubdirectory).toEqual(fromRoot);
  });
});

describe("TestRun per-file results at ledger read-back (CT-1)", () => {
  it("FR-003: per-file results that agree with the counts read back unchanged, in both report formats", () => {
    const junit = readBack(testRunLine(reportWith({ kind: "recorded", results: CONSISTENT_RESULTS })));
    const vitest = readBack(testRunLine({
      total: 4,
      failed: 1,
      source: "vitest-json",
      files: { kind: "recorded", results: [result("/repo/tests/broken.test.ts", 0, 0, true), result("/repo/tests/green.test.ts", 2, 0), result("/repo/tests/red.test.ts", 2, 1)] },
    }));

    expect(junit.report).toMatchObject({ total: 5, failed: 2, source: "junit-xml" });
    expect(perFile(junit.report)).toEqual(recorded(CONSISTENT_RESULTS));
    expect(perFile(vitest.report)).toEqual(recorded([
      result("/repo/tests/broken.test.ts", 0, 0, true),
      result("/repo/tests/green.test.ts", 2, 0),
      result("/repo/tests/red.test.ts", 2, 1),
    ]));
  });

  it("AS-002: per-file results that contradict the counts make the report untrusted, and the existing count checks still apply", () => {
    const contradictions = [
      // failed per file sums to 1, the summary says 2
      reportWith({ kind: "recorded", results: [result("tests/green.test.ts", 2, 0), result("tests/red.test.ts", 3, 1)] }),
      // executed per file sums to 4, the summary says 5
      reportWith({ kind: "recorded", results: [result("tests/green.test.ts", 2, 1), result("tests/red.test.ts", 2, 1)] }),
      // a run whose counts show failures cannot list no failing file
      reportWith({ kind: "recorded", results: [result("tests/green.test.ts", 5, 0)] }),
    ];
    for (const report of contradictions) {
      const run = readBack(testRunLine(report));
      expect(run.report, JSON.stringify(report.files)).toBeNull();
    }

    const impossibleCounts = readBack(testRunLine(reportWith({ kind: "recorded", results: CONSISTENT_RESULTS }, 1, 2)));
    expect(impossibleCounts.report).toBeNull();
    const fractionalCounts = readBack(testRunLine(reportWith({ kind: "recorded", results: CONSISTENT_RESULTS }, 5.5, 2)));
    expect(fractionalCounts.report).toBeNull();
  });

  it("AS-002: malformed per-file results make the report untrusted while the TestRun fact stays readable", () => {
    const malformed: readonly unknown[] = [
      null,
      "recorded",
      { kind: "partial", results: CONSISTENT_RESULTS },
      { kind: "recorded" },
      { kind: "recorded", results: "tests/red.test.ts" },
      { kind: "recorded", results: [...CONSISTENT_RESULTS.slice(0, 2), { file: "tests/red.test.ts", executed: 2, failed: 1 }] },
      { kind: "recorded", results: [...CONSISTENT_RESULTS.slice(0, 2), result("", 2, 1)] },
      { kind: "recorded", results: [...CONSISTENT_RESULTS.slice(0, 2), result("tests/red.test.ts", -2, 1)] },
      { kind: "recorded", results: [...CONSISTENT_RESULTS.slice(0, 2), result("tests/red.test.ts", 1.5, 1)] },
      { kind: "recorded", results: [...CONSISTENT_RESULTS.slice(0, 2), result("tests/red.test.ts", 0, 1)] },
      { kind: "recorded", results: [...CONSISTENT_RESULTS.slice(0, 2), { file: "tests/red.test.ts", executed: 2, failed: 1, skipped: 0, collectionError: "no" }] },
      { kind: "recorded", results: [result("tests/broken.test.ts", 1, 1, true), result("tests/red.test.ts", 2, 0), result("tests/red.test.ts", 2, 1)] },
    ];
    for (const files of malformed) {
      const run = readBack(testRunLine(reportWith(files)));
      expect(run.command, JSON.stringify(files)).toBe("npm --prefix engine run test:unit");
      expect(run.report, JSON.stringify(files)).toBeNull();
    }
  });

  it("AS-003: a TestRun fact written before per-file results existed reads without error as unrecorded", () => {
    const run = readBack(testRunLine({ total: 5, failed: 2, source: "junit-xml" }, 1));

    expect(run).toMatchObject({ exit: 1, report: { total: 5, failed: 2, source: "junit-xml" } });
    expect(filesOf(run.report)).toEqual({ kind: "unrecorded" });
  });

  it("FR-004: a ledger mixing legacy and per-file TestRun facts reads every line, each with its own per-file state", () => {
    const lines = [
      testRunLine({ total: 3, failed: 0, source: "vitest-json" }, 0),
      testRunLine(reportWith({ kind: "recorded", results: CONSISTENT_RESULTS }), 1),
      testRunLine({ total: 5, failed: 2, source: "junit-xml" }, 1),
    ];

    const runs = lines.map(readBack);

    expect(runs.map(({ report }) => report === null)).toEqual([false, false, false]);
    expect(runs.map(({ report }) => perFile(report))).toEqual([
      { kind: "unrecorded" },
      recorded(CONSISTENT_RESULTS),
      { kind: "unrecorded" },
    ]);
  });
});
