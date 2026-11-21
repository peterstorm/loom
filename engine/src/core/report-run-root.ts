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
 * `parseJunitTestcasesUnder` is the one way engine code turns report bytes
 * into testcases (the INV-9 lint rule refuses any other call of the raw
 * parser), and its root is a `RunRoot`: minted by `parseRunRoot`, or a
 * canonical repository root, which is one by construction. A relative or
 * unresolved string cannot stand in.
 *
 * An absolute file strictly inside the run root becomes root-relative; any
 * other file is left exactly as reported, so a path outside the root stays
 * unattributed and fails closed.
 *
 * Pure: no I/O.
 */
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { normalizePlanPath } from "./plan-path-match";
import { repositoryRelative } from "./report-file-attribution";
import {
  readTestReport,
  reportTestcases,
  type JunitTestcasesResult,
  type ReportTestcase,
} from "./structured-test-report";

declare const RUN_ROOT: unique symbol;

/** The absolute, normalized POSIX directory a runner ran in. Only `parseRunRoot` mints one. */
export type RunRoot = string & { readonly [RUN_ROOT]: true };

/**
 * A run root, or why `raw` is not one: it must be absolute (`/`-rooted), use
 * `/` separators, and hold no empty, `.` or `..` segment and no trailing `/`
 * (the filesystem root `/` itself excepted).
 */
export function parseRunRoot(raw: string): DomainResult<RunRoot, string> {
  if (raw === "/") return success(raw as RunRoot);
  if (!raw.startsWith("/") || raw.includes("\\")) return failure(`run root ${JSON.stringify(raw)} is not an absolute POSIX path`);
  const segments = raw.slice(1).split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    ? success(raw as RunRoot)
    : failure(`run root ${JSON.stringify(raw)} is not a normalized path`);
}

const underRunRoot = (testcase: ReportTestcase, runRoot: RunRoot): ReportTestcase => {
  const relative = repositoryRelative(normalizePlanPath(testcase.file), runRoot);
  return relative === null || relative === testcase.file
    ? testcase
    : Object.freeze({ ...testcase, file: relative });
};

/** Parse a JUnit report whose runner ran in `runRoot` (see the module comment). */
export function parseJunitTestcasesUnder(bytes: Uint8Array, runRoot: RunRoot): JunitTestcasesResult {
  const parsed = reportTestcases(readTestReport(bytes));
  return parsed.ok
    ? { ok: true, value: Object.freeze(parsed.value.map((testcase) => underRunRoot(testcase, runRoot))) }
    : parsed;
}
