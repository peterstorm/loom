import { describe, expect, it } from "vitest";
import { messagesToClaudeJsonl, type PiMessage } from "../../pi/transcript-adapter";
import { parseBashTestOutput } from "../src/parsers/parse-bash-test-output";
import { extractTestEvidence } from "../src/handlers/subagent-stop/update-task-status";

const testRun = (output: string): PiMessage[] => [
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-test-1",
      name: "bash",
      arguments: { command: "bun test src/domain/calendar.test.ts" },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "call-test-1",
    toolName: "bash",
    content: [{ type: "text", text: output }],
  },
];

describe("Pi test-evidence transcript adapter", () => {
  it("preserves a real Bash test call/result pair for the anti-spoofing parser", () => {
    const output = parseBashTestOutput(messagesToClaudeJsonl(testRun("654 pass\n0 fail\n")));

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

    const output = parseBashTestOutput(messagesToClaudeJsonl(messages));
    expect(output).toBe("");
    expect(extractTestEvidence(output).passed).toBe(false);
  });

  it("does not pair a test command with another tool call's result", () => {
    const messages = testRun("654 pass\n0 fail\n");
    messages[1] = { ...messages[1], toolCallId: "different-call" };

    expect(parseBashTestOutput(messagesToClaudeJsonl(messages))).toBe("");
  });
});
