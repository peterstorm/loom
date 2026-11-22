/** Shared pure structured-test-report facts and parsers. */

import { SaxesParser } from "saxes";
import { match } from "ts-pattern";
import type { DomainResult } from "./orchestration-contract/identity";

// --- Per-file TestRun results (FR-001..FR-004) ---
//
// Declared here, by the parser that mints them: CT-1's types file
// (`red-then-green-types.ts`) re-exports both. The import runs only that way
// round, because the types file imports `../machine/types`, which imports this
// module.

/**
 * One test file as its structured report lists it.
 *
 * `file` is the report's identity exactly as written: a JUnit testcase's own
 * `file` attribute when it writes one (Bun, whose `classname` is the describe
 * chain), else its `classname` (a runner-relative path under Vitest, a JVM
 * class under Surefire); a Vitest JSON `testResults[].name` (an absolute
 * path); or the file header of a Bun console section. The capture cwd and the
 * command string never rewrite or contribute to it.
 *
 * `executed` and `failed` count this file's testcases under the report
 * format's own counting rule, so the results of one report reconcile with its
 * summary counts. That rule counts every declared testcase, so `skipped`
 * names how many of `executed` never ran (skipped, pending, todo, disabled);
 * `failed + skipped <= executed`, and `executed - skipped` is how many actually
 * ran. `collectionError` is true when the file failed to collect or import:
 * Vitest JUnit's synthetic testcase whose `name` equals its `classname`, a
 * failed Vitest JSON entry with no `assertionResults`, or a Bun console
 * section reporting an unhandled error between tests (one failing testcase,
 * as Bun's own summary counts it). A file whose only failure is a collection
 * error is never a behavioral red.
 */
export type TestFileResult = Readonly<{
  file: string;
  executed: number;
  failed: number;
  skipped: number;
  collectionError: boolean;
}>;

/**
 * The per-file results of one report summary. `unrecorded` is a fact captured
 * before per-file results existed (a legacy ledger line): it reads without
 * error and never satisfies an I6 step. `recorded` lists exactly the files
 * the report listed, each once.
 */
export type TestReportFiles =
  | Readonly<{ kind: "unrecorded" }>
  | Readonly<{ kind: "recorded"; results: readonly TestFileResult[] }>;

declare const REPORT_COUNTS_PARSED: unique symbol;
declare const REPORT_SUMMARY_PARSED: unique symbol;
/**
 * Where a summary's facts come from: the one closed vocabulary every reader
 * parses with `parseReportSource`. `bun-console` is a Bun run that wrote no
 * JUnit report (Bun writes none when every test file fails to load) and whose
 * console reported collection errors: those errors are its only facts
 * (`bunRunSummary`). The completion-check reader in `defect-family-accounting`
 * deliberately accepts a narrower set — only the formats `readTestReport`
 * recognizes (`StructuredReportFormat`), which never includes `bun-console`.
 *
 * `runner-crash` is an engine run (`helper run-tests`) whose runner exited
 * non-zero and wrote no report. The engine knows exactly which test files it
 * handed the runner, so each one is recorded as a single failing
 * collection-error testcase (`runnerCrashSummary`): it can show a red under
 * the collection-error rule and can never be a green.
 */
export const REPORT_SOURCES = Object.freeze(["vitest-json", "junit-xml", "bun-console", "runner-crash"] as const);

type ReportSource = typeof REPORT_SOURCES[number];

/** The sources whose every per-file result is exactly one failing collection-error testcase. */
const COLLECTION_ERROR_ONLY_SOURCES: ReadonlySet<ReportSource> = new Set<ReportSource>(["bun-console", "runner-crash"]);

/** The report source a wire value names, or null for anything else. */
export const parseReportSource = (raw: unknown): ReportSource | null =>
  (REPORT_SOURCES as readonly unknown[]).includes(raw) ? raw as ReportSource : null;
type CountFields = Readonly<{ total: number; failed: number; source: ReportSource }>;

/**
 * A report's counts alone, minted only by `parseReportCounts`: what the
 * executed-count rule (`reportCounts`) yields for the completion-check and
 * remediation observations, whose exact-key wire records carry exactly these three keys.
 * It has no per-file results, so it can never stand as a TestRun fact's report.
 */
export type ReportCounts = CountFields & { readonly [REPORT_COUNTS_PARSED]: true };

/**
 * A TestRun fact's report summary, minted only by `parseReportSummary`: counts
 * plus the report's per-file results, reconciled with them (INV-8), at capture
 * and at ledger read-back alike. `files` is always present; `unrecorded` is the
 * one value that never satisfies an I6 step.
 */
export type TestReportSummary = CountFields & Readonly<{ files: TestReportFiles }> & { readonly [REPORT_SUMMARY_PARSED]: true };

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
  if (COLLECTION_ERROR_ONLY_SOURCES.has(source) && !(collectionError && executed === 1 && failed === 1 && skipped === 0)) {
    return `${file} in a ${source} summary must be exactly one failing collection-error testcase`;
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

/** Non-negative safe-integer counts with failed ≤ total, or null. */
function saneCounts(total: unknown, failed: unknown, source: ReportSource): CountFields | null {
  if (typeof total !== "number" || typeof failed !== "number") return null;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(failed)) return null;
  if (total < 0 || failed < 0 || failed > total) return null;
  return { total, failed, source };
}

/**
 * The sole constructor of every ReportCounts: non-negative integer counts with
 * failed ≤ total, as exactly the three own keys the exact-key completion-check
 * and remediation records require. Fails closed to null.
 */
export function parseReportCounts(total: unknown, failed: unknown, source: ReportSource): ReportCounts | null {
  const counts = saneCounts(total, failed, source);
  // Sole producer of the branded ReportCounts: saneCounts IS the brand's invariant.
  return counts === null ? null : Object.freeze(counts) as ReportCounts;
}

/**
 * The sole constructor of every TestReportSummary (INV-8): a summary that
 * exists has non-negative integer counts with failed ≤ total, and per-file
 * results that `reconcileFileResults` accepted against those counts. Every
 * construction site (the artifact parsers and `mergeSummaries` below, the
 * ledger read-back in evidence.ts, capture in report-discovery.ts) funnels
 * through here, so an impossible-count or unreconciled report can never exist
 * to vouch — fail closed to null (→ the run stays untrusted).
 *
 * `files` is the raw per-file value (a parser's projection, a merge, or a
 * ledger line's field); `undefined` reads as `unrecorded` (a pre-feature line).
 */
export function parseReportSummary(
  total: unknown,
  failed: unknown,
  source: ReportSource,
  files: unknown,
): TestReportSummary | null {
  const summary = saneCounts(total, failed, source);
  if (summary === null) return null;
  const reconciled = reconcileFileResults(source, summary.total, summary.failed, files);
  if (!reconciled.ok) return null;
  // `files` is enumerable only when recorded, so an unrecorded summary keeps
  // the pre-feature JSON bytes: a legacy ledger line re-serializes
  // byte-for-byte, and read-back maps the absent field back to `unrecorded`.
  Object.defineProperty(summary, "files", { value: reconciled.value, enumerable: reconciled.value.kind === "recorded" });
  // Sole producer of the branded TestReportSummary: the checks above ARE the
  // brand's invariant, so the cast is justified exactly here.
  return Object.freeze(summary) as TestReportSummary;
}

// --- One read of a structured report ---
//
// A report's bytes are read once, by `readTestReport`, into one `TestReport`.
// Two counting rules read the same document and accept different reports:
//
// - the declared-count rule (a `TestReportSummary`, held under the
//   module-private `DECLARED_SUMMARY` key) counts every declared testcase,
//   skipped included, with per-file results. It refuses the Node JUnit
//   dialect, whose suite attributes describe immediate children only.
// - the executed-count rule (`TestReport.executed`, a `ReportCounts`) counts
//   only the testcases that ran, so an all-skipped report cannot become
//   passing completion evidence. Completion-check and remediation observations
//   mint it into exact-key records whose bytes feed pinned digests. It accepts
//   the Node dialect through the summary comments of its root.
//
// Neither rule is derived from the other: each refuses reports the other
// accepts. TestRun facts (`findReport`, `engineRunReport`) are captured by
// `readTestRunSummary` (or its null projection `testRunSummary`), which takes
// the declared summary and holds it to the executed-count rule (ADR-0100), so
// a TestRun's executed count (`executedTestCount`) is the executed-count
// rule's. The declared summary is keyed by a symbol this module does not
// export, so no caller can take it without that check. The projections below
// are how every caller asks.

/** The two structured formats a report can be: what `TestReport.source` names. */
export type StructuredReportFormat = Extract<ReportSource, "vitest-json" | "junit-xml">;

/** The key of a report's declared-count summary. Not exported: a TestRun
 *  summary is reachable only through `readTestRunSummary` (ADR-0100). */
const DECLARED_SUMMARY: unique symbol = Symbol("declared-count summary");

type CountingRules = Readonly<{
  /** The declared-count rule's summary; null where that rule refuses the report. */
  [DECLARED_SUMMARY]: TestReportSummary | null;
  /** The executed-count rule's counts; null where that rule refuses the report. */
  executed: ReportCounts | null;
}>;

type VitestReport = CountingRules & Readonly<{ source: "vitest-json" }>;

/**
 * One structured test report, read once. A JUnit report carries its testcases
 * in document order (`projectTestcase`), and how many it holds that name no
 * testcase or no file.
 */
export type TestReport =
  | VitestReport
  | (CountingRules & Readonly<{
    source: "junit-xml";
    testcases: readonly ReportTestcase[];
    unnamedTestcases: number;
  }>);

/**
 * What one read of report bytes or text yields:
 * - `report`: Vitest JSON (a JSON object carrying a Vitest summary count) or
 *   JUnit XML (a testsuite(s) tag was seen), whatever either rule makes of it.
 * - `ambiguous`: a Vitest JSON report whose text also carries a JUnit
 *   testsuite(s) tag an XML reader sees. The executed-count rule refuses it as
 *   matching both formats (`reportCounts`); a TestRun summary still reads it as
 *   the Vitest JSON it parsed as.
 * - `foreign-xml`: well-formed XML with no testsuites, testsuite or testcase
 *   element anywhere, in any namespace (Maven failsafe's
 *   `failsafe-summary.xml`, a coverage report): it describes no test run, so a
 *   report-dir scan skips it.
 * - `unrecognized`: neither format, and not foreign XML.
 * - `unreadable`: over the byte budget, or bytes that are not UTF-8.
 */
export type TestReportRead =
  | Readonly<{ kind: "report"; report: TestReport }>
  | Readonly<{ kind: "ambiguous"; report: VitestReport }>
  | Readonly<{ kind: "foreign-xml" }>
  | Readonly<{ kind: "unrecognized" }>
  | Readonly<{ kind: "unreadable"; reason: Extract<StructuredReportErrorReason, "resource-limit" | "invalid-utf8"> }>;

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

export type StructuredReportParseResult = DomainResult<ReportCounts, StructuredReportError>;

const reportFailure = (
  reason: StructuredReportErrorReason,
  message: string,
): DomainResult<never, StructuredReportError> => Object.freeze({
  ok: false,
  error: Object.freeze({ kind: "invalid-structured-test-report", reason, message }),
});

function safeCount(raw: unknown): number | null {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

const OVER_BUDGET: TestReportRead = Object.freeze({ kind: "unreadable", reason: "resource-limit" });
const NOT_UTF8: TestReportRead = Object.freeze({ kind: "unreadable", reason: "invalid-utf8" });
const FOREIGN_XML: TestReportRead = Object.freeze({ kind: "foreign-xml" });
const UNRECOGNIZED: TestReportRead = Object.freeze({ kind: "unrecognized" });
/** A document that shows a JUnit testsuite(s) tag but is no usable report: both rules refuse it. */
const MALFORMED_JUNIT: TestReportRead = Object.freeze({
  kind: "report",
  report: Object.freeze({
    source: "junit-xml",
    [DECLARED_SUMMARY]: null,
    executed: null,
    testcases: Object.freeze([]),
    unnamedTestcases: 0,
  }),
});

/**
 * Read the exact bytes a runner wrote: over the byte budget or not strict
 * UTF-8 is `unreadable`; anything else is read as `readTestReportText` reads it.
 */
export function readTestReport(bytes: Uint8Array): TestReportRead {
  if (bytes.byteLength > MAX_STRUCTURED_REPORT_BYTES) return OVER_BUDGET;
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return NOT_UTF8;
  }
  return readTestReportText(content);
}

const VITEST_SUMMARY_FIELDS = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"];

/**
 * Read report text a shell already decoded (a report file read as UTF-8, a
 * runner's stdout). JSON is tried first: a JSON document is never well-formed
 * XML, so the XML reader runs on it only when its text holds a testsuite tag,
 * the one way it could still look like JUnit.
 */
export function readTestReportText(content: string): TestReportRead {
  if (Buffer.byteLength(content, "utf8") > MAX_STRUCTURED_REPORT_BYTES) return OVER_BUDGET;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return readJunitDocument(parseJunitDocument(content));
  }
  const looksJunit = content.includes("<testsuite") && recognizesJunit(parseJunitDocument(content));
  if (isPlainRecord(json) && VITEST_SUMMARY_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(json, field))) {
    return Object.freeze({ kind: looksJunit ? "ambiguous" : "report", report: readVitestReport(json) });
  }
  return looksJunit ? MALFORMED_JUNIT : UNRECOGNIZED;
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

/**
 * vitest `--reporter=json` / jest `--json` share the summary shape. Declared:
 * `numTotalTests` (pending and todo included) with the per-file results.
 * Executed: passed plus failed, only when all five counts are present and sum
 * to `numTotalTests`.
 */
function readVitestReport(report: Record<string, unknown>): VitestReport {
  const files = vitestFileResults(report);
  const declared = files === null ? null : parseReportSummary(report.numTotalTests, report.numFailedTests, "vitest-json", files);
  return Object.freeze({ source: "vitest-json", [DECLARED_SUMMARY]: declared, executed: executedVitestCounts(report) });
}

function executedVitestCounts(report: Record<string, unknown>): ReportCounts | null {
  const [total, passed, failed, pending, todo] = VITEST_SUMMARY_FIELDS.map((field) => safeCount(report[field]));
  if (total === null || passed === null || failed === null || pending === null || todo === null) return null;
  const executed = passed + failed;
  const declared = executed + pending + todo;
  return Number.isSafeInteger(declared) && declared === total ? parseReportCounts(executed, failed, "vitest-json") : null;
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
 *   a root that is not testsuite(s)). `recognized` is the format-recognition
 *   fact: a testsuite(s) tag was seen.
 * - `report`: a well-formed testsuite(s) root.
 */
type JunitDocument =
  | Readonly<{ kind: "foreign" }>
  | Readonly<{ kind: "malformed"; recognized: boolean }>
  | Readonly<{ kind: "report"; root: ReportElement }>;

const recognizesJunit = (document: JunitDocument): boolean =>
  document.kind === "report" || (document.kind === "malformed" && document.recognized);

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
  if (skipped.length > 1 || (skipped.length > 0 && failed.length > 0 && skipped[0].attributes.type !== "todo")) return null;
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
function parseNodeJunitSummary(root: ReportElement): ReportCounts | null {
  if (root.name !== "testsuites") return null;
  const counts = new Map<string, number>();
  for (const comment of root.comments) {
    const match = /^\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/u.exec(comment);
    if (match === null) continue;
    const name = match[1];
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
  return parseReportCounts(tests - declared.skipped, declared.failed, "junit-xml");
}

/** A report root whose comments look like a Node summary: it must never fall back to suite counts on mismatch. */
const isNodeJunitReport = (root: ReportElement): boolean =>
  root.comments.some((comment) => /^\s*(tests|pass|fail|cancelled|skipped|todo)\b/u.test(comment));

/**
 * A JUnit document under both counting rules. Declared: traditional suite
 * accounting (summary-only reports included), with per-file results from the
 * testcases; it refuses the Node dialect's direct testcases under testsuites.
 * Executed: the Node summary when the root carries one, else the traditional
 * counts less the skipped cases.
 */
function readJunitDocument(document: JunitDocument): TestReportRead {
  if (document.kind === "foreign") return FOREIGN_XML;
  if (document.kind === "malformed") return document.recognized ? MALFORMED_JUNIT : UNRECOGNIZED;
  const { root } = document;
  const traditional = parseTraditionalJunit(root);
  const projected = testcaseElements(root).map(projectTestcase);
  const testcases = Object.freeze(projected.filter((testcase): testcase is ReportTestcase => testcase !== null));
  const unnamedTestcases = projected.length - testcases.length;
  const declared = traditional === null
    ? null
    : parseReportSummary(traditional.total, traditional.failed, "junit-xml", junitFileResults(testcases, unnamedTestcases));
  const executed = isNodeJunitReport(root)
    ? parseNodeJunitSummary(root)
    : traditional === null ? null : parseReportCounts(traditional.total - traditional.skipped, traditional.failed, "junit-xml");
  return Object.freeze({
    kind: "report",
    report: Object.freeze({ source: "junit-xml", [DECLARED_SUMMARY]: declared, executed, testcases, unnamedTestcases }),
  });
}

// --- Per-testcase projection ---

export type ReportTestcaseOutcome = "passed" | "failed" | "skipped";

/**
 * One JUnit testcase: the file it belongs to, its `classname` exactly as
 * written, its name (Vitest prefixes the enclosing `describe` titles, joined
 * by ` > `), how it ended, and the type of its first `<failure>`/`<error>`
 * (`AssertionError` for a behavioral failure, `Error` for a thrown stub or a
 * file that never loaded).
 *
 * `file` is the testcase's own `file` attribute when it writes one, else its
 * `classname`: Vitest's classname is the test file, Surefire's the test class,
 * while Bun writes the describe chain (empty at top level) as classname and
 * the test file as `file`. It is the identity every attribution reads.
 */
export type ReportTestcase = Readonly<{
  file: string;
  classname: string;
  name: string;
  outcome: ReportTestcaseOutcome;
  failureType: string | null;
}>;

export type JunitTestcasesResult = DomainResult<readonly ReportTestcase[], StructuredReportError>;

/** The one collection-error rule every JUnit reader shares: a file that failed
 *  to load is reported as a single testcase named after its own classname.
 *  A reader that counts failures pairs it with a failed outcome. */
export const isCollectionErrorTestcase = (testcase: Pick<ReportTestcase, "name" | "classname">): boolean =>
  testcase.name === testcase.classname;

function testcaseElements(element: ReportElement): readonly ReportElement[] {
  return element.name === "testcase" ? [element] : reportChildren(element).flatMap(testcaseElements);
}

const nonBlank = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value;

/** A skipped case is skipped even when it also carries a failure: Node's
 *  failing TODO case, which the count parser reads the same way. A testcase
 *  with no name, or naming no file through either attribute, is null. */
function projectTestcase(element: ReportElement): ReportTestcase | null {
  const name = nonBlank(element.attributes.name);
  const classname = element.attributes.classname ?? "";
  const file = nonBlank(element.attributes.file) ?? nonBlank(classname);
  if (name === null || file === null) return null;
  const skipped = element.children.some((child) => child.name === "skipped");
  const failure = element.children.find((child) => child.name === "failure" || child.name === "error");
  return Object.freeze({
    file,
    classname,
    name,
    outcome: skipped ? "skipped" : failure === undefined ? "passed" : "failed",
    failureType: skipped || failure === undefined ? null : failure.attributes.type ?? null,
  });
}

/**
 * Per-file results of a JUnit report: its testcases grouped by their file
 * identity (`ReportTestcase.file`), in first-appearance order, kept exactly as
 * written. `executed` counts every testcase (the declared-count rule the
 * summary uses), `failed` the failing ones and `skipped` the skipped ones
 * (a skipped case that also carries a failure, Node's failing TODO, is
 * skipped, as `projectTestcase` reads it); a failing testcase whose `name`
 * equals its `classname` is Vitest's synthetic collection-error case.
 * `undefined` (the summary stays, per-file results unrecorded) when the
 * report has no testcases, as in a summary-only report, or a testcase that
 * names no file.
 */
function junitFileResults(testcases: readonly ReportTestcase[], unnamedTestcases: number): TestReportFiles | undefined {
  if (testcases.length === 0 || unnamedTestcases > 0) return undefined;
  const byFile = new Map<string, TestFileResult>();
  for (const testcase of testcases) {
    const failed = testcase.outcome === "failed";
    const prior = byFile.get(testcase.file);
    byFile.set(testcase.file, {
      file: testcase.file,
      executed: (prior?.executed ?? 0) + 1,
      failed: (prior?.failed ?? 0) + (failed ? 1 : 0),
      skipped: (prior?.skipped ?? 0) + (testcase.outcome === "skipped" ? 1 : 0),
      collectionError: (prior?.collectionError ?? false) || (failed && isCollectionErrorTestcase(testcase)),
    });
  }
  return { kind: "recorded", results: [...byFile.values()] };
}

// --- Projections of one read ---

/**
 * The executed-count rule's counts of a report whose bytes the hardened runner
 * collected, or why it refuses them. It yields `ReportCounts`, never a
 * `TestReportSummary`: its counts are minted into exact-key completion-check
 * and remediation observations, whose wire shape and digests are pinned, and
 * per-file results belong to TestRun facts, not to those checks.
 */
export function reportCounts(read: TestReportRead): StructuredReportParseResult {
  return match(read)
    .with({ kind: "unreadable", reason: "resource-limit" }, () =>
      reportFailure("resource-limit", `structured test report exceeds ${MAX_STRUCTURED_REPORT_BYTES} byte limit`))
    .with({ kind: "unreadable", reason: "invalid-utf8" }, () =>
      reportFailure("invalid-utf8", "structured test report is not valid UTF-8"))
    .with({ kind: "foreign-xml" }, { kind: "unrecognized" }, () =>
      reportFailure("unrecognized-format", "structured test report is neither Vitest JSON nor JUnit XML"))
    .with({ kind: "ambiguous" }, () =>
      reportFailure("ambiguous-format", "structured test report matches more than one supported format"))
    .with({ kind: "report" }, ({ report }): StructuredReportParseResult => report.executed === null
      ? reportFailure("malformed-counts", "structured test report has missing, inconsistent, or unsafe counts")
      : Object.freeze({ ok: true, value: report.executed }))
    .exhaustive();
}

/**
 * How many tests a TestRun summary proves actually ran (ADR-0100). With
 * per-file results it is their testcases less the skipped ones (skipped,
 * pending, todo, disabled), which `readTestRunSummary` holds equal to the
 * executed-count rule's count of the same bytes. An unrecorded summary carries
 * no skip facts, so its `total` is the count: capture mints that total under
 * the executed-count rule wherever the rule reads the report, and a legacy
 * ledger line keeps the total it was written with.
 */
export function executedTestCount(summary: TestReportSummary): number {
  return summary.files.kind === "recorded"
    ? summary.files.results.reduce((sum, { executed, skipped }) => sum + executed - skipped, 0)
    : summary.total;
}

/**
 * Why a report cannot stand as a TestRun summary of the format it must be:
 * - `unreadable`: over the byte budget, or not UTF-8;
 * - `unrecognized`: neither Vitest JSON nor JUnit XML (foreign XML included);
 * - `other-format`: a report of the other structured format;
 * - `malformed-counts`: the declared-count rule refuses it (missing,
 *   inconsistent or unsafe counts, per-file results that disagree with them
 *   (INV-8), or a JUnit document it cannot read);
 * - `executed-count-disagreement`: its per-file results and the executed-count
 *   rule disagree about how many tests ran (ADR-0100).
 */
export type TestRunSummaryRefusal =
  | Readonly<{ kind: "unreadable"; reason: Extract<StructuredReportErrorReason, "resource-limit" | "invalid-utf8"> }>
  | Readonly<{ kind: "unrecognized" }>
  | Readonly<{ kind: "other-format"; expected: StructuredReportFormat; found: StructuredReportFormat }>
  | Readonly<{ kind: "malformed-counts" }>
  | Readonly<{ kind: "executed-count-disagreement"; declared: number; executed: number }>;

export type TestRunSummaryRead = DomainResult<TestReportSummary, TestRunSummaryRefusal>;

const summaryRead = (summary: TestReportSummary): TestRunSummaryRead => Object.freeze({ ok: true, value: summary });
const summaryRefusal = (refusal: TestRunSummaryRefusal): TestRunSummaryRead =>
  Object.freeze({ ok: false, error: Object.freeze(refusal) });

/**
 * The TestRun summary of a report that must be `format` (an explicitly named
 * artifact), or why it cannot be one: the declared-count rule's summary, held
 * to the executed-count rule wherever that rule reads the same bytes (ADR-0100).
 * - The executed-count rule cannot count the report (a Vitest summary without
 *   its passed, pending and todo counts): the declared summary as it is.
 * - Per-file results recorded: the declared summary when its executed count
 *   (`executedTestCount`) equals the executed-count rule's, else refused: two
 *   readings of one document that disagree about what ran cannot vouch.
 * - No per-file results: the executed-count rule's counts, since nothing else
 *   in the summary could say what was skipped.
 * So a report in which nothing ran never mints a summary that proves a test
 * ran. An ambiguous report is summarized as the Vitest JSON it parsed as.
 */
export function readTestRunSummary(read: TestReportRead, format: StructuredReportFormat): TestRunSummaryRead {
  return match(read)
    .with({ kind: "unreadable" }, ({ reason }) => summaryRefusal({ kind: "unreadable", reason }))
    .with({ kind: "foreign-xml" }, { kind: "unrecognized" }, () => summaryRefusal({ kind: "unrecognized" }))
    .with({ kind: "report" }, { kind: "ambiguous" }, ({ report }) => heldSummary(report, format))
    .exhaustive();
}

function heldSummary(report: TestReport, format: StructuredReportFormat): TestRunSummaryRead {
  if (report.source !== format) return summaryRefusal({ kind: "other-format", expected: format, found: report.source });
  const declared = report[DECLARED_SUMMARY];
  const { executed } = report;
  if (declared === null) return summaryRefusal({ kind: "malformed-counts" });
  if (executed === null) return summaryRead(declared);
  if (declared.files.kind === "recorded") {
    const ran = executedTestCount(declared);
    return ran === executed.total
      ? summaryRead(declared)
      : summaryRefusal({ kind: "executed-count-disagreement", declared: ran, executed: executed.total });
  }
  const minted = parseReportSummary(executed.total, executed.failed, executed.source, undefined);
  return minted === null ? summaryRefusal({ kind: "malformed-counts" }) : summaryRead(minted);
}

/** `readTestRunSummary` for a caller that only asks whether a summary exists. */
export function testRunSummary(read: TestReportRead, format: StructuredReportFormat): TestReportSummary | null {
  const summary = readTestRunSummary(read, format);
  return summary.ok ? summary.value : null;
}

/** Why a report cannot vouch, worded to follow the report's name in a diagnostic. */
export const describeTestRunSummaryRefusal = (refusal: TestRunSummaryRefusal): string =>
  match(refusal)
    .with({ kind: "unreadable", reason: "resource-limit" }, () => `exceeds the ${MAX_STRUCTURED_REPORT_BYTES} byte limit`)
    .with({ kind: "unreadable", reason: "invalid-utf8" }, () => "is not valid UTF-8")
    .with({ kind: "unrecognized" }, () => "is neither Vitest JSON nor JUnit XML")
    .with({ kind: "other-format" }, ({ expected, found }) => `is ${found}, not the ${expected} report it must be`)
    .with({ kind: "malformed-counts" }, () =>
      "has missing, inconsistent or unsafe counts, or per-file results that disagree with them")
    .with({ kind: "executed-count-disagreement" }, ({ declared, executed }) =>
      `lists ${declared} executed test(s) in its per-file results, but its counts say ${executed} ran`)
    .exhaustive();

/**
 * What one `*.xml` file of a report dir is to a TestRun capture:
 * - `not-junit`: foreign XML (see `TestReportRead`); the scan skips it.
 * - `refused`: anything else `readTestRunSummary` does not summarize as
 *   JUnit, and why. It cannot vouch, and it voids the run's capture.
 * - `parsed`: a summary with reconciled per-file results.
 */
export type JunitReportRead =
  | Readonly<{ kind: "not-junit" }>
  | Readonly<{ kind: "refused"; refusal: TestRunSummaryRefusal }>
  | Readonly<{ kind: "parsed"; summary: TestReportSummary }>;

const NOT_JUNIT: JunitReportRead = Object.freeze({ kind: "not-junit" });

export function junitReportRead(read: TestReportRead): JunitReportRead {
  if (read.kind === "foreign-xml") return NOT_JUNIT;
  const summary = readTestRunSummary(read, "junit-xml");
  return Object.freeze(summary.ok
    ? { kind: "parsed", summary: summary.value }
    : { kind: "refused", refusal: summary.error });
}

/**
 * Every testcase of a JUnit report, in document order. The report must first
 * pass the executed-count rule, so the projection never describes a report
 * whose counts the gate would refuse; a Vitest JSON report is refused by name,
 * since it carries no per-testcase file attribution here. Engine code reaches
 * it only through `parseJunitTestcasesUnder` (INV-9).
 */
export function reportTestcases(read: TestReportRead): JunitTestcasesResult {
  const counts = reportCounts(read);
  if (!counts.ok) return counts;
  if (read.kind !== "report" || read.report.source !== "junit-xml") {
    return reportFailure("unrecognized-format", "per-testcase observation needs a JUnit XML report; this report is Vitest JSON");
  }
  const { testcases, unnamedTestcases } = read.report;
  return unnamedTestcases > 0
    ? reportFailure(
      "malformed-testcase",
      `${unnamedTestcases} JUnit testcase(s) lack a name, or name no file (neither a file attribute nor a classname)`,
    )
    : Object.freeze({ ok: true, value: testcases });
}

/** Per-file results of a merged run: recorded only when every part recorded
 *  them (a partial list would claim files the run's other reports never
 *  attributed), with a file reported by several parts listed once, summed. */
function mergeFileResults(parts: readonly TestReportFiles[]): TestReportFiles {
  const byFile = new Map<string, TestFileResult>();
  for (const part of parts) {
    if (part.kind === "unrecorded") return UNRECORDED;
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

// --- Bun console collection errors ---
//
// Bun's JUnit reporter omits a test file that fails to load, and writes no
// report at all when every file of the run fails to load. Its console output
// is where the fact lives: each file's results follow a `<path>:` header, and
// a file that throws while loading (or between tests) prints
// `# Unhandled error between tests`, which Bun's own summary counts as one
// failing test. These functions read that fact and join it to the run's JUnit
// summary, so a Bun run records the same collection errors a Vitest run does.

/** ANSI SGR colour sequences, which a TTY-attached Bun run prints. */
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/** A Bun file-section header: a bare test file path (Bun's `*.test|spec` and
 *  `*_test|spec` script names) alone on its line, ending in `:`. Bun prints
 *  headers without whitespace, so a code-frame line (`4 | …`) or prose
 *  (`note: see x.test.ts:`) never matches; a path containing whitespace is
 *  not recognized, which only withholds a collection error (fail closed). */
const BUN_FILE_HEADER = /^([^\s|]+?[._](?:test|spec)\.[cm]?[jt]sx?):$/;

const BUN_UNHANDLED_ERROR = "# Unhandled error between tests";

/**
 * The test files Bun's console output reports a collection error for, in
 * first-appearance order, each once and named exactly as Bun's file header
 * writes it (relative to Bun's cwd, the form its JUnit `file` attribute uses).
 * An error printed before any file header belongs to no file and is ignored.
 * Total over any string.
 */
export function parseBunConsoleCollectionErrors(output: string): readonly string[] {
  const files: string[] = [];
  let current: string | null = null;
  for (const raw of output.replace(ANSI_SGR, "").split(/\r?\n/u)) {
    const line = raw.trimEnd();
    const header = BUN_FILE_HEADER.exec(line);
    if (header !== null) current = header[1];
    else if (line.trim() === BUN_UNHANDLED_ERROR && current !== null && !files.includes(current)) files.push(current);
  }
  return Object.freeze(files);
}

/**
 * One collection error as a single failing testcase: how Bun counts one, and
 * how an engine run whose runner crashed records each file it handed the runner.
 */
const collectionErrorResult = (file: string): TestFileResult =>
  Object.freeze({ file, executed: 1, failed: 1, skipped: 0, collectionError: true });

/**
 * An engine run whose runner exited non-zero without writing its report: each
 * file the engine handed the runner is one failing collection-error testcase
 * (source `runner-crash`). Null for an empty or repeated file list, which no
 * engine run produces.
 */
export function runnerCrashSummary(files: readonly string[]): TestReportSummary | null {
  if (files.length === 0 || new Set(files).size !== files.length) return null;
  return parseReportSummary(files.length, files.length, "runner-crash", {
    kind: "recorded",
    results: files.map(collectionErrorResult),
  });
}

/**
 * A Bun run's summary: its JUnit summary joined with the collection errors its
 * console reported (`parseBunConsoleCollectionErrors`), minted through
 * `parseReportSummary` like every other summary.
 * - No collection error: the JUnit summary unchanged (or null without one).
 * - No JUnit summary (Bun writes none when every file failed to load): a
 *   `bun-console` summary of the collection errors alone.
 * - Both: each collection error is one more failing testcase, as Bun counts
 *   it. A file the report omitted (it never loaded) is added as a collection
 *   error. A file the report lists did load, so it gains the failing testcase
 *   but keeps its own collection-error flag: an error between tests never
 *   hides a genuine assertion failure behind a collection error.
 * - A JUnit summary whose per-file results are unrecorded cannot have files
 *   attributed to it, so it is returned unchanged rather than half-merged.
 */
export function bunRunSummary(
  junit: TestReportSummary | null,
  collectionErrors: readonly string[],
): TestReportSummary | null {
  const errors = [...new Set(collectionErrors)];
  if (errors.length === 0) return junit;
  if (junit === null) {
    return parseReportSummary(errors.length, errors.length, "bun-console", {
      kind: "recorded",
      results: errors.map(collectionErrorResult),
    });
  }
  if (junit.files.kind !== "recorded") return junit;
  const reported = junit.files.results.map((entry) => errors.includes(entry.file)
    ? { ...entry, executed: entry.executed + 1, failed: entry.failed + 1 }
    : entry);
  const omitted = errors.filter((file) => !reported.some((entry) => entry.file === file));
  return parseReportSummary(junit.total + errors.length, junit.failed + errors.length, junit.source, {
    kind: "recorded",
    results: [...reported, ...omitted.map(collectionErrorResult)],
  });
}

/** Merge summaries from multiple report files of one run. The inputs must
 *  share ONE source — enforced at runtime, not by comment: a mixed-source
 *  merge would stamp the sum with the first summary's source, silently
 *  mislabeling half the counts. Fail closed to null instead.
 *  A merge that loses per-file results (some part recorded none) sums each
 *  part's `executedTestCount`, since an unrecorded summary's total is its
 *  executed count: a recorded part's skipped testcases never reappear as run. */
export function mergeSummaries(summaries: readonly TestReportSummary[]): TestReportSummary | null {
  if (summaries.length === 0) return null;
  if (summaries.some((s) => s.source !== summaries[0].source)) return null;
  // Route the summed counts and merged per-file results back through the sole
  // smart constructor rather than casting a fresh literal: summing sane
  // summaries stays sane, but the brand must be minted where its invariant
  // is (re)checked.
  const files = mergeFileResults(summaries.map((s) => s.files));
  const counted = files.kind === "recorded" ? (s: TestReportSummary) => s.total : executedTestCount;
  let total = 0;
  let failed = 0;
  for (const s of summaries) {
    total += counted(s);
    failed += s.failed;
  }
  return parseReportSummary(total, failed, summaries[0].source, files);
}
