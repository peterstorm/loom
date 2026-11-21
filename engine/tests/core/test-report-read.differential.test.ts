/**
 * Differential proof for the one structured-test-report read.
 *
 * `readTestReport` replaced two readers of the same bytes: a declared-count
 * reader (`parseVitestJson`, `readJunitReport`, `parseJunitXml`) and an
 * executed-count reader (`parseStructuredTestReportBytes`, `parseJunitTestcases`).
 * Their projections are pinned bytes: `TestReportSummary.total` is stored in
 * Evidence Ledger lines and `ReportCounts` feed digests in completion-check
 * records. `../fixtures/legacy-structured-test-report.ts` is the retired module,
 * frozen verbatim; every projection of the new read must serialize exactly as
 * the retired reader's answer did, for every generated input, including the
 * ones either reader refuses.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  declaredSummary,
  junitReportRead,
  readTestReport,
  readTestReportText,
  reportCounts,
  reportTestcases,
} from "../../src/core/structured-test-report";
import * as legacy from "../fixtures/legacy-structured-test-report";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A summary's wire bytes plus its non-enumerable per-file results. */
const summaryBytes = (summary: { files: unknown } | null): string =>
  summary === null ? "null" : `${JSON.stringify(summary)}|${JSON.stringify(summary.files)}`;

const junitReadBytes = (read: { kind: string; summary?: { files: unknown } }): string =>
  `${read.kind}|${read.summary === undefined ? "" : summaryBytes(read.summary)}`;

/** Every text projection of the new read equals the retired reader's answer. */
function expectSameTextReading(text: string): void {
  const read = readTestReportText(text);
  expect(summaryBytes(declaredSummary(read, "vitest-json"))).toBe(summaryBytes(legacy.parseVitestJson(text)));
  expect(summaryBytes(declaredSummary(read, "junit-xml"))).toBe(summaryBytes(legacy.parseJunitXml(text)));
  expect(junitReadBytes(junitReportRead(read))).toBe(junitReadBytes(legacy.readJunitReport(text)));
}

/** Every byte projection of the new read equals the retired strict reader's answer. */
function expectSameByteReading(bytes: Uint8Array): void {
  const read = readTestReport(bytes);
  expect(JSON.stringify(reportCounts(read))).toBe(JSON.stringify(legacy.parseStructuredTestReportBytes(bytes)));
  expect(JSON.stringify(reportTestcases(read))).toBe(JSON.stringify(legacy.parseJunitTestcases(bytes)));
}

function expectSameReading(text: string): void {
  expectSameTextReading(text);
  expectSameByteReading(encode(text));
}

// --- Vitest JSON ---

const count = fc.oneof(
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(-1, 1.5, "2", null, Number.MAX_SAFE_INTEGER + 2) },
  { weight: 6, arbitrary: fc.nat({ max: 12 }) },
);
const assertionStatus = fc.constantFrom("passed", "failed", "pending", "todo", "skipped", "disabled");
const fileName = fc.constantFrom("a.test.ts", "/repo/b.test.ts", "c.spec.ts", "<testsuite>", "d <testsuites/> e");

const vitestEntry = fc.oneof(
  { weight: 8, arbitrary: fc.record({
    name: fileName,
    status: fc.constantFrom("passed", "failed", "skipped"),
    assertionResults: fc.array(fc.record({ status: assertionStatus }), { maxLength: 5 }),
  }) },
  { weight: 1, arbitrary: fc.record({ name: fileName, status: fc.constant("failed") }) },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(null, 3, { name: 1, status: "passed" }, { name: "x", status: "passed", assertionResults: [{}] }) },
);

/** A report whose summary counts are derived from its entries, so the declared rule usually accepts it; then optionally perturbed. */
const derivedVitest = fc.record({
  entries: fc.array(vitestEntry, { maxLength: 4 }),
  perturb: fc.option(fc.record({ field: fc.constantFrom("numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests", "testResults"), value: count }), { freq: 3 }),
}).map(({ entries, perturb }) => {
  const statuses = entries.flatMap((entry) =>
    typeof entry === "object" && entry !== null && Array.isArray((entry as { assertionResults?: unknown }).assertionResults)
      ? ((entry as { assertionResults: { status: string }[] }).assertionResults).map((a) => a.status)
      : []);
  const report: Record<string, unknown> = {
    numTotalTests: statuses.length,
    numPassedTests: statuses.filter((s) => s === "passed").length,
    numFailedTests: statuses.filter((s) => s === "failed").length,
    numPendingTests: statuses.filter((s) => s === "pending" || s === "skipped" || s === "disabled").length,
    numTodoTests: statuses.filter((s) => s === "todo").length,
    testResults: entries,
  };
  if (perturb !== null) {
    if (perturb.value === undefined) delete report[perturb.field];
    else report[perturb.field] = perturb.value;
  }
  return JSON.stringify(report);
});

const randomVitest = fc.record({
  numTotalTests: count, numPassedTests: count, numFailedTests: count, numPendingTests: count, numTodoTests: count,
  testResults: fc.option(fc.array(vitestEntry, { maxLength: 3 }), { nil: undefined }),
}, { requiredKeys: [] }).map((report) => JSON.stringify(report));

// --- JUnit XML ---

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Leaf = Readonly<{ kind: "case"; name?: string; classname?: string; file?: string; markers: readonly string[] }>;
type Suite = Readonly<{ kind: "suite"; attributes: AttributeMode; children: readonly Tree[] }>;
type Tree = Leaf | Suite;
type AttributeMode = "descendants" | "immediate" | "omitted" | "partial" | "random";

const marker = fc.constantFrom(
  "<failure type=\"AssertionError\"/>", "<error type=\"Error\"/>", "<failure/>",
  "<skipped/>", "<skipped type=\"todo\"/>", "<system-out>x</system-out>",
);
const leafName = fc.option(fc.constantFrom("a", "b", "a.test.ts", "suite > case", " ", "x&y", "<testsuite>"), { freq: 6, nil: undefined });
const leaf: fc.Arbitrary<Leaf> = fc.record({
  kind: fc.constant("case" as const),
  name: leafName,
  classname: fc.option(fc.constantFrom("a.test.ts", "b.test.ts", "a", "", "com.example.T"), { freq: 6, nil: undefined }),
  file: fc.option(fc.constantFrom("a.test.ts", "src/c.test.ts", "/repo/d.test.ts", ""), { freq: 2, nil: undefined }),
  markers: fc.array(marker, { maxLength: 2 }),
});
const attributeMode = fc.constantFrom<AttributeMode>("descendants", "descendants", "descendants", "immediate", "omitted", "partial", "random");

const tree = fc.letrec<{ tree: Tree; suite: Suite }>((tie) => ({
  tree: fc.oneof({ depthSize: "small", withCrossShrink: true }, leaf, tie("suite")),
  suite: fc.record({
    kind: fc.constant("suite" as const),
    attributes: attributeMode,
    children: fc.array(tie("tree"), { maxLength: 4 }),
  }),
})).suite;

type Tally = { tests: number; failed: number; skipped: number; todo: number };
const leafTally = (node: Leaf): Tally => {
  const skippedMarks = node.markers.filter((m) => m.startsWith("<skipped"));
  const failing = node.markers.some((m) => m.startsWith("<failure") || m.startsWith("<error"));
  const todo = skippedMarks.some((m) => m.includes("todo"));
  return {
    tests: 1,
    failed: skippedMarks.length === 0 && failing ? 1 : 0,
    skipped: skippedMarks.length > 0 && !todo ? 1 : 0,
    todo: todo ? 1 : 0,
  };
};
const add = (a: Tally, b: Tally): Tally =>
  ({ tests: a.tests + b.tests, failed: a.failed + b.failed, skipped: a.skipped + b.skipped, todo: a.todo + b.todo });
const ZERO: Tally = { tests: 0, failed: 0, skipped: 0, todo: 0 };
const tallyOf = (node: Tree): Tally => node.kind === "case" ? leafTally(node) : node.children.map(tallyOf).reduce(add, ZERO);
const immediateTally = (node: Suite): Tally =>
  ({ tests: node.children.length, failed: 0, skipped: 0, todo: 0 });

function attributesOf(node: Suite, salt: number): string {
  const tally = node.attributes === "immediate" ? immediateTally(node) : tallyOf(node);
  switch (node.attributes) {
    case "omitted":
      return "";
    case "partial":
      return ` tests="${tally.tests}"`;
    case "random":
      return ` tests="${salt % 5}" failures="${salt % 3}" skipped="${salt % 2}"`;
    default:
      return ` tests="${tally.tests}" failures="${tally.failed}" errors="0" skipped="${tally.skipped + tally.todo}"`;
  }
}

function renderTree(node: Tree, name: "testsuites" | "testsuite", salt: number, comments = ""): string {
  if (node.kind === "case") {
    const attrs = [
      node.name === undefined ? "" : ` name="${escapeXml(node.name)}"`,
      node.classname === undefined ? "" : ` classname="${escapeXml(node.classname)}"`,
      node.file === undefined ? "" : ` file="${escapeXml(node.file)}"`,
    ].join("");
    return `<testcase${attrs}>${node.markers.join("")}</testcase>`;
  }
  const body = node.children.map((child, index) => renderTree(child, "testsuite", salt + index + 1)).join("");
  return `<${name} name="s"${attributesOf(node, salt)}>${body}${comments}</${name}>`;
}

const traditionalJunit = fc.record({ root: tree, rootName: fc.constantFrom<"testsuites" | "testsuite">("testsuites", "testsuite"), salt: fc.nat(30) })
  .map(({ root, rootName, salt }) => `<?xml version="1.0" encoding="UTF-8"?>\n${renderTree(root, rootName, salt)}`);

/** Node's reporter: a testsuites root with direct testcases and describe suites, summarized by root comments. */
const nodeJunit = fc.record({
  root: tree,
  perturb: fc.option(fc.constantFrom("tests", "pass", "fail", "cancelled", "skipped", "todo", "drop-fail", "duplicate"), { freq: 3 }),
  salt: fc.nat(30),
}).map(({ root, perturb, salt }) => {
  const tally = tallyOf(root);
  const counts: Record<string, number> = {
    tests: tally.tests, pass: tally.tests - tally.failed - tally.skipped - tally.todo,
    fail: tally.failed, cancelled: 0, skipped: tally.skipped, todo: tally.todo,
  };
  if (perturb !== null && perturb in counts) counts[perturb] += 1;
  const lines = Object.entries(counts)
    .filter(([name]) => !(perturb === "drop-fail" && name === "fail"))
    .map(([name, value]) => `<!-- ${name} ${value} -->`);
  if (perturb === "duplicate") lines.push("<!-- tests 0 -->");
  return renderTree(root, "testsuites", salt, lines.join("\n"));
});

const oddDocuments = fc.constantFrom(
  "", "   ", "{}", "[]", "null", "3", "\"<testsuite/>\"", "{\"a\":\"<testsuite>\"}",
  "{\"numTotalTests\":1,\"numFailedTests\":0,\"note\":\"<testsuite>\"}",
  "{\"numTotalTests\":1,\"numPassedTests\":1,\"numFailedTests\":0,\"numPendingTests\":0,\"numTodoTests\":0,\"m\":\"<testsuites tests=\\\"1\\\">\"}",
  "<coverage/>", "<failsafe-summary><completed>1</completed></failsafe-summary>",
  "<root><testcase name=\"a\" classname=\"a\"/></root>", "<x:testsuite xmlns:x=\"urn:x\"/>",
  "<testsuite xmlns=\"urn:x\" tests=\"0\"/>", "<!DOCTYPE testsuite><testsuite tests=\"0\"/>",
  "<testsuite tests=\"1\"><testcase name=\"a\" classname=\"a\"/>", "<testsuite tests=\"0\"/><testsuite tests=\"0\"/>",
  "<testsuites/>", "<testsuites tests=\"2\"/>", "<testsuite tests=\"2\" failures=\"1\"/>",
  "<testsuite tests=\"01\"/>", "<testsuite tests=\"-1\"/>", "﻿<testsuite tests=\"0\"/>",
  "not a report", "<testsuite tests=\"1\"><testcase name=\"a\" classname=\"a\"/></testsuite> trailing",
);

const anyDocument = fc.oneof(derivedVitest, randomVitest, traditionalJunit, nodeJunit, oddDocuments, fc.string({ maxLength: 40 }));

describe("readTestReport — one read, projections byte-identical to the retired readers", () => {
  it("Vitest JSON derived from its entries, then perturbed", () => {
    fc.assert(fc.property(derivedVitest, expectSameReading), { numRuns: 1500 });
  });

  it("Vitest JSON with arbitrary summary counts", () => {
    fc.assert(fc.property(randomVitest, expectSameReading), { numRuns: 1000 });
  });

  it("traditional JUnit: nested suites, skipped and todo cases, consistent, partial, omitted and wrong attributes", () => {
    fc.assert(fc.property(traditionalJunit, expectSameReading), { numRuns: 2500 });
  });

  it("the Node JUnit dialect, with exact and perturbed root summaries", () => {
    fc.assert(fc.property(nodeJunit, expectSameReading), { numRuns: 2000 });
  });

  it("documents neither reader accepts, foreign XML and JSON carrying JUnit tags", () => {
    fc.assert(fc.property(fc.oneof(oddDocuments, fc.string({ maxLength: 60 })), expectSameReading), { numRuns: 500 });
  });

  it("bytes that are not UTF-8, and text a shell decoded leniently from them", () => {
    fc.assert(fc.property(anyDocument, fc.nat(), fc.constantFrom(0xff, 0xc3, 0x80), (text, at, byte) => {
      const valid = encode(text);
      const position = valid.length === 0 ? 0 : at % (valid.length + 1);
      const bytes = new Uint8Array([...valid.slice(0, position), byte, ...valid.slice(position)]);
      expectSameByteReading(bytes);
      expectSameTextReading(Buffer.from(bytes).toString("utf-8"));
    }), { numRuns: 1000 });
  });

  it("the byte budget, at and over its edge", () => {
    const { MAX_STRUCTURED_REPORT_BYTES: max } = legacy;
    for (const size of [max, max + 1]) {
      const padded = `<testsuite tests="0">${" ".repeat(size - 34)}</testsuite>`;
      const text = padded.padEnd(size, " ");
      expectSameReading(text);
    }
  });

  it("generators reach every outcome of both rules", () => {
    const seen = new Set<string>();
    fc.assert(fc.property(anyDocument, (text) => {
      const read = readTestReportText(text);
      const counts = reportCounts(read);
      seen.add(counts.ok ? `counts:${counts.value.source}` : `counts:${counts.error.reason}`);
      seen.add(`junit:${junitReportRead(read).kind}`);
      seen.add(`vitest:${declaredSummary(read, "vitest-json") === null ? "null" : "summary"}`);
      const testcases = reportTestcases(read);
      seen.add(testcases.ok ? "testcases:ok" : `testcases:${testcases.error.reason}`);
    }), { numRuns: 3000 });
    expect([...seen].sort()).toEqual([
      "counts:ambiguous-format", "counts:junit-xml", "counts:malformed-counts", "counts:unrecognized-format", "counts:vitest-json",
      "junit:not-junit", "junit:parsed", "junit:refused",
      "testcases:ambiguous-format", "testcases:malformed-counts", "testcases:malformed-testcase", "testcases:ok", "testcases:unrecognized-format",
      "vitest:null", "vitest:summary",
    ]);
  });
});
