/**
 * PostToolUse type-diagnostics handler: maps an advisory onto Claude Code's
 * hook channels and never blocks. The advisory itself is a port, so these
 * tests drive every channel with plain fakes; the real compiler path is
 * covered by tests/handlers/type-diagnostics-runner.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createTypeDiagnosticsHandler } from "../../../src/handlers/post-tool-use/type-diagnostics";
import { hookSuccessStdout, postToolUseContextResult } from "../../../src/types";
import type { TypeAdvisory } from "../../../src/core/type-diagnostics";

const stdin = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" },
  ...overrides,
});

const advising = (advisory: TypeAdvisory) => {
  const seen: string[] = [];
  const handler = createTypeDiagnosticsHandler(async (file) => {
    seen.push(file);
    return advisory;
  });
  return { handler, seen };
};

describe("type-diagnostics handler", () => {
  it("hands the model's advisory to Claude as PostToolUse context, without blocking", async () => {
    const { handler, seen } = advising({ forModel: "⚠ TYPE DIAGNOSTICS …", forOperator: null });
    expect(await handler(stdin(), [])).toEqual({ kind: "allow", postToolUseContext: "⚠ TYPE DIAGNOSTICS …" });
    expect(seen).toEqual(["/repo/src/a.ts"]);
  });

  it("carries an operator note beside the model context", async () => {
    const { handler } = advising({ forModel: "ctx", forOperator: "note" });
    expect(await handler(stdin(), [])).toEqual({ kind: "allow", postToolUseContext: "ctx", systemMessage: "note" });
  });

  it("sends an operator-only note as a systemMessage", async () => {
    const { handler } = advising({ forModel: null, forOperator: "tsc did not finish" });
    expect(await handler(stdin(), [])).toEqual({ kind: "passthrough", systemMessage: "tsc did not finish" });
  });

  it("stays silent when there is nothing to say", async () => {
    const { handler } = advising({ forModel: null, forOperator: null });
    expect(await handler(stdin(), [])).toEqual({ kind: "passthrough" });
  });

  it.each(["Write", "MultiEdit"])("covers %s", async (tool) => {
    const { handler, seen } = advising({ forModel: null, forOperator: null });
    await handler(stdin({ tool_name: tool }), []);
    expect(seen).toEqual(["/repo/src/a.ts"]);
  });

  it("ignores tools that do not edit files, and edits without a path", async () => {
    const { handler, seen } = advising({ forModel: "x", forOperator: null });
    expect(await handler(stdin({ tool_name: "Read" }), [])).toEqual({ kind: "passthrough" });
    expect(await handler(stdin({ tool_input: {} }), [])).toEqual({ kind: "passthrough" });
    expect(await handler("", [])).toEqual({ kind: "passthrough" });
    expect(seen).toEqual([]);
  });

  it("resolves a relative path against the hook's cwd", async () => {
    const { handler, seen } = advising({ forModel: null, forOperator: null });
    await handler(stdin({ cwd: "/repo", tool_input: { file_path: "src/b.ts" } }), []);
    expect(seen).toEqual(["/repo/src/b.ts"]);
  });

  it("fails open: malformed stdin or a throwing advisory never blocks the edit", async () => {
    const { handler } = advising({ forModel: null, forOperator: null });
    expect(await handler("{not json", [])).toMatchObject({ kind: "passthrough", systemMessage: expect.stringContaining("type diagnostics") });

    const throwing = createTypeDiagnosticsHandler(async () => { throw new Error("boom"); });
    expect(await throwing(stdin(), [])).toEqual({ kind: "passthrough", systemMessage: "Loom type diagnostics could not run: boom" });
  });
});

describe("hookSuccessStdout", () => {
  it("renders nothing for a bare success", () => {
    expect(hookSuccessStdout({ kind: "allow" })).toBeNull();
    expect(hookSuccessStdout({ kind: "passthrough" })).toBeNull();
  });

  it("renders the operator channel alone", () => {
    expect(JSON.parse(hookSuccessStdout({ kind: "passthrough", systemMessage: "m" })!)).toEqual({ systemMessage: "m" });
  });

  it("renders PostToolUse context in Claude Code's hookSpecificOutput shape", () => {
    expect(JSON.parse(hookSuccessStdout(postToolUseContextResult("ctx", "note"))!)).toEqual({
      systemMessage: "note",
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "ctx" },
    });
  });
});
