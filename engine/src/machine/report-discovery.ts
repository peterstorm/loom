/**
 * Report discovery — the imperative shell around test-report.ts.
 *
 * Finds machine-readable report artifacts on disk (explicit --outputFile,
 * JSON on stdout, conventional JUnit dirs) and hands their contents to the
 * pure parsers. All node:fs usage of the report pipeline lives HERE, so
 * test-report.ts (and the reducer that imports its judgment) stays pure.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { TestReportSummary } from "./types";
import { mergeSummaries, parseJunitXml, parseVitestJson } from "./test-report";

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

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isFresh(path: string, nowMs: number): boolean {
  try {
    return nowMs - statSync(path).mtimeMs <= FRESHNESS_MS;
  } catch (e) {
    // Unstatable report → treated as stale (fail closed), but say so: a
    // silently-ignored artifact looks identical to "no report was written".
    process.stderr.write(`findReport: cannot stat report '${path}': ${errMessage(e)}\n`);
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
  } catch (e) {
    // Unreadable report dir → no reports (fail closed), logged so a
    // permissions/race problem is distinguishable from an empty dir.
    process.stderr.write(`findReport: cannot read JUnit dir '${dir}': ${errMessage(e)}\n`);
    return [];
  }
}

/** Walk one level of subdirectories for multi-module builds (bounded, no recursion). */
function moduleDirs(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => join(cwd, d.name));
  } catch (e) {
    // Unlistable cwd → no module dirs (fail closed), logged loudly.
    process.stderr.write(`findReport: cannot list module dirs under '${cwd}': ${errMessage(e)}\n`);
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
        process.stderr.write(`findReport: cannot read --outputFile '${path}': ${errMessage(e)}\n`);
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
