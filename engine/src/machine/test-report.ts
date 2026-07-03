/**
 * Machine-readable test report parsing + the TestRun trust judgment.
 *
 * Deterministic parsing of structured artifacts (vitest/jest JSON, JUnit
 * XML) — never regex over human-oriented prose. The report artifact is the
 * anti-spoof: `echo "npm test: 5 passing"` exits 0 but writes no report.
 *
 * PURE module: report *discovery* (filesystem walking, freshness stats)
 * lives in report-discovery.ts so the reducer core can import the judgment
 * without transitively importing node:fs.
 */

import type { TestReportSummary } from "./types";

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
  if (!Number.isInteger(total) || !Number.isInteger(failed)) return null;
  if (total < 0 || failed < 0 || failed > total) return null;
  return { total, failed, source };
}

/** vitest `--reporter=json` / jest `--json` share the summary shape. */
export function parseVitestJson(content: string): TestReportSummary | null {
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

/** Sum tests/failures/errors across <testsuite> elements (surefire, failsafe, gradle). */
export function parseJunitXml(content: string): TestReportSummary | null {
  const suites = [...content.matchAll(/<testsuite\b[^>]*>/g)];
  if (suites.length === 0) return null;

  let total = 0;
  let failed = 0;
  let sawCounts = false;
  for (const [tag] of suites) {
    const tests = tag.match(/\btests="(\d+)"/);
    if (!tests) continue;
    sawCounts = true;
    total += Number(tests[1]);
    const failures = tag.match(/\bfailures="(\d+)"/);
    const errors = tag.match(/\berrors="(\d+)"/);
    failed += Number(failures?.[1] ?? 0) + Number(errors?.[1] ?? 0);
  }
  // \d+ capture groups guarantee non-negative integers per suite, but the
  // failures+errors sum can still exceed tests in a malformed report —
  // parseReportSummary refuses it (fail closed) rather than vouch.
  return sawCounts ? parseReportSummary(total, failed, "junit-xml") : null;
}

/** Merge summaries from multiple report files of one run. */
export function mergeSummaries(summaries: readonly TestReportSummary[]): TestReportSummary | null {
  if (summaries.length === 0) return null;
  return summaries.reduce((a, b) => ({
    total: a.total + b.total,
    failed: a.failed + b.failed,
    source: a.source,
  }));
}

// --- Pure judgment ---

/**
 * The three possible trust verdicts on a TestRun. A "trusted pass" and a
 * "trusted fail" are ground truth; "untrusted" means the run proves
 * nothing either way (downstream falls back to labeled low-trust
 * evidence). An inconsistent {passed: true, trusted: false} state is
 * unrepresentable in this shape.
 */
export type TestVerdict =
  | { readonly verdict: "trusted-pass" }
  | { readonly verdict: "trusted-fail" }
  | { readonly verdict: "untrusted" };

/** The verdicts that constitute ground truth. */
export type TrustedTestVerdict = Extract<TestVerdict, { verdict: "trusted-pass" | "trusted-fail" }>;

/**
 * The TestRun trust rule:
 * - exit 0 + report with ≥1 test and 0 failures  → trusted-pass
 * - exit 0 + report with 0 tests                 → trusted-fail (nothing ran)
 * - exit 0 + report with failures                → trusted-fail
 * - exit 0 + no report                           → untrusted (fall back downstream)
 * - nonzero exit                                 → trusted-fail (a real failure is ground truth)
 * - unknown exit                                 → untrusted
 */
export function judgeTestRun(exit: number | null, report: TestReportSummary | null): TestVerdict {
  if (exit === null) return { verdict: "untrusted" };
  if (exit !== 0) return { verdict: "trusted-fail" };
  if (report === null) return { verdict: "untrusted" };
  return report.total > 0 && report.failed === 0
    ? { verdict: "trusted-pass" }
    : { verdict: "trusted-fail" };
}
