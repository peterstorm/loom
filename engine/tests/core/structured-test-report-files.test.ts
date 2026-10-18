/**
 * Per-file results on TestReportSummary (G4 slice 2, AD-2, INV-8 owner).
 *
 * Unit and property tests over the owner module: the reconcile laws of
 * `reconcileFileResults`, the per-file projection of the Vitest JSON and JUnit
 * parsers, `mergeSummaries` merging per-file results, and the wire-compatibility
 * law that an unrecorded summary keeps the exact pre-feature keys and bytes.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  mergeSummaries,
  parseJunitXml,
  parseReportCounts,
  parseReportSummary,
  parseStructuredTestReportBytes,
  parseVitestJson,
  readJunitReport,
  reconcileFileResults,
  type TestFileResult,
  type TestReportFiles,
  type TestReportSummary,
} from "../../src/core/structured-test-report";
import { judgeTestRun } from "../../src/machine/test-report";
import { reportSummary } from "../machine/report-summary";

const result = (file: string, executed: number, failed: number, collectionError = false, skipped = 0): TestFileResult =>
  ({ file, executed, failed, skipped, collectionError });

const recorded = (results: readonly TestFileResult[]): TestReportFiles => ({ kind: "recorded", results });

const sum = (results: readonly TestFileResult[], field: "executed" | "failed"): number =>
  results.reduce((total, entry) => total + entry[field], 0);

const mint = (
  results: readonly TestFileResult[],
  source: TestReportSummary["source"] = "junit-xml",
): TestReportSummary | null => parseReportSummary(sum(results, "executed"), sum(results, "failed"), source, recorded(results));

const bytes = (content: string): Uint8Array => new TextEncoder().encode(content);

// --- Generators ---

/** A behavioral (non-collection-error) per-file result under either format. */
const behavioralResult = (file: string) =>
  fc.integer({ min: 0, max: 20 }).chain((executed) =>
    fc.integer({ min: 0, max: executed }).chain((failed) =>
      fc.integer({ min: 0, max: executed - failed }).map((skipped) => result(file, executed, failed, false, skipped))));

/** Distinct-file per-file results, valid under both formats' rules. */
const resultsArb = fc.uniqueArray(fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}\.test\.ts$/u), { maxLength: 6 })
  .chain((files) => fc.tuple(...files.map(behavioralResult)) as fc.Arbitrary<TestFileResult[]>);

const sourceArb = fc.constantFrom<TestReportSummary["source"]>("junit-xml", "vitest-json");

describe("reconcileFileResults (INV-8 reconcile laws)", () => {
  it("FR-003: per-file results whose sums equal the summary counts are accepted unchanged", () => {
    fc.assert(fc.property(resultsArb, sourceArb, (results, source) => {
      const reconciled = reconcileFileResults(source, sum(results, "executed"), sum(results, "failed"), recorded(results));
      expect(reconciled).toEqual({ ok: true, value: recorded(results) });
    }));
  });

  it("FR-003: any executed or failed sum that disagrees with the summary counts is refused", () => {
    fc.assert(fc.property(
      resultsArb,
      sourceArb,
      fc.integer({ min: -3, max: 3 }).filter((delta) => delta !== 0),
      fc.boolean(),
      (results, source, delta, perturbTotal) => {
        const total = sum(results, "executed") + (perturbTotal ? delta : 0);
        const failed = sum(results, "failed") + (perturbTotal ? 0 : delta);
        expect(reconcileFileResults(source, total, failed, recorded(results)).ok).toBe(false);
      },
    ));
  });

  it("FR-004: absent per-file results read as unrecorded, under any sane counts", () => {
    fc.assert(fc.property(fc.nat(50), fc.nat(50), sourceArb, (a, b, source) => {
      const total = Math.max(a, b);
      expect(reconcileFileResults(source, total, Math.min(a, b), undefined)).toEqual({ ok: true, value: { kind: "unrecorded" } });
    }));
  });

  it("AS-002: a per-file shape that is not exactly a TestReportFiles is refused with a named reason", () => {
    const shapes: readonly unknown[] = [
      null,
      "recorded",
      { kind: "partial", results: [] },
      { kind: "recorded" },
      { kind: "recorded", results: {} },
      { kind: "recorded", results: [], extra: true },
      { kind: "unrecorded", results: [] },
      { kind: "recorded", results: [{ file: "a.test.ts", executed: 1, failed: 0 }] },
      // The four-field shape that predates `skipped` is refused, never defaulted.
      { kind: "recorded", results: [{ file: "a.test.ts", executed: 1, failed: 0, collectionError: false }] },
      { kind: "recorded", results: [result("a.test.ts", 1, 0, false, 2)] },
      { kind: "recorded", results: [{ ...result("a.test.ts", 1, 0), note: "x" }] },
      { kind: "recorded", results: [result(" ", 1, 0)] },
      { kind: "recorded", results: [result("a.test.ts", 1, 2)] },
      { kind: "recorded", results: [result("a.test.ts", Number.MAX_SAFE_INTEGER + 1, 0)] },
      { kind: "recorded", results: [result("a.test.ts", 1, 0), result("a.test.ts", 0, 0)] },
    ];
    for (const files of shapes) {
      const reconciled = reconcileFileResults("junit-xml", 1, 0, files);
      expect(reconciled.ok, JSON.stringify(files)).toBe(false);
      if (!reconciled.ok) expect(reconciled.error.kind).toBe("unreconciled-file-results");
    }
  });

  it("FR-001: a collection error must look like one under the report format's own rule", () => {
    // JUnit: the synthetic testcase is itself a failing testcase.
    expect(reconcileFileResults("junit-xml", 1, 1, recorded([result("a.test.ts", 1, 1, true)])).ok).toBe(true);
    expect(reconcileFileResults("junit-xml", 1, 0, recorded([result("a.test.ts", 1, 0, true)])).ok).toBe(false);
    // Vitest JSON: a file that never collected contributes no test.
    expect(reconcileFileResults("vitest-json", 0, 0, recorded([result("/r/a.test.ts", 0, 0, true)])).ok).toBe(true);
    expect(reconcileFileResults("vitest-json", 1, 1, recorded([result("/r/a.test.ts", 1, 1, true)])).ok).toBe(false);
  });
});

describe("parseReportSummary with per-file results (sole constructor)", () => {
  it("AS-002: a summary exists only when its per-file results reconcile with its counts", () => {
    fc.assert(fc.property(resultsArb, sourceArb, (results, source) => {
      const summary = mint(results, source);
      expect(summary).not.toBeNull();
      expect(summary?.files).toEqual(recorded(results));
      expect(parseReportSummary(sum(results, "executed") + 1, sum(results, "failed"), source, recorded(results))).toBeNull();
    }));
  });

  it("AS-003: a TestRun summary with absent per-file results carries files unrecorded but keeps the pre-feature JSON bytes", () => {
    const summary = parseReportSummary(5, 2, "junit-xml", undefined);
    expect(summary?.files).toEqual({ kind: "unrecorded" });
    expect(summary !== null && "files" in summary).toBe(true);
    expect(Object.keys(summary ?? {})).toEqual(["total", "failed", "source"]);
    expect(JSON.stringify(summary)).toBe('{"total":5,"failed":2,"source":"junit-xml"}');
  });

  it("FR-004: counts alone have exactly the three pre-feature own keys, for exact-key wire records", () => {
    const counts = parseReportCounts(5, 2, "junit-xml");
    expect(counts).not.toBeNull();
    expect(Reflect.ownKeys(counts ?? {})).toEqual(["total", "failed", "source"]);
    expect("files" in (counts ?? {})).toBe(false);
  });

  it("FR-004: counts alone can never stand as a TestRun fact's report", () => {
    // @ts-expect-error ReportCounts carries no per-file results, so it is not a TestReportSummary.
    const asTestRunReport: TestReportSummary | null = parseReportCounts(5, 2, "junit-xml");
    expect(asTestRunReport).not.toBeNull();
  });

  it("AS-001: a recorded summary serializes its per-file results and is deeply frozen", () => {
    const summary = mint([result("tests/a.test.ts", 2, 1)]);
    expect(JSON.parse(JSON.stringify(summary))).toEqual({
      total: 2, failed: 1, source: "junit-xml",
      files: { kind: "recorded", results: [{ file: "tests/a.test.ts", executed: 2, failed: 1, skipped: 0, collectionError: false }] },
    });
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary?.files)).toBe(true);
    if (summary?.files?.kind === "recorded") {
      expect(Object.isFrozen(summary.files.results)).toBe(true);
      expect(Object.isFrozen(summary.files.results[0])).toBe(true);
    }
  });

  it("FR-003: the minted per-file results are a re-minted copy, never the caller's objects", () => {
    const input: { file: string; executed: number; failed: number; skipped: number; collectionError: boolean }[] =
      [{ file: "tests/a.test.ts", executed: 1, failed: 0, skipped: 0, collectionError: false }];
    const summary = mint(input);
    input[0]!.failed = 1;
    expect(summary?.files).toEqual(recorded([result("tests/a.test.ts", 1, 0)]));
  });
});

describe("Vitest JSON per-file projection", () => {
  const report = (testResults: unknown, counts = { total: 3, passed: 2, failed: 1 }) => JSON.stringify({
    numTotalTests: counts.total, numPassedTests: counts.passed, numFailedTests: counts.failed,
    numPendingTests: 0, numTodoTests: 0, testResults,
  });
  const assertion = (status: string) => ({ status, title: status, ancestorTitles: [], failureMessages: [] });

  it("AS-001: each testResults entry becomes one file under its reported name, with executed and failed assertions", () => {
    const summary = parseVitestJson(report([
      { name: "/repo/tests/a.test.ts", status: "passed", assertionResults: [assertion("passed")] },
      { name: "/repo/tests/b.test.ts", status: "failed", assertionResults: [assertion("passed"), assertion("failed")] },
    ]));
    expect(summary?.files).toEqual(recorded([
      result("/repo/tests/a.test.ts", 1, 0),
      result("/repo/tests/b.test.ts", 2, 1),
    ]));
  });

  it("FR-001: a failed entry with no assertionResults is a collection error, not a failing testcase", () => {
    const summary = parseVitestJson(report([
      { name: "/repo/tests/broken.test.ts", status: "failed", assertionResults: [], message: "Cannot find module" },
      { name: "/repo/tests/b.test.ts", status: "failed", assertionResults: [assertion("passed"), assertion("passed"), assertion("failed")] },
    ]));
    expect(summary?.files).toEqual(recorded([
      result("/repo/tests/broken.test.ts", 0, 0, true),
      result("/repo/tests/b.test.ts", 3, 1),
    ]));
  });

  it("FR-006: an assertion that neither passed nor failed is a declared testcase that never ran", () => {
    const summary = parseVitestJson(report(
      [{
        name: "/repo/tests/a.test.ts",
        status: "passed",
        assertionResults: [assertion("passed"), assertion("skipped"), assertion("pending"), assertion("todo")],
      }],
      { total: 4, passed: 1, failed: 0 },
    ));
    expect(summary?.files).toEqual(recorded([result("/repo/tests/a.test.ts", 4, 0, false, 3)]));
  });

  it("FR-004: a report without testResults keeps its summary with per-file results unrecorded", () => {
    expect(parseVitestJson(JSON.stringify({ numTotalTests: 4, numFailedTests: 0 }))?.files).toEqual({ kind: "unrecorded" });
  });

  it("AS-002: testResults that are malformed or contradict the counts make the report untrusted", () => {
    const valid = { name: "/repo/tests/a.test.ts", status: "failed", assertionResults: [assertion("passed"), assertion("passed"), assertion("failed")] };
    for (const testResults of [
      "tests",
      [{ ...valid, name: "" }],
      [{ ...valid, name: 7 }],
      [{ ...valid, assertionResults: "none" }],
      [{ ...valid, assertionResults: [null] }],
      [{ ...valid, assertionResults: [{ title: "no status" }] }],
      [valid, valid],
      [{ ...valid, assertionResults: [assertion("passed")] }],
    ]) {
      expect(parseVitestJson(report(testResults)), JSON.stringify(testResults)).toBeNull();
    }
  });
});

describe("JUnit per-file projection", () => {
  it("AS-001: testcases group by classname, and a synthetic testcase named after its classname is a collection error", () => {
    const summary = parseJunitXml(`<testsuites tests="4" failures="2">
      <testsuite name="tests/broken.test.ts" tests="1" failures="1">
        <testcase classname="tests/broken.test.ts" name="tests/broken.test.ts"><failure type="Error"/></testcase>
      </testsuite>
      <testsuite name="tests/red.test.ts" tests="3" failures="1">
        <testcase classname="tests/red.test.ts" name="passes"/>
        <testcase classname="tests/red.test.ts" name="skips"><skipped/></testcase>
        <testcase classname="tests/red.test.ts" name="fails"><failure type="AssertionError"/></testcase>
      </testsuite>
    </testsuites>`);
    expect(summary).toMatchObject({ total: 4, failed: 2, source: "junit-xml" });
    expect(summary?.files).toEqual(recorded([
      result("tests/broken.test.ts", 1, 1, true),
      result("tests/red.test.ts", 3, 1, false, 1),
    ]));
  });

  it("AS-001: one classname reported under several suites is one file", () => {
    const summary = parseJunitXml(`<testsuites>
      <testsuite tests="1"><testcase classname="com.example.A" name="one"/></testsuite>
      <testsuite tests="1" failures="1"><testcase classname="com.example.A" name="two"><failure/></testcase></testsuite>
    </testsuites>`);
    expect(summary?.files).toEqual(recorded([result("com.example.A", 2, 1)]));
  });

  it("FR-004: summary-only reports and testcases without a classname keep the summary with per-file results unrecorded", () => {
    expect(parseJunitXml('<testsuite tests="3" failures="1"/>')?.files).toEqual({ kind: "unrecorded" });
    const unattributed = parseJunitXml('<testsuite tests="2"><testcase classname="a" name="x"/><testcase name="y"/></testsuite>');
    expect(unattributed).toMatchObject({ total: 2, failed: 0 });
    expect(unattributed?.files).toEqual({ kind: "unrecorded" });
  });

  it("AS-002: a JUnit report whose testcases contradict its counts stays untrusted", () => {
    expect(parseJunitXml('<testsuite tests="2" failures="0"><testcase classname="a" name="x"/></testsuite>')).toBeNull();
  });

  it("AS-002: Maven failsafe's failsafe-summary.xml is not a JUnit report at all, so it is told apart from a refused one", () => {
    // The real failsafe default: written beside TEST-*.xml in target/failsafe-reports.
    const failsafeSummary = `<?xml version="1.0" encoding="UTF-8"?>
<failsafe-summary xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="https://maven.apache.org/surefire/maven-surefire-plugin/xsd/failsafe-summary.xsd" result="255" timeout="false">
    <completed>3</completed>
    <errors>0</errors>
    <failures>1</failures>
    <skipped>0</skipped>
    <failureMessage xsi:nil="true" />
</failsafe-summary>`;
    expect(readJunitReport(failsafeSummary)).toEqual({ kind: "not-junit" });
    expect(readJunitReport("<coverage><package name=\"a\"/></coverage>")).toEqual({ kind: "not-junit" });
    expect(parseJunitXml(failsafeSummary)).toBeNull();
  });

  it("AS-002: a malformed or unreconciled JUnit report is refused, never mistaken for a non-report document", () => {
    for (const refused of [
      '<testsuite tests="1" failures="2"/>', // impossible counts
      '<testsuite tests="2" failures="0"><testcase classname="a" name="x"/></testsuite>', // unreconciled
      "<testsuite>", // unterminated
      "<testcase classname=\"a\" name=\"x\"/>", // a bare testcase root is JUnit-shaped, not foreign
      "<wrapper><testsuite tests=\"1\"/></wrapper>", // JUnit content under a foreign root
      '<x:testsuite xmlns:x="urn:x" tests="1"/>', // a namespaced JUnit root
      "not xml at all", // undeterminable: fail closed
      "",
    ]) {
      expect(readJunitReport(refused), refused).toEqual({ kind: "refused" });
    }
  });

  it("AS-001: a valid JUnit report parses to the same summary parseJunitXml mints", () => {
    const xml = '<testsuite tests="2" failures="1"><testcase classname="a" name="x"/><testcase classname="a" name="y"><failure/></testcase></testsuite>';
    const read = readJunitReport(xml);
    expect(read.kind).toBe("parsed");
    expect(read.kind === "parsed" ? read.summary : null).toEqual(parseJunitXml(xml));
    expect(read.kind === "parsed" ? read.summary.files : null).toEqual(recorded([result("a", 2, 1)]));
  });

  it("AS-004: per-file identity is the classname exactly as written, never derived from anything else", () => {
    const summary = parseJunitXml('<testsuite name="ignored-suite-name" file="ignored/file.ts" tests="1"><testcase classname="./weird path/x.test.ts" name="t" file="other.ts"/></testsuite>');
    expect(summary?.files).toEqual(recorded([result("./weird path/x.test.ts", 1, 0)]));
  });
});

describe("strict structured-report parser keeps the remediation wire shape", () => {
  it("FR-004: executed-count summaries are counts alone and keep exactly total, failed and source", () => {
    const parsed = parseStructuredTestReportBytes(bytes('<testsuite tests="2" failures="1"><testcase classname="a" name="x"/><testcase classname="a" name="y"><failure/></testcase></testsuite>'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect("files" in parsed.value).toBe(false);
    expect(Reflect.ownKeys(parsed.value)).toEqual(["total", "failed", "source"]);
  });
});

describe("mergeSummaries merges per-file results", () => {
  it("AS-001: merging recorded summaries lists every file once, summing a file reported in several reports", () => {
    const merged = mergeSummaries([
      mint([result("com.example.A", 2, 1)])!,
      mint([result("com.example.B", 1, 0), result("com.example.A", 1, 0)])!,
    ]);
    expect(merged).toMatchObject({ total: 4, failed: 1, source: "junit-xml" });
    expect(merged?.files).toEqual(recorded([result("com.example.A", 3, 1), result("com.example.B", 1, 0)]));
  });

  it("FR-004: one unrecorded part makes the merged per-file results unrecorded, never a partial list", () => {
    const merged = mergeSummaries([mint([result("com.example.A", 2, 1)])!, reportSummary(3, 0, "junit-xml")]);
    expect(merged).toMatchObject({ total: 5, failed: 1 });
    expect(merged?.files).toEqual({ kind: "unrecorded" });
  });

  it("FR-003: merge is associative over per-file results and counts", () => {
    const summaryArb = fc.tuple(resultsArb, fc.boolean()).map(([results, legacy]) =>
      legacy ? reportSummary(sum(results, "executed"), sum(results, "failed"), "junit-xml") : mint(results)!);
    fc.assert(fc.property(summaryArb, summaryArb, summaryArb, (a, b, c) => {
      const flat = mergeSummaries([a, b, c]);
      const left = mergeSummaries([mergeSummaries([a, b])!, c]);
      const right = mergeSummaries([a, mergeSummaries([b, c])!]);
      expect(left).toEqual(flat);
      expect(left?.files).toEqual(flat?.files);
      expect(right).toEqual(flat);
      expect(right?.files).toEqual(flat?.files);
    }));
  });
});

describe("judgeTestRun over per-file results", () => {
  /** Vitest JSON counts no testcase for a file that failed to import, so a run
   *  whose only failure is a collection error reports numFailedTests: 0. */
  const collectionOnly = parseVitestJson(JSON.stringify({
    numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [
      { name: "/repo/tests/broken.test.ts", status: "failed", message: "Cannot find module", assertionResults: [] },
      { name: "/repo/tests/green.test.ts", status: "passed", assertionResults: [{ status: "passed" }, { status: "passed" }] },
    ],
  }));

  it("FR-001: a run whose only failure is a recorded collection error is a trusted fail, never a trusted pass", () => {
    expect(collectionOnly).toMatchObject({ total: 2, failed: 0, source: "vitest-json" });
    expect(judgeTestRun(0, collectionOnly)).toEqual({ verdict: "trusted-fail" });
    expect(judgeTestRun(null, collectionOnly)).toEqual({ verdict: "trusted-fail" });
  });

  it("FR-004: unrecorded summaries are judged on their counts alone", () => {
    expect(judgeTestRun(0, parseVitestJson(JSON.stringify({ numTotalTests: 2, numFailedTests: 0 })))).toEqual({ verdict: "trusted-pass" });
    expect(judgeTestRun(0, reportSummary(2, 0, "junit-xml"))).toEqual({ verdict: "trusted-pass" });
    expect(judgeTestRun(0, mint([result("tests/green.test.ts", 2, 0)]))).toEqual({ verdict: "trusted-pass" });
  });
});
