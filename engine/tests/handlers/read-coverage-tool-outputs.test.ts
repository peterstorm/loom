import { describe, expect, it } from "vitest";
import { claudeToolOutputs, parseClaudeTranscript } from "../../src/core/claude-transcript-projection";
import { piToolOutputs } from "../../../pi/review-capture";

/**
 * The harness half of read coverage (ADR-0022): each adapter projects exactly
 * the tool results its transcript records as delivered, so capture can credit
 * only what the Agent actually received.
 */
const line = (message: unknown) => JSON.stringify({ message });

describe("Claude tool outputs", () => {
  it("projects every successful tool result in order, string or text-block content", () => {
    const lines = [
      line({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "read" } }] }),
      line({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "page one" }] }),
      line({ role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "page" }, { type: "image" }, { type: "text", text: "two" }] }] }),
      line({ role: "user", content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "denied" }] }),
      line({ role: "assistant", content: [{ type: "text", text: "final" }] }),
      "not json",
      line({ role: "user", content: "plain prompt" }),
    ];
    expect(claudeToolOutputs(parseClaudeTranscript(lines))).toEqual(["page one", "page\ntwo"]);
  });

  it("projects nothing from a transcript without tool results", () => {
    expect(claudeToolOutputs(parseClaudeTranscript([line({ role: "assistant", content: [{ type: "text", text: "I read it all." }] })]))).toEqual([]);
  });
});

describe("Pi tool outputs", () => {
  it("projects every successful toolResult's text in order", () => {
    expect(piToolOutputs([
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "page one" }] },
      { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: true, content: [{ type: "text", text: "failed" }] },
      { role: "toolResult", toolCallId: "c3", toolName: "bash", isError: false, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "final" }] },
    ])).toEqual(["page one", "a\nb"]);
  });

  it("withholds only a malformed message's own text, never the rest", () => {
    expect(piToolOutputs([{ role: "toolResult", content: "not blocks" }, { role: "assistant", content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "still credited" }] }])).toEqual(["still credited"]);
    expect(piToolOutputs(undefined)).toEqual([]);
  });
});
