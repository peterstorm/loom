import { describe, expect, it } from "vitest";
import { messagesToClaudeJsonl, piStructuredTestResult, type PiMessage } from "../../pi/transcript-adapter";
import { parseBashTestOutput } from "../src/parsers/parse-bash-test-output";
import { extractTestEvidence } from "../src/handlers/subagent-stop/update-task-status";

const testRun = (output: string, command = "bun test src/domain/calendar.test.ts"): PiMessage[] => [
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-test-1",
      name: "bash",
      arguments: { command },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "call-test-1",
    toolName: "bash",
    content: [{ type: "text", text: output }],
  },
];

function claudeJsonl(messages: readonly PiMessage[]): string {
  const adapted = messagesToClaudeJsonl(messages);
  expect(adapted.ok).toBe(true);
  if (!adapted.ok) throw new Error(adapted.errors.join("; "));
  return adapted.value;
}

describe("Pi test-evidence transcript adapter", () => {
  it("preserves a real Bash test call/result pair for the anti-spoofing parser", () => {
    const output = parseBashTestOutput(claudeJsonl(testRun("654 pass\n0 fail\n")));

    expect(output).toContain("654 pass");
    expect(extractTestEvidence(output)).toEqual({
      passed: true,
      evidence: "bun: 654 pass",
    });
  });

  it("does not turn assistant prose containing pass markers into test evidence", () => {
    const messages: PiMessage[] = [{
      role: "assistant",
      content: [{ type: "text", text: "654 pass, 0 fail" }],
    }];

    const output = parseBashTestOutput(claudeJsonl(messages));
    expect(output).toBe("");
    expect(extractTestEvidence(output).passed).toBe(false);
  });

  it("does not pair a test command with another tool call's result", () => {
    const messages = testRun("654 pass\n0 fail\n");
    messages[1] = { ...messages[1], toolCallId: "different-call" };

    expect(parseBashTestOutput(claudeJsonl(messages))).toBe("");
  });

  it("rejects print-only commands that mention a test runner in data or comments", () => {
    for (const command of [
      "printf 'bun test\\n654 pass\\n'",
      "printf '654 pass\\n' # bun test",
      "echo \"npm test: 5 passing\"",
    ]) {
      expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", command))).toEqual({ ok: true, value: null });
    }
  });

  it("keeps an errored Bash tool result failing even when its text looks like a pass", () => {
    const messages = testRun("654 pass\n0 fail\n");
    messages[1] = { ...messages[1], isError: true };

    expect(piStructuredTestResult(messages)).toEqual({
      ok: true,
      value: { passed: false, evidence: "bun: 654 pass" },
    });
  });

  it("requires the classified test segment to own the Bash result", () => {
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "bun test || true"))).toEqual({ ok: true, value: null });
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "bun test | tee out.log"))).toEqual({ ok: true, value: null });
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "bun test &"))).toEqual({ ok: true, value: null });
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "cd engine && bun test"))).toEqual({
      ok: true,
      value: { passed: true, evidence: "bun: 654 pass" },
    });
  });

  it.each([
    ["missing call id", [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }] }]],
    ["missing tool name", [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", arguments: { command: "bun test" } }] }]],
    ["missing Bash command", [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }]],
    ["missing result id", [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] }]],
    ["missing result name", [{ role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }]],
  ] as const)("rejects malformed tool evidence: %s", (_label, rawMessages) => {
    const messages = rawMessages as unknown as readonly PiMessage[];
    expect(messagesToClaudeJsonl(messages)).toMatchObject({ ok: false, errors: [expect.any(String)] });
    expect(piStructuredTestResult(messages)).toMatchObject({ ok: false, errors: [expect.any(String)] });
  });
});
