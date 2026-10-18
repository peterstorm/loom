/**
 * Claude Code's raw `tool_response` readers in `core/harness-tool-call.ts`:
 * `claudeBashOutcome` and `isClaudeToolFailure`. Every Claude minting fact
 * starts here, so an unknown shape must degrade to the outcome that trusts
 * least, never to an invented exit or a starved ledger.
 */

import { describe, expect, it } from "vitest";
import { claudeBashOutcome, isClaudeToolFailure } from "../../src/core/harness-tool-call";

describe("claudeBashOutcome — defensive harness-shape parsing", () => {
  it("reads known exit-code field names", () => {
    expect(claudeBashOutcome({ exit_code: 1, stdout: "x" })).toEqual({ kind: "exited", exit: 1, stdout: "x" });
    expect(claudeBashOutcome({ exitCode: 0, stdout: "y" })).toEqual({ kind: "exited", exit: 0, stdout: "y" });
    expect(claudeBashOutcome({ returnCode: 2 })).toEqual({ kind: "exited", exit: 2, stdout: "" });
    expect(claudeBashOutcome({ code: 0, output: "z" })).toEqual({ kind: "exited", exit: 0, stdout: "z" });
  });

  it("never invents an exit code", () => {
    expect(claudeBashOutcome({ exit_code: 1.5 })).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(claudeBashOutcome({ exit_code: "0" })).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(claudeBashOutcome({ weird: true })).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(claudeBashOutcome("raw text")).toEqual({ kind: "exit-unknown", stdout: "raw text" });
    expect(claudeBashOutcome(null)).toEqual({ kind: "exit-unknown", stdout: "" });
    expect(claudeBashOutcome(undefined)).toEqual({ kind: "exit-unknown", stdout: "" });
  });

  // An unknown exit and a killed call both carry no exit, but only the second
  // means the command never finished: minting drops a green report for a killed
  // run, so the two must stay distinct outcomes rather than fold into one.
  it("a killed call is interrupted, whatever exit and output it also reports", () => {
    expect(claudeBashOutcome({ interrupted: true, exit_code: 0, stdout: "5 passing" })).toEqual({ kind: "interrupted" });
    expect(claudeBashOutcome({ interrupted: true })).toEqual({ kind: "interrupted" });
    expect(claudeBashOutcome({ interrupted: false, exit_code: 0 })).toEqual({ kind: "exited", exit: 0, stdout: "" });
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
