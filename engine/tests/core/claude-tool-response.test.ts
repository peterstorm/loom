/**
 * Claude Code's hook payload readers in `core/harness-tool-call.ts`:
 * `claudeToolResult`, `claudeBashOutcome` and `isClaudeToolFailure`. Every
 * Claude minting fact starts here, so an unknown shape must degrade to the
 * outcome that trusts least, never to an invented exit or a starved ledger.
 *
 * Claude Code reports a finished Bash call through one of two hook events.
 * PostToolUse fires only when the call succeeded; a command that exits
 * non-zero is a failed call and fires PostToolUseFailure, whose `error`
 * starts `Exit code N`. `SUCCESS_SHAPE` and the `Exit code N` errors were
 * taken from Claude Code 2.1.286 (its bundle and a live subagent transcript);
 * the other inputs are synthetic defensive shapes.
 */

import { describe, expect, it } from "vitest";
import {
  claudeBashOutcome,
  claudeToolCall,
  claudeToolResult,
  isClaudeToolFailure,
} from "../../src/core/harness-tool-call";

const succeeded = (toolResponse: unknown, input: Record<string, unknown> = {}) =>
  claudeBashOutcome({ kind: "succeeded", toolResponse, input });
const failed = (error: string, interrupted = false) => claudeBashOutcome({ kind: "failed", error, interrupted });

/** Claude Code 2.1.286's Bash success `tool_response`, verbatim in shape. */
const SUCCESS_SHAPE = { stdout: "31 passed", stderr: "", interrupted: false, isImage: false, noOutputExpected: false };

describe("claudeToolResult — which hook event delivered the call", () => {
  it("only an explicit PostToolUseFailure is a failure", () => {
    expect(claudeToolResult({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "Exit code 1\nboom", is_interrupt: false, cwd: "/r" }))
      .toEqual({ kind: "failed", error: "Exit code 1\nboom", interrupted: false });
    expect(claudeToolResult({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: SUCCESS_SHAPE, cwd: "/r" }))
      .toEqual({ kind: "succeeded", toolResponse: SUCCESS_SHAPE, input: { command: "ls" } });
    expect(claudeToolResult({ tool_name: "Bash", tool_response: SUCCESS_SHAPE, cwd: "/r" }))
      .toEqual({ kind: "succeeded", toolResponse: SUCCESS_SHAPE, input: {} });
  });

  it("a success without a tool_response has no known exit, never exit 0", () => {
    expect(claudeBashOutcome(claudeToolResult({ tool_name: "Bash", error: "Exit code 1", cwd: "/r" })))
      .toEqual({ kind: "exit-unknown", stdout: "" });
  });

  it("reads a malformed failure as an empty, uninterrupted error", () => {
    expect(claudeToolResult({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: { message: "x" }, is_interrupt: "yes", cwd: "/r" }))
      .toEqual({ kind: "failed", error: "", interrupted: false });
  });
});

describe("claudeBashOutcome — a successful call", () => {
  it("Claude Code's real success shape is exit 0", () => {
    expect(succeeded(SUCCESS_SHAPE)).toEqual({ kind: "exited", exit: 0, stdout: "31 passed" });
  });

  it("a success the harness reinterpreted from a non-zero exit has no known exit", () => {
    expect(succeeded({ ...SUCCESS_SHAPE, stdout: "", returnCodeInterpretation: "No matches found" }))
      .toEqual({ kind: "exit-unknown", stdout: "" });
  });

  it("a backgrounded call never finished within the call", () => {
    expect(succeeded(SUCCESS_SHAPE, { command: "npx vitest run", run_in_background: true })).toEqual({ kind: "interrupted" });
    expect(succeeded({ ...SUCCESS_SHAPE, backgroundTaskId: "bash_1" })).toEqual({ kind: "interrupted" });
  });

  it("reads known exit-code field names", () => {
    expect(succeeded({ exit_code: 1, stdout: "x" })).toEqual({ kind: "exited", exit: 1, stdout: "x" });
    expect(succeeded({ exitCode: 0, stdout: "y" })).toEqual({ kind: "exited", exit: 0, stdout: "y" });
    expect(succeeded({ returnCode: 2 })).toEqual({ kind: "exited", exit: 2, stdout: "" });
    expect(succeeded({ code: 0, output: "z" })).toEqual({ kind: "exited", exit: 0, stdout: "z" });
  });

  it("never invents an exit code for an unknown shape", () => {
    expect(succeeded({ exit_code: 1.5 })).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(succeeded({ exit_code: "0" })).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(succeeded({ weird: true })).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(succeeded({ stdout: "x" })).toEqual({ kind: "exit-unknown", stdout: "x" });
    expect(succeeded("raw text")).toEqual({ kind: "exit-unknown", stdout: "raw text" });
    expect(succeeded(null)).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(succeeded(undefined)).toEqual({ kind: "exit-unknown", stdout: "" });
  });

  // An unknown exit and a killed call both carry no exit, but only the second
  // means the command never finished: minting drops a green report for a killed
  // run, so the two must stay distinct outcomes rather than fold into one.
  it("a killed call is interrupted, whatever exit and output it also reports", () => {
    expect(succeeded({ interrupted: true, exit_code: 0, stdout: "5 passing" })).toEqual({ kind: "interrupted" });
    expect(succeeded({ interrupted: true })).toEqual({ kind: "interrupted" });
    expect(succeeded({ interrupted: false, exit_code: 0 })).toEqual({ kind: "exited", exit: 0, stdout: "" });
  });
});

describe("claudeBashOutcome — a failed call", () => {
  it("reads the exit from the error's first line, and the rest as the output", () => {
    expect(failed("Exit code 1\n Tests  2 failed (2)\n")).toEqual({ kind: "exited", exit: 1, stdout: " Tests  2 failed (2)\n" });
    expect(failed("Error: Exit code 2\nout")).toEqual({ kind: "exited", exit: 2, stdout: "out" });
    expect(failed("Exit code 127")).toEqual({ kind: "exited", exit: 127, stdout: "" });
  });

  it("a timeout or an interrupt is a kill, even with an exit line", () => {
    expect(failed("Exit code 143\nCommand timed out after 2m 0s")).toEqual({ kind: "interrupted" });
    expect(failed("Exit code 130\npartial", true)).toEqual({ kind: "interrupted" });
  });

  it("a failure without an exit line has no known exit", () => {
    expect(failed("Bash: pre-spawn error")).toEqual({ kind: "exit-unknown", stdout: "Bash: pre-spawn error" });
    expect(failed("")).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(failed("Exit code one\n")).toEqual({ kind: "exit-unknown", stdout: "Exit code one\n" });
  });
});

describe("claudeToolCall — the adapter reads a failure event for any tool (hooks.json wires it for Bash only)", () => {
  it("a file tool delivered by PostToolUseFailure failed, whatever its response", () => {
    expect(claudeToolCall({ hook_event_name: "PostToolUseFailure", tool_name: "Edit", tool_input: { file_path: "/r/a.ts" }, error: "old_string not found", cwd: "/r" }))
      .toEqual({ tool: "Edit", input: { file_path: "/r/a.ts" }, callId: null, cwd: "/r", outcome: { kind: "failed" } });
  });

  it("a Bash call delivered by PostToolUseFailure carries its exit", () => {
    expect(claudeToolCall({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1\nfail", tool_use_id: "t1", cwd: "/r" }))
      .toEqual({ tool: "Bash", input: { command: "npm test" }, callId: "t1", cwd: "/r", outcome: { kind: "exited", exit: 1, stdout: "fail" } });
  });
});

describe("isClaudeToolFailure — error shapes and nothing else", () => {
  it("recognizes every error spelling", () => {
    expect(isClaudeToolFailure({ is_error: true })).toBe(true);
    expect(isClaudeToolFailure({ isError: true })).toBe(true);
    expect(isClaudeToolFailure({ success: false })).toBe(true);
    expect(isClaudeToolFailure({ error: "boom" })).toBe(true);
    expect(isClaudeToolFailure({ error: { message: "boom" } })).toBe(true);
  });

  it("reads success and unknown shapes as success, so the ledger never starves", () => {
    expect(isClaudeToolFailure({ is_error: false })).toBe(false);
    expect(isClaudeToolFailure({ success: true })).toBe(false);
    expect(isClaudeToolFailure({ error: "" })).toBe(false);
    expect(isClaudeToolFailure({ error: "   " })).toBe(false);
    expect(isClaudeToolFailure("plain text output")).toBe(false);
    expect(isClaudeToolFailure(null)).toBe(false);
    expect(isClaudeToolFailure(undefined)).toBe(false);
  });
});
