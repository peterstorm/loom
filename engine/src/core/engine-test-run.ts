/**
 * Engine-run test evidence (loom#198, Cause 1): the receipt `helper run-tests`
 * prints after running a frozen Verification Manifest's `affectedRunner`, and
 * the one rule that turns it back into facts.
 *
 * A Task's test evidence is what the engine ran, not what an agent's shell
 * text looks like: the helper chooses the runner (the frozen manifest's),
 * the report path (the manifest's), and the files (the Task's test files the
 * agent names), and it prints the receipt last, after the runner has exited
 * and its process tree is gone. The runner's own output is printed to stderr
 * before it, so a test printing a forged receipt line cannot reach the
 * receipt slot, which is the LAST non-empty output line, even where a
 * harness merges the two streams (Pi).
 *
 * The receipt binds the run to the canonical repository root it ran in and
 * the frozen manifest digest it ran under; settlement admits it only when
 * both are its own TaskGraph's (`test-evidence-policy.ts`).
 *
 * Pure: formatting and parsing only.
 */

import {
  parseJunitXml,
  parseReportSource,
  parseReportSummary,
  parseVitestJson,
  runnerCrashSummary,
  type TestReportSummary,
} from "./structured-test-report";

/** The receipt line's fixed prefix; the JSON receipt follows it on the same line. */
export const ENGINE_TEST_RUN_RECEIPT_PREFIX = "LOOM_TEST_RUN_RECEIPT " as const;

const RECEIPT_KIND = "loom-engine-test-run" as const;
const RECEIPT_SCHEMA_VERSION = 1 as const;
/** The receipt's keys, sorted, as the parse compares them. */
const RECEIPT_KEYS: readonly string[] = Object.freeze(
  ["exit", "files", "kind", "manifestDigest", "repositoryRoot", "report", "schemaVersion"].sort(),
);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * One engine run as the helper observed it. `exit` is the runner's own exit;
 * `report` is the parsed report, a `runner-crash` summary when the runner
 * exited non-zero without one, or null when no trusted summary exists (a
 * zero exit without a report, or a report that did not parse).
 */
export type EngineTestRunReceipt = Readonly<{
  repositoryRoot: string;
  manifestDigest: string;
  files: readonly string[];
  exit: number;
  report: TestReportSummary | null;
}>;

export type EngineTestRunReceiptParse =
  | Readonly<{ ok: true; value: EngineTestRunReceipt }>
  | Readonly<{ ok: false; error: string }>;

const refused = (error: string): EngineTestRunReceiptParse => Object.freeze({ ok: false, error });

/** The receipt line for one run: the prefix, then the receipt as compact JSON. */
export function formatEngineTestRunReceipt(receipt: EngineTestRunReceipt): string {
  return `${ENGINE_TEST_RUN_RECEIPT_PREFIX}${JSON.stringify({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    repositoryRoot: receipt.repositoryRoot,
    manifestDigest: receipt.manifestDigest,
    files: receipt.files,
    exit: receipt.exit,
    report: receipt.report,
  })}`;
}

const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw);

/** A wire report re-minted through the sole summary constructor, or why not. */
function parseReceiptReport(raw: unknown): Readonly<{ ok: true; value: TestReportSummary | null }> | Readonly<{ ok: false; error: string }> {
  if (raw === null) return { ok: true, value: null };
  if (!isRecord(raw)) return { ok: false, error: "report must be an object or null" };
  const source = parseReportSource(raw.source);
  const summary = source === null ? null : parseReportSummary(raw.total, raw.failed, source, raw.files);
  return summary === null ? { ok: false, error: "report is not a reconciled report summary" } : { ok: true, value: summary };
}

/**
 * The receipt on the LAST non-empty line of `stdout`, or why there is none.
 * Exact keys, an absolute repository root, a sha256 manifest digest, a
 * non-empty list of distinct files, an integer exit and a report re-minted
 * through `parseReportSummary`. Anything else is refused whole.
 */
export function parseEngineTestRunReceipt(stdout: string): EngineTestRunReceiptParse {
  const last = stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "").at(-1);
  if (last === undefined || !last.startsWith(ENGINE_TEST_RUN_RECEIPT_PREFIX)) {
    return refused("the last output line is not an engine test-run receipt");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(last.slice(ENGINE_TEST_RUN_RECEIPT_PREFIX.length));
  } catch {
    return refused("the receipt is not JSON");
  }
  if (!isRecord(raw)) return refused("the receipt must be an object");
  const keys = Object.keys(raw).sort();
  if (keys.length !== RECEIPT_KEYS.length || keys.some((key, index) => key !== RECEIPT_KEYS[index])) {
    return refused(`the receipt must carry exactly ${RECEIPT_KEYS.join(", ")}`);
  }
  if (raw.schemaVersion !== RECEIPT_SCHEMA_VERSION || raw.kind !== RECEIPT_KIND) return refused("the receipt tag is not recognized");
  const { repositoryRoot, manifestDigest, files, exit } = raw;
  if (typeof repositoryRoot !== "string" || !repositoryRoot.startsWith("/")) return refused("repositoryRoot must be absolute");
  if (typeof manifestDigest !== "string" || !SHA256_HEX.test(manifestDigest)) return refused("manifestDigest must be a sha256 digest");
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || file === "")) {
    return refused("files must be a non-empty list of paths");
  }
  if (new Set(files).size !== files.length) return refused("files must be distinct");
  if (typeof exit !== "number" || !Number.isSafeInteger(exit)) return refused("exit must be an integer");
  const report = parseReceiptReport(raw.report);
  if (!report.ok) return refused(report.error);
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      repositoryRoot,
      manifestDigest,
      files: Object.freeze([...(files as string[])]),
      exit,
      report: report.value,
    }),
  });
}

/**
 * The report one finished engine run yields, from the runner's exit and the
 * text of the report it left at the manifest's report path (null when it left
 * none, or none that could be read):
 * - the report itself when it parses as JUnit XML or Vitest JSON, whatever
 *   the exit: the judge reads failing testcases and the exit together;
 * - a `runner-crash` summary when the runner exited non-zero without one,
 *   so a red whose runner could not even load the files still counts under
 *   the collection-error rule, and can never be a green;
 * - null otherwise: an exit 0 with no report proves nothing.
 */
export function engineRunReport(files: readonly string[], exit: number, reportText: string | null): TestReportSummary | null {
  const parsed = reportText === null ? null : parseJunitXml(reportText) ?? parseVitestJson(reportText);
  if (parsed !== null) return parsed;
  return exit === 0 ? null : runnerCrashSummary(files);
}
