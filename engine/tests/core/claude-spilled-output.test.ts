/**
 * Claude Code's spill of a large Bash result (loom#241): `tool_response.stdout`
 * keeps the first 30 000 characters and `persistedOutputPath` /
 * `persistedOutputSize` name the file holding the whole output. A failing
 * `helper run-tests` prints its receipt as the last line, so for a long run
 * the receipt is only in that file.
 *
 * `persistedBashOutput` reads the spill marker; `withPersistedBashOutput`
 * restores the whole output only when it is exactly what the payload's own
 * spill reported.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  claudeBashOutcome,
  claudeToolResult,
  persistedBashOutput,
  withPersistedBashOutput,
  type ClaudeToolPayload,
} from "../../src/core/harness-tool-call";
import { SPILL_HEAD_CHARACTERS, spilledBashResponse, utf8Bytes } from "../fixtures/claude-spilled-payload";

const PATH = "/home/dev/.claude/projects/p/s/tool-results/b7mnf5mst.txt";

/** The PostToolUse payload Claude Code sends for one spilled Bash output. */
function spilled(whole: string, overrides: Readonly<Record<string, unknown>> = {}): ClaudeToolPayload {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "bun cli.ts helper run-tests --files a.test.ts" },
    tool_response: spilledBashResponse(whole, PATH, overrides),
    cwd: "/repo",
  };
}

const RECEIPT = 'LOOM_TEST_RUN_RECEIPT {"schemaVersion":1}';
const WHOLE = `${"[ERROR] cannot find symbol\n".repeat(1_600)}${RECEIPT}\n`;

describe("persistedBashOutput — the spill marker", () => {
  it("reads the path, the byte size and the head Claude Code kept", () => {
    expect(persistedBashOutput(spilled(WHOLE))).toEqual({
      path: PATH,
      bytes: utf8Bytes(WHOLE),
      head: WHOLE.slice(0, SPILL_HEAD_CHARACTERS),
    });
  });

  it("is null for inline output, a failure event, another tool, or a malformed marker", () => {
    const inline: ClaudeToolPayload = { tool_name: "Bash", tool_response: { stdout: "ok", interrupted: false }, cwd: "/r" };
    expect(persistedBashOutput(inline)).toBeNull();
    expect(persistedBashOutput({ ...spilled(WHOLE), hook_event_name: "PostToolUseFailure" })).toBeNull();
    expect(persistedBashOutput({ ...spilled(WHOLE), tool_name: "Read" })).toBeNull();
    expect(persistedBashOutput({ ...spilled(WHOLE), tool_name: "constructor" })).toBeNull();
    expect(persistedBashOutput(spilled(WHOLE, { persistedOutputPath: "" }))).toBeNull();
    expect(persistedBashOutput(spilled(WHOLE, { persistedOutputSize: "41799" }))).toBeNull();
    expect(persistedBashOutput(spilled(WHOLE, { persistedOutputSize: 0 }))).toBeNull();
    expect(persistedBashOutput(spilled(WHOLE, { persistedOutputSize: 1.5 }))).toBeNull();
    expect(persistedBashOutput(spilled(WHOLE, { stdout: undefined }))).toBeNull();
  });
});

describe("withPersistedBashOutput — restoring the whole output", () => {
  it("replaces the head with the whole output, so the receipt is the last line again", () => {
    const restored = withPersistedBashOutput(spilled(WHOLE), WHOLE);
    expect(restored).not.toBeNull();
    expect(claudeBashOutcome(claudeToolResult(restored!))).toEqual({ kind: "exited", exit: 0, stdout: WHOLE });
    expect(WHOLE.trimEnd().split("\n").at(-1)).toBe(RECEIPT);
  });

  it("refuses a payload that spilled nothing", () => {
    const inline: ClaudeToolPayload = { tool_name: "Bash", tool_response: { stdout: "ok", interrupted: false }, cwd: "/r" };
    expect(withPersistedBashOutput(inline, "ok")).toBeNull();
  });

  it("refuses a file that is not exactly the reported size", () => {
    const payload = spilled(WHOLE);
    expect(withPersistedBashOutput(payload, `${WHOLE}appended\n`)).toBeNull();
    expect(withPersistedBashOutput(payload, WHOLE.slice(0, -2))).toBeNull();
  });

  it("refuses a file that does not begin with the head the harness kept", () => {
    const swapped = `X${WHOLE.slice(1)}`;
    expect(utf8Bytes(swapped)).toBe(utf8Bytes(WHOLE));
    expect(withPersistedBashOutput(spilled(WHOLE), swapped)).toBeNull();
  });

  it("refuses another call's output of the same size, because the spill comes from the payload restored", () => {
    const other = `${"[ERROR] different log line\n".repeat(1_600)}${RECEIPT}\n`.slice(0, WHOLE.length);
    expect(withPersistedBashOutput(spilled(WHOLE), other)).toBeNull();
  });

  it("counts the size in UTF-8 bytes, as Claude Code reports it", () => {
    const whole = `${"é".repeat(SPILL_HEAD_CHARACTERS)}\n${RECEIPT}\n`;
    const payload = spilled(whole);
    expect(persistedBashOutput(payload)!.bytes).toBeGreaterThan(whole.length);
    expect(withPersistedBashOutput(payload, whole)).not.toBeNull();
  });

  it("restores exactly the whole output for any spilled text, and nothing that differs from it", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (body, tail) => {
          const whole = `${body}${tail}`;
          const payload: ClaudeToolPayload = {
            tool_name: "Bash",
            tool_response: { stdout: body, interrupted: false, persistedOutputPath: PATH, persistedOutputSize: utf8Bytes(whole) },
            cwd: "/r",
          };
          const restored = withPersistedBashOutput(payload, whole);
          expect(claudeBashOutcome(claudeToolResult(restored!))).toEqual({ kind: "exited", exit: 0, stdout: whole });
          expect(withPersistedBashOutput(payload, `${whole}!`)).toBeNull();
        },
      ),
    );
  });
});
