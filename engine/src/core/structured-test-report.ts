/** Shared pure structured-test-report facts and parsers. */

import { SaxesParser } from "saxes";
import type { DomainResult } from "./orchestration-contract/identity";

declare const REPORT_SUMMARY_PARSED: unique symbol;
export type TestReportSummary = Readonly<{
  total: number;
  failed: number;
  source: "vitest-json" | "junit-xml";
}> & { readonly [REPORT_SUMMARY_PARSED]: true };

/** Per-report resource budget, shared by capture, parsing, persistence, and replay. */
export const MAX_STRUCTURED_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_STRUCTURED_REPORT_XML_DEPTH = 128;

// --- Pure parsers ---

/**
 * The single count-sanity gate for every TestReportSummary: a summary that
 * exists has non-negative integer counts with failed ≤ total. Every
 * construction site (the artifact parsers below AND the ledger read-back in
 * evidence.ts) funnels through here, so an impossible-count report can never
 * exist to vouch — fail closed to null (→ the run stays untrusted).
 */
export function parseReportSummary(
  total: unknown,
  failed: unknown,
  source: TestReportSummary["source"],
): TestReportSummary | null {
  if (typeof total !== "number" || typeof failed !== "number") return null;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(failed)) return null;
  if (total < 0 || failed < 0 || failed > total) return null;
  // Sole producer of the branded TestReportSummary: the count-sanity checks
  // above ARE the brand's invariant, so the cast is justified exactly here.
  return Object.freeze({ total, failed, source }) as TestReportSummary;
}

/** vitest `--reporter=json` / jest `--json` share the summary shape. */
export function parseVitestJson(content: string): TestReportSummary | null {
  if (Buffer.byteLength(content, "utf8") > MAX_STRUCTURED_REPORT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  return parseReportSummary(o.numTotalTests, o.numFailedTests, "vitest-json");
}

/** Legacy machine API counts declared tests (including skipped), never P3 executions.
 * XML syntax and report structure are shared with the strict byte parser. */
export function parseJunitXml(content: string): TestReportSummary | null {
  const report = parseJunitDocument(content);
  if (report.root === null) return null;
  const counts = parseTraditionalJunit(report.root);
  return counts === null ? null : parseReportSummary(counts.total, counts.failed, "junit-xml");
}

export type StructuredReportErrorReason =
  | "resource-limit"
  | "invalid-utf8"
  | "unrecognized-format"
  | "ambiguous-format"
  | "malformed-counts"
  | "malformed-testcase";

export type StructuredReportError = Readonly<{
  kind: "invalid-structured-test-report";
  reason: StructuredReportErrorReason;
  message: string;
}>;

export type StructuredReportParseResult = DomainResult<TestReportSummary, StructuredReportError>;

type RecognizedReport = Readonly<{
  recognized: boolean;
  summary: TestReportSummary | null;
}>;

const reportSuccess = (value: TestReportSummary): StructuredReportParseResult =>
  Object.freeze({ ok: true, value });

const reportFailure = (
  reason: StructuredReportErrorReason,
  message: string,
): StructuredReportParseResult => Object.freeze({
  ok: false,
  error: Object.freeze({ kind: "invalid-structured-test-report", reason, message }),
});

function safeCount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

/** Vitest/Jest totals include pending tests; remediation counts only tests that actually ran. */
function parseExecutedVitestSummary(content: string): RecognizedReport {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return Object.freeze({ recognized: false, summary: null });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return Object.freeze({ recognized: false, summary: null });
  }
  const report = raw as Record<string, unknown>;
  const recognized = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"]
    .some((field) => Object.prototype.hasOwnProperty.call(report, field));
  if (!recognized) return Object.freeze({ recognized: false, summary: null });

  const total = safeCount(report.numTotalTests);
  const passed = safeCount(report.numPassedTests);
  const failed = safeCount(report.numFailedTests);
  const pending = safeCount(report.numPendingTests);
  const todo = safeCount(report.numTodoTests);
  if (total === null || passed === null || failed === null || pending === null || todo === null) {
    return Object.freeze({ recognized: true, summary: null });
  }
  const executed = passed + failed;
  const declared = executed + pending + todo;
  const summary = Number.isSafeInteger(declared) && declared === total
    ? parseReportSummary(executed, failed, "vitest-json")
    : null;
  return Object.freeze({ recognized: true, summary });
}

type ReportElement = Readonly<{
  name: string;
  attributes: Readonly<Record<string, string>>;
  children: readonly ReportElement[];
  comments: readonly string[];
}>;

/** Saxes owns the XML grammar. Local builder mutation never escapes this pure parse.
 * No DTD is accepted and no entity resolver is installed; predefined/numeric
 * XML entities are decoded by saxes, not by report-specific string rewriting. */
function parseJunitDocument(content: string): Readonly<{ recognized: boolean; root: ReportElement | null }> {
  type Builder = { name: string; attributes: Record<string, string>; children: Builder[]; comments: string[] };
  if (Buffer.byteLength(content, "utf8") > MAX_STRUCTURED_REPORT_BYTES) return { recognized: false, root: null };
  const stack: Builder[] = [];
  const roots: Builder[] = [];
  let invalid = false;
  let recognized = false;
  let depthExceeded = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => { invalid = true; });
  parser.on("doctype", () => { invalid = true; });
  parser.on("opentag", (tag) => {
    if (tag.name === "testsuites" || tag.name === "testsuite") recognized = true;
    if (stack.length >= MAX_STRUCTURED_REPORT_XML_DEPTH) depthExceeded = true;
    if (depthExceeded) return;
    const element: Builder = {
      name: tag.uri === "" ? tag.name : `{${tag.uri}}${tag.local}`,
      attributes: Object.fromEntries(Object.values(tag.attributes).map((attribute) => [attribute.name, attribute.value])),
      children: [], comments: [],
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(element);
    else roots.push(element);
    stack.push(element);
  });
  parser.on("closetag", () => { stack.pop(); });
  parser.on("comment", (comment) => { stack.at(-1)?.comments.push(comment); });
  // Error events are retained through close: even a late syntax error poisons
  // the entire document. Recognizing a format never authorizes invalid XML.
  // Feed bounded chunks so even saxes' own tag stack stops growing promptly
  // after the depth limit. No recursive report traversal sees an over-depth tree.
  for (let offset = 0; offset < content.length; offset += 4096) {
    parser.write(content.slice(offset, offset + 4096));
    if (depthExceeded) return { recognized, root: null };
  }
  parser.close();
  const root = roots[0];
  const reportRoot = roots.length === 1 && root && (root.name === "testsuite" || root.name === "testsuites");
  return { recognized, root: !invalid && reportRoot ? root : null };
}

type JunitCounts = Readonly<{ total: number; failed: number; skipped: number }>;
const noCases: JunitCounts = Object.freeze({ total: 0, failed: 0, skipped: 0 });

function countAttribute(element: ReportElement, name: string, fallback?: number): number | null {
  const raw = element.attributes[name];
  if (raw === undefined) return fallback ?? null;
  return /^\d+$/u.test(raw) ? safeCount(Number(raw)) : null;
}

function saneJunitCounts(total: number, failed: number, skipped: number): JunitCounts | null {
  return [total, failed, skipped, failed + skipped].every((count) => safeCount(count) !== null) &&
    failed + skipped <= total ? { total, failed, skipped } : null;
}

function sumJunitCounts(counts: readonly (JunitCounts | null)[]): JunitCounts | null {
  let sum = noCases;
  for (const count of counts) {
    if (count === null) return null;
    const next = saneJunitCounts(sum.total + count.total, sum.failed + count.failed, sum.skipped + count.skipped);
    if (next === null) return null;
    sum = next;
  }
  return sum;
}

function testcaseCounts(element: ReportElement): JunitCounts | null {
  const skipped = element.children.filter((child) => child.name === "skipped");
  const failed = element.children.filter((child) => child.name === "failure" || child.name === "error");
  // Node emits both skipped(type=todo) and failure for a failing TODO case.
  if (skipped.length > 1 || (skipped.length > 0 && failed.length > 0 && skipped[0]!.attributes.type !== "todo")) return null;
  return { total: 1, failed: skipped.length === 0 && failed.length > 0 ? 1 : 0, skipped: skipped.length };
}

const reportChildren = (element: ReportElement): readonly ReportElement[] =>
  element.children.filter((child) => child.name === "testsuite" || child.name === "testcase");

/** Aggregates count descendants once; attributes must agree when cases exist.
 * Summary-only traditional JUnit remains supported, as in the machine API. */
function parseTraditionalJunit(element: ReportElement): JunitCounts | null {
  if (element.name === "testcase") return testcaseCounts(element);
  if (element.name !== "testsuite" && element.name !== "testsuites") return null;
  const children = reportChildren(element);
  // Direct testcase children of testsuites are the Node dialect, which needs
  // its root summary; they cannot fall back to traditional suite accounting.
  if (element.name === "testsuites" && children.some((child) => child.name === "testcase")) return null;
  if (element.name === "testsuites" && children.length === 0) return null;
  const observed = sumJunitCounts(children.map(parseTraditionalJunit));
  if (observed === null) return null;
  const total = countAttribute(element, "tests", element.name === "testsuites" ? observed.total : undefined);
  const failures = countAttribute(element, "failures", 0);
  const errors = countAttribute(element, "errors", 0);
  const skipped = countAttribute(element, "skipped", 0);
  const disabled = countAttribute(element, "disabled", 0);
  if (total === null || failures === null || errors === null || skipped === null || disabled === null) return null;
  const failed = element.attributes.failures === undefined && element.attributes.errors === undefined && children.length > 0
    ? observed.failed : failures + errors;
  const notExecuted = element.attributes.skipped === undefined && element.attributes.disabled === undefined && children.length > 0
    ? observed.skipped : skipped + disabled;
  const counts = saneJunitCounts(total, failed, notExecuted);
  if (counts === null || (children.length > 0 &&
      (counts.total !== observed.total || counts.failed !== observed.failed || counts.skipped !== observed.skipped))) return null;
  return counts;
}

function nodeLeafCounts(element: ReportElement): JunitCounts | null {
  if (element.name === "testcase") return testcaseCounts(element);
  if (element.name !== "testsuite" && element.name !== "testsuites") return null;
  return sumJunitCounts(reportChildren(element).map(nodeLeafCounts));
}

/** Only direct comments of the actual testsuites root are Node summaries.
 * The comments must reconcile with real leaf cases; suite attributes in Node
 * describe immediate children, not leaf totals, and cannot be summed. */
function parseNodeJunitSummary(root: ReportElement): TestReportSummary | null {
  if (root.name !== "testsuites") return null;
  const counts = new Map<string, number>();
  for (const comment of root.comments) {
    const match = /^\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/u.exec(comment);
    if (match === null) continue;
    const name = match[1]!;
    const value = safeCount(Number(match[2]));
    if (counts.has(name) || value === null) return null;
    counts.set(name, value);
  }
  const tests = counts.get("tests");
  const passed = counts.get("pass");
  const failed = counts.get("fail");
  const cancelled = counts.get("cancelled");
  const skipped = counts.get("skipped");
  const todo = counts.get("todo");
  if (tests === undefined || passed === undefined || failed === undefined || cancelled === undefined ||
      skipped === undefined || todo === undefined) return null;
  const declared = saneJunitCounts(tests, failed + cancelled, skipped + todo);
  const actual = nodeLeafCounts(root);
  if (declared === null || actual === null || tests !== passed + failed + cancelled + skipped + todo ||
      actual.total !== tests || actual.failed !== declared.failed || actual.skipped !== declared.skipped) return null;
  return parseReportSummary(tests - declared.skipped, declared.failed, "junit-xml");
}

function parseExecutedJunitSummary(content: string): RecognizedReport {
  const report = parseJunitDocument(content);
  if (report.root === null) return { recognized: report.recognized, summary: null };
  // A Node-looking summary must never fall back to suite counts on mismatch.
  if (report.root.comments.some((comment) => /^\s*(tests|pass|fail|cancelled|skipped|todo)\b/u.test(comment))) {
    return { recognized: report.recognized, summary: parseNodeJunitSummary(report.root) };
  }
  const counts = parseTraditionalJunit(report.root);
  const summary = counts === null ? null : parseReportSummary(counts.total - counts.skipped, counts.failed, "junit-xml");
  return { recognized: report.recognized, summary };
}

/**
 * Parse the exact bytes collected by the hardened runner. This stricter seam
 * counts executed (not merely declared) tests independently of the legacy
 * machine count API, so an all-skipped report cannot become passing evidence.
 */
export function parseStructuredTestReportBytes(bytes: Uint8Array): StructuredReportParseResult {
  if (bytes.byteLength > MAX_STRUCTURED_REPORT_BYTES) {
    return reportFailure("resource-limit", `structured test report exceeds ${MAX_STRUCTURED_REPORT_BYTES} byte limit`);
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reportFailure("invalid-utf8", "structured test report is not valid UTF-8");
  }

  const vitest = parseExecutedVitestSummary(content);
  const junit = parseExecutedJunitSummary(content);
  const recognized = [vitest, junit].filter((candidate) => candidate.recognized);
  if (recognized.length === 0) {
    return reportFailure("unrecognized-format", "structured test report is neither Vitest JSON nor JUnit XML");
  }
  if (recognized.length > 1) {
    return reportFailure("ambiguous-format", "structured test report matches more than one supported format");
  }
  const summary = recognized[0]!.summary;
  return summary === null
    ? reportFailure("malformed-counts", "structured test report has missing, inconsistent, or unsafe counts")
    : reportSuccess(summary);
}

// --- Per-testcase projection ---

export type ReportTestcaseOutcome = "passed" | "failed" | "skipped";

/**
 * One JUnit testcase: what it belongs to (`classname` — the test file under
 * Vitest, the test class under Surefire), its name (Vitest prefixes the
 * enclosing `describe` titles, joined by ` > `), how it ended, and the type of
 * its first `<failure>`/`<error>` (`AssertionError` for a behavioral failure,
 * `Error` for a thrown stub or a file that never loaded).
 */
export type ReportTestcase = Readonly<{
  classname: string;
  name: string;
  outcome: ReportTestcaseOutcome;
  failureType: string | null;
}>;

export type JunitTestcasesResult = DomainResult<readonly ReportTestcase[], StructuredReportError>;

function testcaseElements(element: ReportElement): readonly ReportElement[] {
  return element.name === "testcase" ? [element] : reportChildren(element).flatMap(testcaseElements);
}

/** A skipped case is skipped even when it also carries a failure: Node's
 *  failing TODO case, which the count parser reads the same way. */
function projectTestcase(element: ReportElement): ReportTestcase | null {
  const name = element.attributes.name;
  const classname = element.attributes.classname;
  if (name === undefined || name.trim() === "" || classname === undefined || classname.trim() === "") return null;
  const skipped = element.children.some((child) => child.name === "skipped");
  const failure = element.children.find((child) => child.name === "failure" || child.name === "error");
  return Object.freeze({
    classname,
    name,
    outcome: skipped ? "skipped" : failure === undefined ? "passed" : "failed",
    failureType: skipped || failure === undefined ? null : failure.attributes.type ?? null,
  });
}

/**
 * Every testcase of a JUnit report, in document order. The report must first
 * pass the strict structured-report parser, so the projection never describes
 * a report whose counts the gate would refuse; a Vitest JSON report is refused
 * by name, since it carries no per-testcase file attribution here.
 */
export function parseJunitTestcases(bytes: Uint8Array): JunitTestcasesResult {
  const summary = parseStructuredTestReportBytes(bytes);
  if (!summary.ok) return summary;
  if (summary.value.source !== "junit-xml") {
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        kind: "invalid-structured-test-report",
        reason: "unrecognized-format",
        message: "per-testcase observation needs a JUnit XML report; this report is Vitest JSON",
      }),
    });
  }
  const root = parseJunitDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).root;
  const elements = root === null ? [] : testcaseElements(root);
  const projected = elements.map(projectTestcase);
  const unnamed = projected.filter((testcase) => testcase === null).length;
  return unnamed > 0
    ? Object.freeze({
        ok: false,
        error: Object.freeze({
          kind: "invalid-structured-test-report",
          reason: "malformed-testcase",
          message: `${unnamed} JUnit testcase(s) lack a name or classname`,
        }),
      })
    : Object.freeze({ ok: true, value: Object.freeze(projected as ReportTestcase[]) });
}

/** Merge summaries from multiple report files of one run. The inputs must
 *  share ONE source — enforced at runtime, not by comment: a mixed-source
 *  merge would stamp the sum with the first summary's source, silently
 *  mislabeling half the counts. Fail closed to null instead. */
export function mergeSummaries(summaries: readonly TestReportSummary[]): TestReportSummary | null {
  if (summaries.length === 0) return null;
  if (summaries.some((s) => s.source !== summaries[0].source)) return null;
  // Route the summed counts back through the sole smart constructor rather
  // than casting a fresh literal: summing sane summaries stays sane, but the
  // brand must be minted where its invariant is (re)checked.
  let total = 0;
  let failed = 0;
  for (const s of summaries) {
    total += s.total;
    failed += s.failed;
  }
  return parseReportSummary(total, failed, summaries[0].source);
}
