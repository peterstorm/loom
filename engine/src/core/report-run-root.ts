/**
 * Reading a JUnit report's testcase files against the root its runner ran in.
 *
 * Runners name a testcase's file in their own way: Bun and Vitest write a
 * path relative to the runner's cwd, Mocha's xunit reporter an absolute
 * one. Attribution (`report-file-attribution.ts`, INV-5) matches relative
 * identities only, and leaves an absolute one unattributed unless it knows
 * the root to read it against. The shell that ran the command knows that
 * root (the repository for the completion suite and the stop checks, the
 * isolated worktree for mutation runs), so it states it here, once, right
 * where the report is parsed.
 *
 * An absolute file strictly inside the run root becomes root-relative; any
 * other file is left exactly as reported, so a path outside the root stays
 * unattributed and fails closed.
 *
 * Pure: no I/O.
 */
import { normalizePlanPath } from "./plan-path-match";
import { repositoryRelative } from "./report-file-attribution";
import {
  parseJunitTestcases,
  type JunitTestcasesResult,
  type ReportTestcase,
} from "./structured-test-report";

const underRunRoot = (testcase: ReportTestcase, runRoot: string): ReportTestcase => {
  const relative = repositoryRelative(normalizePlanPath(testcase.file), runRoot);
  return relative === null || relative === testcase.file
    ? testcase
    : Object.freeze({ ...testcase, file: relative });
};

/** The report's testcases with every absolute file inside `runRoot` made relative to it. */
export function testcasesUnderRunRoot(projection: JunitTestcasesResult, runRoot: string): JunitTestcasesResult {
  return projection.ok
    ? { ok: true, value: Object.freeze(projection.value.map((testcase) => underRunRoot(testcase, runRoot))) }
    : projection;
}

/** Parse a JUnit report whose runner ran in `runRoot` (see the module comment). */
export function parseJunitTestcasesUnder(bytes: Uint8Array, runRoot: string): JunitTestcasesResult {
  return testcasesUnderRunRoot(parseJunitTestcases(bytes), runRoot);
}
