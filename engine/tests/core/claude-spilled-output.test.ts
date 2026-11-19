/**
 * Claude Code's spill of a large Bash result (loom#241): `tool_response.stdout`
 * keeps the first 30 000 characters and `persistedOutputPath` /
 * `persistedOutputSize` name the file holding the whole output. The shape was
 * read from a live Claude Code 2.1.x subagent transcript, where a failing
 * `helper run-tests` printed 41 799 bytes and its receipt, the last line, was
 * only in the file.
 *
 * `persistedBashOutput` reads the spill marker; `withPersistedBashOutput`
 * restores the whole output only when it is exactly what the harness reported.
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

const HEAD_CHARACTERS = 30_000;
const PATH = "/home/dev/.claude/projects/p/s/tool-results/b7mnf5mst.txt";

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The PostToolUse payload Claude Code sends for one spilled Bash output. */
function spilled(whole: string, overrides: Record<string, unknown> = {}): ClaudeToolPayload {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "bun cli.ts helper run-tests --files a.test.ts" },
    tool_response: {
      stdout: whole.slice(0, HEAD_CHARACTERS),
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      persistedOutputPath: PATH,
      persistedOutputSize: utf8Bytes(whole),
      ...overrides,
    },
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
      head: WHOLE.slice(0, HEAD_CHARACTERS),
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
    const payload = spilled(WHOLE);
    const spill = persistedBashOutput(payload);
    if (spill === null) throw new Error("fixture must spill");
    const restored = withPersistedBashOutput(payload, spill, WHOLE);
    expect(restored).not.toBeNull();
    const outcome = claudeBashOutcome(claudeToolResult(restored!));
    expect(outcome).toEqual({ kind: "exited", exit: 0, stdout: WHOLE });
    expect(WHOLE.trimEnd().split("\n").at(-1)).toBe(RECEIPT);
  });

  it("refuses a file that is not exactly the reported size", () => {
    const payload = spilled(WHOLE);
    const spill = persistedBashOutput(payload)!;
    expect(withPersistedBashOutput(payload, spill, `${WHOLE}appended\n`)).toBeNull();
    expect(withPersistedBashOutput(payload, spill, WHOLE.slice(0, -2))).toBeNull();
  });

  it("refuses a file that does not begin with the head the harness kept", () => {
    const payload = spilled(WHOLE);
    const spill = persistedBashOutput(payload)!;
    const swapped = `X${WHOLE.slice(1)}`;
    expect(utf8Bytes(swapped)).toBe(spill.bytes);
    expect(withPersistedBashOutput(payload, spill, swapped)).toBeNull();
  });

  it("counts the size in UTF-8 bytes, as Claude Code reports it", () => {
    const whole = `${"é".repeat(HEAD_CHARACTERS)}\n${RECEIPT}\n`;
    const payload = spilled(whole);
    const spill = persistedBashOutput(payload)!;
    expect(spill.bytes).toBeGreaterThan(whole.length);
    expect(withPersistedBashOutput(payload, spill, whole)).not.toBeNull();
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
          const spill = persistedBashOutput(payload)!;
          const restored = withPersistedBashOutput(payload, spill, whole);
          expect(claudeBashOutcome(claudeToolResult(restored!))).toEqual({ kind: "exited", exit: 0, stdout: whole });
          expect(withPersistedBashOutput(payload, spill, `${whole}!`)).toBeNull();
        },
      ),
    );
  });
});
