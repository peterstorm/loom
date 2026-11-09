/**
 * Bun runs record the collection errors Bun's JUnit reporter leaves out
 * (ADR-0064). Bun omits a test file that fails to load from its JUnit report,
 * and writes no report at all when every file of the run fails to load; its
 * console is where the fact lives. Capture joins the two only for an explicit
 * `bun test --reporter=junit --reporter-outfile=…` run whose non-zero exit Loom
 * attributes to that segment, and never beside a report that cannot vouch.
 *
 * The console and JUnit fixtures are real Bun 1.4.2 output from a probe
 * project: `a.test.ts` imports a module that does not exist, `b.test.ts`
 * passes, `c.test.ts` has one failing testcase.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeToolCall, piToolCall } from "../../src/core/harness-tool-call";
import type { HarnessToolCall } from "../../src/machine/harness-tool-call-types";
import { extractEvidence } from "../../src/machine/extract-evidence";
import { findReport } from "../../src/machine/report-discovery";
import { judgeTestRun } from "../../src/machine/test-report";
import type { TestFileResult } from "../../src/core/structured-test-report";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const MIXED_CONSOLE = fixture("bun-1.4.2-mixed.console.txt");
const MIXED_JUNIT = fixture("bun-1.4.2-mixed.junit.xml");
const LOAD_FAILURE_CONSOLE = fixture("bun-1.4.2-load-failure-only.console.txt");

const result = (file: string, executed: number, failed: number, collectionError = false): TestFileResult =>
  ({ file, executed, failed, skipped: 0, collectionError });

let dir: string;
let report: string;
let command: string;
const times = () => ({ nowMs: Date.now(), callStartMs: Date.now() - 1_000 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loom-bun-console-"));
  report = join(dir, "bun.junit.xml");
  command = `bun test --reporter=junit --reporter-outfile=${report} src/a.test.ts`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const quietly = <T>(run: () => T): T => {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
};

describe("findReport — Bun console collection errors", () => {
  it("mints a bun-console summary when every file failed to load and Bun wrote no JUnit report", () => {
    const summary = findReport(command, dir, { output: LOAD_FAILURE_CONSOLE, exit: 1 }, times());
    expect(summary).toMatchObject({ total: 1, failed: 1, source: "bun-console" });
    expect(summary?.files).toEqual({ kind: "recorded", results: [result("src/a.test.ts", 1, 1, true)] });
    expect(judgeTestRun(1, summary)).toEqual({ verdict: "trusted-fail" });
  });

  it("joins the JUnit report with the file it left out, to Bun's own totals (5 tests, 2 failing)", () => {
    writeFileSync(report, MIXED_JUNIT);
    const summary = findReport(command, dir, { output: MIXED_CONSOLE, exit: 1 }, times());
    expect(summary).toMatchObject({ total: 5, failed: 2, source: "junit-xml" });
    expect(summary?.files).toEqual({
      kind: "recorded",
      results: [result("src/b.test.ts", 1, 0), result("src/c.test.ts", 3, 1), result("src/a.test.ts", 1, 1, true)],
    });
  });

  it("reads no console without a non-zero exit attributed to the Bun segment", () => {
    for (const exit of [null, 0]) {
      expect(quietly(() => findReport(command, dir, { output: LOAD_FAILURE_CONSOLE, exit }, times())), String(exit)).toBeNull();
    }
    writeFileSync(report, MIXED_JUNIT);
    expect(findReport(command, dir, { output: MIXED_CONSOLE, exit: null }, times())).toMatchObject({ total: 4, failed: 1 });
  });

  it("never lets the console vouch beside a JUnit report that cannot: vetoed, stale, malformed or without a stamp", () => {
    const run = { output: MIXED_CONSOLE, exit: 1 };
    writeFileSync(report, MIXED_JUNIT);
    expect(quietly(() => findReport(command, dir, run, times(), () => true))).toBeNull();
    expect(quietly(() => findReport(command, dir, run, { nowMs: Date.now(), callStartMs: null }))).toBeNull();
    expect(quietly(() => findReport(command, dir, run, { nowMs: Date.now(), callStartMs: Date.now() + 60_000 }))).toBeNull();
    writeFileSync(report, '<testsuite tests="1" failures="2"/>');
    expect(quietly(() => findReport(command, dir, run, times()))).toBeNull();
  });

  it("reads no console for a Bun run that names no JUnit reporter", () => {
    expect(findReport("bun test src/a.test.ts", dir, { output: LOAD_FAILURE_CONSOLE, exit: 1 }, times())).toBeNull();
  });
});

describe("a red Bun run that never loads, through each harness's recorder path", () => {
  const finder = (segment: string, run: { output: string; exit: number | null }) => findReport(segment, dir, run, times());
  const testRunOf = (call: HarnessToolCall) => extractEvidence(call, finder).find((event) => event.kind === "TestRun");

  it("Claude Code: a PostToolUseFailure carrying Bun's console records the collection error", () => {
    const call = claudeToolCall({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "toolu_red",
      error: `Exit code 1\n${LOAD_FAILURE_CONSOLE}`,
      cwd: dir,
    });
    expect(testRunOf(call)).toMatchObject({
      kind: "TestRun",
      exit: 1,
      report: { total: 1, failed: 1, source: "bun-console", files: { kind: "recorded", results: [result("src/a.test.ts", 1, 1, true)] } },
    });
  });

  it("Pi: an error bash result carrying Bun's console records the same collection error", () => {
    const call = piToolCall({
      toolName: "bash",
      toolCallId: "pi_red",
      input: { command },
      content: [{ type: "text", text: `${LOAD_FAILURE_CONSOLE}\nCommand exited with code 1` }],
      isError: true,
    }, dir);
    expect(testRunOf(call)).toMatchObject({ kind: "TestRun", exit: 1, report: { source: "bun-console", total: 1, failed: 1 } });
  });

  it("a later segment that owns the line's exit cannot plant console facts for the Bun run", () => {
    const call = claudeToolCall({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: `${command}; false` },
      tool_use_id: "toolu_planted",
      error: `Exit code 1\n${LOAD_FAILURE_CONSOLE}`,
      cwd: dir,
    });
    expect(quietly(() => testRunOf(call))).toMatchObject({ kind: "TestRun", exit: null, report: null });
  });
});
