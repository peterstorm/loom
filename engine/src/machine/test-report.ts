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
  const total = o.numTotalTests;
  const failed = o.numFailedTests;
  if (typeof total !== "number" || typeof failed !== "number") return null;
  return { total, failed, source: "vitest-json" };
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
  return sawCounts ? { total, failed, source: "junit-xml" } : null;
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
 * evidence). The impossible {passed: true, trusted: false} of the old
 * two-boolean shape is unrepresentable.
 */
export type TestVerdict =
  | { readonly verdict: "trusted-pass" }
  | { readonly verdict: "trusted-fail" }
  | { readonly verdict: "untrusted" };

/** The verdicts that constitute ground truth. */
export type TrustedTestVerdict = Extract<TestVerdict, { verdict: "trusted-pass" | "trusted-fail" }>;

/**
 * The R2 trust rule:
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
