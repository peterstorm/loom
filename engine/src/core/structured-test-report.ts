/** Shared pure structured-test-report facts and parsers. */

import { SaxesParser } from "saxes";
import type { DomainResult } from "./orchestration-contract/identity";

/*
 * TestFileResult and TestReportFiles are CT-1's contract types, declared in
 * red-then-green-types.ts. They are restated structurally here, not imported:
 * that frozen file type-imports machine/types, which imports this module, so
 * an import would close a core → machine → core cycle that
 * orchestration-contract-acyclic.test.ts forbids. structured-test-report-files
 * .test.ts pins the two declarations as identical types at compile time.
 */
type TestFileResult = Readonly<{
  file: string;
  executed: number;
  failed: number;
  skipped: number;
  collectionError: boolean;
}>;

type TestReportFiles =
  | Readonly<{ kind: "unrecorded" }>
  | Readonly<{ kind: "recorded"; results: readonly TestFileResult[] }>;

declare const REPORT_SUMMARY_PARSED: unique symbol;
type ReportSource = "vitest-json" | "junit-xml";
export type TestReportSummary = Readonly<{
  total: number;
  failed: number;
  source: ReportSource;
  /**
   * The report's per-file results, reconciled with `total` and `failed`
   * (INV-8). Present on every summary of a TestRun fact, at capture and at
   * ledger read-back. Absent only on a counts-only summary minted without
   * per-file input: the strict executed-count parser and the completion-check
   * and remediation observations built from it, whose exact-key wire records
   * carry no per-file results. Absent therefore never satisfies an I6 step.
   */
  files?: TestReportFiles;
}> & { readonly [REPORT_SUMMARY_PARSED]: true };

/** Per-report resource budget, shared by capture, parsing, persistence, and replay. */
export const MAX_STRUCTURED_REPORT_BYTES = 8 * 1024 * 1024;
export const MAX_STRUCTURED_REPORT_XML_DEPTH = 128;

// --- Per-file results (INV-8 owner) ---

export type FileResultsError = Readonly<{ kind: "unreconciled-file-results"; message: string }>;

const UNRECORDED: TestReportFiles = Object.freeze({ kind: "unrecorded" });

const fileResultsFailure = (message: string): DomainResult<TestReportFiles, FileResultsError> =>
  Object.freeze({ ok: false, error: Object.freeze({ kind: "unreconciled-file-results", message }) });

const isPlainRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

const hasExactKeys = (raw: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(raw);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(raw, key));
};

const FILE_RESULT_KEYS = ["file", "executed", "failed", "skipped", "collectionError"] as const;

/** One per-file result, re-minted from exactly its five fields. A failing and
 *  a skipped testcase are disjoint, so `failed + skipped <= executed`. A
 *  collection error must look like one under the format's own rule: Vitest
 *  JUnit reports it as one synthetic failing testcase, Vitest JSON as an entry
 *  with no assertions, so the two cannot be confused with a behavioral failure. */
function parseFileResult(source: ReportSource, raw: unknown): TestFileResult | string {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, FILE_RESULT_KEYS)) {
    return "a per-file result must carry exactly file, executed, failed, skipped and collectionError";
  }
  const { file, collectionError } = raw;
  if (typeof file !== "string" || file.trim() === "") return "a per-file result names no file";
  const executed = safeCount(raw.executed);
  const failed = safeCount(raw.failed);
  const skipped = safeCount(raw.skipped);
  if (executed === null || failed === null || skipped === null) {
    return `per-file counts for ${file} are not non-negative safe integers`;
  }
  if (failed + skipped > executed) return `${file} fails or skips more testcases than it executed`;
  if (typeof collectionError !== "boolean") return `collectionError for ${file} is not a boolean`;
  if (collectionError && source === "junit-xml" && failed === 0) {
    return `${file} reports a JUnit collection error without its failing synthetic testcase`;
  }
  if (collectionError && source === "vitest-json" && executed !== 0) {
    return `${file} reports a Vitest JSON collection error yet executed testcases`;
  }
  return Object.freeze({ file, executed, failed, skipped, collectionError });
}

/**
 * The INV-8 rule, implemented once: parse raw per-file results and reconcile
 * them with a summary's counts. Absent results are a pre-feature fact and read
 * as `unrecorded`. Recorded results list each file once, and their `executed`
 * and `failed` sums equal the summary's `total` and `failed` under the
 * format's own counting rule (each parser projects files under the same rule
 * it counts by). Anything else is refused; `parseReportSummary` then mints no
 * summary at all, so a half-trusted report never exists.
 */
export function reconcileFileResults(
  source: ReportSource,
  total: number,
  failed: number,
  files: unknown,
): DomainResult<TestReportFiles, FileResultsError> {
  if (files === undefined) return Object.freeze({ ok: true, value: UNRECORDED });
  if (!isPlainRecord(files)) return fileResultsFailure("per-file results must be an object");
  if (files.kind === "unrecorded" && hasExactKeys(files, ["kind"])) return Object.freeze({ ok: true, value: UNRECORDED });
  if (files.kind !== "recorded" || !hasExactKeys(files, ["kind", "results"]) || !Array.isArray(files.results)) {
    return fileResultsFailure("per-file results must be exactly { kind: 'unrecorded' } or { kind: 'recorded', results: [...] }");
  }
  const results: TestFileResult[] = [];
  const seen = new Set<string>();
  let executedSum = 0;
  let failedSum = 0;
  for (const raw of files.results as readonly unknown[]) {
    const parsed = parseFileResult(source, raw);
    if (typeof parsed === "string") return fileResultsFailure(parsed);
    if (seen.has(parsed.file)) return fileResultsFailure(`${parsed.file} is listed more than once`);
    seen.add(parsed.file);
    executedSum += parsed.executed;
    failedSum += parsed.failed;
    results.push(parsed);
  }
  if (executedSum !== total || failedSum !== failed) {
    return fileResultsFailure(
      `per-file results sum to ${executedSum} executed and ${failedSum} failed; the summary says ${total} and ${failed}`,
    );
  }
  return Object.freeze({ ok: true, value: Object.freeze({ kind: "recorded", results: Object.freeze(results) }) });
}

// --- Pure parsers ---

/**
 * The sole constructor of every TestReportSummary (INV-8): a summary that
 * exists has non-negative integer counts with failed ≤ total, and per-file
 * results that `reconcileFileResults` accepted against those counts. Every
 * construction site (the artifact parsers and `mergeSummaries` below, the
 * ledger read-back in evidence.ts, capture in report-discovery.ts) funnels
 * through here, so an impossible-count or unreconciled report can never exist
 * to vouch — fail closed to null (→ the run stays untrusted).
 *
 * `perFile` selects the summary's kind. Omitted, the summary is counts-only
 * and carries no `files` at all: exactly the pre-feature three own keys, which
 * the exact-key completion-check and remediation records require. Given, the
 * summary is a TestRun fact's and always carries `files`: `perFile.files` is
 * the raw per-file value (a parser's projection, a merge, or a ledger line's
 * field), with `undefined` reading as `unrecorded` (a pre-feature line).
 */
export function parseReportSummary(
  total: unknown,
  failed: unknown,
  source: TestReportSummary["source"],
  perFile?: Readonly<{ files: unknown }>,
): TestReportSummary | null {
  if (typeof total !== "number" || typeof failed !== "number") return null;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(failed)) return null;
  if (total < 0 || failed < 0 || failed > total) return null;
  const summary = { total, failed, source };
  if (perFile !== undefined) {
    const reconciled = reconcileFileResults(source, total, failed, perFile.files);
    if (!reconciled.ok) return null;
    // `files` is enumerable only when recorded, so an unrecorded summary keeps
    // the pre-feature JSON bytes: a legacy ledger line re-serializes
    // byte-for-byte, and read-back maps the absent field back to `unrecorded`.
    Object.defineProperty(summary, "files", { value: reconciled.value, enumerable: reconciled.value.kind === "recorded" });
  }
  // Sole producer of the branded TestReportSummary: the checks above ARE the
  // brand's invariant, so the cast is justified exactly here.
  return Object.freeze(summary) as TestReportSummary;
}

/**
 * Per-file results of a Vitest/Jest JSON report: one file per `testResults`
 * entry, named exactly as the report names it. `executed` counts the entry's
 * assertions under the same rule as `numTotalTests` (every declared test),
 * `skipped` the ones that neither passed nor failed (skipped, pending, todo,
 * disabled), and a failed entry with no assertions is a collection error. `undefined` when
 * the report carries no `testResults` (a summary-only report); `null` when it
 * carries malformed ones, which makes the whole report untrusted.
 */
function vitestFileResults(report: Record<string, unknown>): TestReportFiles | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(report, "testResults")) return undefined;
  if (!Array.isArray(report.testResults)) return null;
  const results: TestFileResult[] = [];
  for (const entry of report.testResults as readonly unknown[]) {
    if (!isPlainRecord(entry)) return null;
    const assertions = entry.assertionResults ?? [];
    if (typeof entry.name !== "string" || typeof entry.status !== "string" || !Array.isArray(assertions)) return null;
    const statuses = (assertions as readonly unknown[])
      .map((assertion) => isPlainRecord(assertion) && typeof assertion.status === "string" ? assertion.status : null);
    if (statuses.includes(null)) return null;
    const failed = statuses.filter((status) => status === "failed").length;
    const passed = statuses.filter((status) => status === "passed").length;
    results.push({
      file: entry.name,
      executed: statuses.length,
      failed,
      skipped: statuses.length - passed - failed,
      collectionError: entry.status === "failed" && statuses.length === 0,
    });
  }
  return { kind: "recorded", results };
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
  if (!isPlainRecord(raw)) return null;
  const files = vitestFileResults(raw);
  return files === null ? null : parseReportSummary(raw.numTotalTests, raw.numFailedTests, "vitest-json", { files });
}

/**
 * What one XML document is to the legacy JUnit reader:
 * - `not-junit`: well-formed XML that holds no testsuites, testsuite or
 *   testcase element anywhere, in any namespace (Maven failsafe's
 *   `failsafe-summary.xml`, a coverage report). It describes no test run, so a
 *   report-dir scan skips it.
 * - `refused`: a JUnit report that is malformed, has impossible counts, or
 *   whose per-file results disagree with its counts (INV-8), and every
 *   document whose kind cannot be decided (invalid XML, over budget). It
 *   cannot vouch, and it voids the run's capture.
 * - `parsed`: a summary with reconciled per-file results.
 */
export type JunitReportRead =
  | Readonly<{ kind: "not-junit" }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "parsed"; summary: TestReportSummary }>;

const NOT_JUNIT: JunitReportRead = Object.freeze({ kind: "not-junit" });
const REFUSED: JunitReportRead = Object.freeze({ kind: "refused" });

/** Legacy machine API counts declared tests (including skipped), never P3 executions.
 * XML syntax and report structure are shared with the strict byte parser.
 * Per-file results are projected under the same declared-count rule. */
export function readJunitReport(content: string): JunitReportRead {
  const document = parseJunitDocument(content);
  if (document.kind === "foreign") return NOT_JUNIT;
  if (document.kind === "malformed") return REFUSED;
  const counts = parseTraditionalJunit(document.root);
  const summary = counts === null
    ? null
    : parseReportSummary(counts.total, counts.failed, "junit-xml", { files: junitFileResults(document.root) });
  return summary === null ? REFUSED : Object.freeze({ kind: "parsed", summary });
}

/** The summary of a document that must be a JUnit report (an explicitly named
 *  artifact): anything but a parsed report is `null`. */
export function parseJunitXml(content: string): TestReportSummary | null {
  const read = readJunitReport(content);
  return read.kind === "parsed" ? read.summary : null;
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

/**
 * One XML document, classified once:
 * - `foreign`: well-formed, and no element anywhere has the local name
 *   testsuites, testsuite or testcase — it is not a test report at all.
 * - `malformed`: anything that is not a usable report root and not provably
 *   foreign (invalid XML, a DTD, over budget, too deep, or JUnit elements under
 *   a root that is not testsuite(s)). `recognized` keeps the strict parser's
 *   format-recognition fact: a testsuite(s) tag was seen.
 * - `report`: a well-formed testsuite(s) root.
 */
type JunitDocument =
  | Readonly<{ kind: "foreign" }>
  | Readonly<{ kind: "malformed"; recognized: boolean }>
  | Readonly<{ kind: "report"; root: ReportElement }>;

const JUNIT_ELEMENT_NAMES: ReadonlySet<string> = new Set(["testsuites", "testsuite", "testcase"]);

/** Saxes owns the XML grammar. Local builder mutation never escapes this pure parse.
 * No DTD is accepted and no entity resolver is installed; predefined/numeric
 * XML entities are decoded by saxes, not by report-specific string rewriting. */
function parseJunitDocument(content: string): JunitDocument {
  type Builder = { name: string; attributes: Record<string, string>; children: Builder[]; comments: string[] };
  if (Buffer.byteLength(content, "utf8") > MAX_STRUCTURED_REPORT_BYTES) return { kind: "malformed", recognized: false };
  const stack: Builder[] = [];
  const roots: Builder[] = [];
  let invalid = false;
  let recognized = false;
  let junitShaped = false;
  let depthExceeded = false;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => { invalid = true; });
  parser.on("doctype", () => { invalid = true; });
  parser.on("opentag", (tag) => {
    if (tag.name === "testsuites" || tag.name === "testsuite") recognized = true;
    // By local name, so a namespaced or nested JUnit element still refuses
    // rather than letting its document pass as foreign.
    if (JUNIT_ELEMENT_NAMES.has(tag.local)) junitShaped = true;
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
    if (depthExceeded) return { kind: "malformed", recognized };
  }
  parser.close();
  const root = roots[0];
  if (invalid || roots.length !== 1 || root === undefined) return { kind: "malformed", recognized };
  if (root.name === "testsuite" || root.name === "testsuites") return { kind: "report", root };
  return junitShaped ? { kind: "malformed", recognized } : { kind: "foreign" };
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
  const document = parseJunitDocument(content);
  if (document.kind === "foreign") return { recognized: false, summary: null };
  if (document.kind === "malformed") return { recognized: document.recognized, summary: null };
  const { root } = document;
  // A Node-looking summary must never fall back to suite counts on mismatch.
  if (root.comments.some((comment) => /^\s*(tests|pass|fail|cancelled|skipped|todo)\b/u.test(comment))) {
    return { recognized: true, summary: parseNodeJunitSummary(root) };
  }
  const counts = parseTraditionalJunit(root);
  const summary = counts === null ? null : parseReportSummary(counts.total - counts.skipped, counts.failed, "junit-xml");
  return { recognized: true, summary };
}

/**
 * Parse the exact bytes collected by the hardened runner. This stricter seam
 * counts executed (not merely declared) tests independently of the legacy
 * machine count API, so an all-skipped report cannot become passing evidence.
 * Its summaries are counts-only (no `files`): they are minted into
 * exact-key completion-check and remediation observations, whose wire shape
 * and digests are pinned, and per-file results belong to TestRun facts
 * (captured through the legacy parsers by `findReport`), not to those checks.
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
 * Per-file results of a JUnit report: its testcases grouped by `classname`, in
 * first-appearance order, the classname kept exactly as written. `executed`
 * counts every testcase (the legacy declared-count rule the summary uses),
 * `failed` the failing ones and `skipped` the skipped ones (a skipped case
 * that also carries a failure, Node's failing TODO, is skipped, as
 * `projectTestcase` reads it); a failing testcase whose `name` equals its
 * `classname` is Vitest's synthetic collection-error case. `undefined` (the
 * summary stays, per-file results unrecorded) when the report has no
 * testcases, as in a summary-only report, or a testcase that names no file.
 */
function junitFileResults(root: ReportElement): TestReportFiles | undefined {
  const testcases = testcaseElements(root).map(projectTestcase);
  if (testcases.length === 0 || testcases.some((testcase) => testcase === null)) return undefined;
  const byFile = new Map<string, TestFileResult>();
  for (const testcase of testcases as readonly ReportTestcase[]) {
    const failed = testcase.outcome === "failed";
    const prior = byFile.get(testcase.classname);
    byFile.set(testcase.classname, {
      file: testcase.classname,
      executed: (prior?.executed ?? 0) + 1,
      failed: (prior?.failed ?? 0) + (failed ? 1 : 0),
      skipped: (prior?.skipped ?? 0) + (testcase.outcome === "skipped" ? 1 : 0),
      collectionError: (prior?.collectionError ?? false) || (failed && testcase.name === testcase.classname),
    });
  }
  return { kind: "recorded", results: [...byFile.values()] };
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
  const document = parseJunitDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const elements = document.kind === "report" ? testcaseElements(document.root) : [];
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

/** Per-file results of a merged run: recorded only when every part recorded
 *  them (a partial list would claim files the run's other reports never
 *  attributed), with a file reported by several parts listed once, summed. */
function mergeFileResults(parts: readonly (TestReportFiles | undefined)[]): TestReportFiles {
  const byFile = new Map<string, TestFileResult>();
  for (const part of parts) {
    // A counts-only part (no `files`) attributes no file, exactly like an unrecorded one.
    if (part === undefined || part.kind === "unrecorded") return UNRECORDED;
    for (const entry of part.results) {
      const prior = byFile.get(entry.file);
      byFile.set(entry.file, prior === undefined ? entry : {
        file: entry.file,
        executed: prior.executed + entry.executed,
        failed: prior.failed + entry.failed,
        skipped: prior.skipped + entry.skipped,
        collectionError: prior.collectionError || entry.collectionError,
      });
    }
  }
  return { kind: "recorded", results: [...byFile.values()] };
}

/** Merge summaries from multiple report files of one run. The inputs must
 *  share ONE source — enforced at runtime, not by comment: a mixed-source
 *  merge would stamp the sum with the first summary's source, silently
 *  mislabeling half the counts. Fail closed to null instead. */
export function mergeSummaries(summaries: readonly TestReportSummary[]): TestReportSummary | null {
  if (summaries.length === 0) return null;
  if (summaries.some((s) => s.source !== summaries[0].source)) return null;
  // Route the summed counts and merged per-file results back through the sole
  // smart constructor rather than casting a fresh literal: summing sane
  // summaries stays sane, but the brand must be minted where its invariant
  // is (re)checked.
  let total = 0;
  let failed = 0;
  for (const s of summaries) {
    total += s.total;
    failed += s.failed;
  }
  return parseReportSummary(total, failed, summaries[0].source, { files: mergeFileResults(summaries.map((s) => s.files)) });
}
