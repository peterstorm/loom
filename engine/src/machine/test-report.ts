/**
 * Machine-readable test report parsing + the TestRun trust judgment.
 *
 * Deterministic parsing of structured artifacts (vitest/jest JSON, JUnit
 * XML) — never regex over human-oriented prose. The report artifact is the
 * anti-spoof: `echo "npm test: 5 passing"` exits 0 but writes no report.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
 * The R2 trust rule:
 * - exit 0 + report with ≥1 test and 0 failures  → passed, trusted
 * - exit 0 + report with 0 tests                 → NOT passed (nothing ran), trusted
 * - exit 0 + no report                           → NOT passed, NOT trusted (fall back downstream)
 * - nonzero exit                                 → NOT passed, trusted (a real failure is ground truth)
 * - unknown exit                                 → NOT passed, NOT trusted
 */
export function judgeTestRun(
  exit: number | null,
  report: TestReportSummary | null,
): { passed: boolean; trusted: boolean } {
  if (exit === null) return { passed: false, trusted: false };
  if (exit !== 0) return { passed: false, trusted: true };
  if (report === null) return { passed: false, trusted: false };
  return { passed: report.total > 0 && report.failed === 0, trusted: true };
}

// --- Report discovery (IO at the edge) ---

/** Extract an explicit report path from the command itself (vitest/jest --outputFile). */
export function outputFileFromCommand(command: string): string | null {
  const m = command.match(/--outputFile[=\s]+("([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? null;
}

const JUNIT_REPORT_DIRS = [
  "target/surefire-reports",
  "target/failsafe-reports",
  "build/test-results/test",
];

/**
 * Reports older than this are ignored. Time-based, not run-based: this
 * BOUNDS cross-run attribution (an artifact from hours ago can't vouch) but
 * does not eliminate it — a same-family runner command within the window
 * can still pick up a sibling run's report. Runner-family scoping in
 * findReport narrows the blast radius further.
 */
const FRESHNESS_MS = 15 * 60 * 1000;

function isFresh(path: string, nowMs: number): boolean {
  try {
    return nowMs - statSync(path).mtimeMs <= FRESHNESS_MS;
  } catch {
    return false;
  }
}

function readJunitDir(dir: string, nowMs: number): TestReportSummary[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".xml"))
      .map((f) => join(dir, f))
      .filter((p) => isFresh(p, nowMs))
      .map((p) => parseJunitXml(readFileSync(p, "utf-8")))
      .filter((s): s is TestReportSummary => s !== null);
  } catch {
    return [];
  }
}

/** Walk one level of subdirectories for multi-module builds (bounded, no recursion). */
function moduleDirs(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => join(cwd, d.name));
  } catch {
    return [];
  }
}

/** Runners whose reports are JUnit XML in conventional build dirs. */
const JVM_RUNNER_PREFIXES = ["mvn", "mvnw", "./mvnw", "gradle", "./gradlew"];

/**
 * Find a machine-readable report artifact for a classified test command
 * SEGMENT (the head-matched simple command from classifyTestCommand — never
 * the whole prose command line). Sources, scoped to the runner family so an
 * artifact can't vouch for an unrelated command:
 * 1. Explicit `--outputFile` path on the segment (vitest/jest JSON)
 * 2. JSON on stdout when the segment asked for a JSON reporter
 * 3. Fresh JUnit XML in conventional dirs — JVM runners only
 */
export function findReport(
  segment: string,
  cwd: string,
  stdout: string,
  nowMs: number,
): TestReportSummary | null {
  const explicit = outputFileFromCommand(segment);
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (existsSync(path) && isFresh(path, nowMs)) {
      try {
        const parsed = parseVitestJson(readFileSync(path, "utf-8"));
        if (parsed) return parsed;
      } catch (e) {
        // Unreadable explicit report (permissions, race, path is a dir):
        // fall through to the next report source — the TestRun fact must
        // survive with report: null instead of crashing the recorder.
        process.stderr.write(`findReport: cannot read --outputFile '${path}': ${(e as Error).message}\n`);
      }
    }
  }

  if (/--reporter[= ]json|--json\b/.test(segment)) {
    const parsed = parseVitestJson(stdout.trim());
    if (parsed) return parsed;
  }

  const lower = segment.toLowerCase();
  if (!JVM_RUNNER_PREFIXES.some((p) => lower.startsWith(p))) return null;

  const junit = [
    ...JUNIT_REPORT_DIRS.flatMap((d) => readJunitDir(resolve(cwd, d), nowMs)),
    ...moduleDirs(cwd).flatMap((m) => JUNIT_REPORT_DIRS.flatMap((d) => readJunitDir(join(m, d), nowMs))),
  ];
  return mergeSummaries(junit);
}
