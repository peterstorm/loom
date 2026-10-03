import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { parseFinalPayload } from "../../../src/core/harness-capture";
import { claudeFinalPayloadCandidates, claudeSpawnPrompt } from "../../../src/handlers/subagent-stop/capture-orchestration-result";

/**
 * The shapes a Claude subagent transcript can end in, as payload capture sees
 * them. Only the FINAL TURN is read: its trailing tool_result lines and the one
 * assistant message they answer (possibly split over several lines sharing a
 * message id). It must never become a general fallback search of earlier turns.
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const PAYLOAD = "{\"schemaVersion\":2,\"kind\":\"standalone-review\",\"findings\":[]}";
const prompt = { type: "user", message: { role: "user", content: "LOOM_REQUEST_ID: request:alpha:1\nReview." } };
const handbackCall = (id: string, input: Record<string, unknown> = { message: PAYLOAD }, name = "SubagentHandback") => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const handbackResult = (toolUseId: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ tool_use_id: toolUseId, type: "tool_result", content: [{ type: "text", text: "{\"success\":true}" }], ...extra }],
  },
});

function transcript(lines: readonly (object | string)[]): string {
  const root = canonicalTempDir("loom-claude-final-payload-");
  roots.push(root);
  const path = join(root, "agent.jsonl");
  writeFileSync(path, lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
  return path;
}

describe("claudeFinalPayloadCandidates — SubagentHandback ending", () => {
  it("accepts the handback call's message as the single candidate", () => {
    const candidates = claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), handbackResult("toolu_1")]));

    expect(candidates).toEqual([{ origin: "transcript.line[1].handback", text: PAYLOAD }]);
    const parsed = parseFinalPayload(candidates);
    expect(parsed.ok && parsed.value.text).toBe(PAYLOAD);
  });

  it("accepts the shape through the bounded reader, skipping blank lines between the pair", () => {
    const candidates = claudeFinalPayloadCandidates(
      transcript([prompt, handbackCall("toolu_1"), "", "   ", handbackResult("toolu_1")]), 16_777_216);

    expect(candidates).toEqual([{ origin: "transcript.line[1].handback", text: PAYLOAD }]);
  });

  it("ignores assistant text beside the handback call — the call is the delivery", () => {
    const call = handbackCall("toolu_1");
    const withText = { ...call, message: { ...call.message, content: [{ type: "text", text: "narration" }, ...call.message.content] } };

    expect(claudeFinalPayloadCandidates(transcript([prompt, withText, handbackResult("toolu_1")])))
      .toEqual([{ origin: "transcript.line[1].handback", text: PAYLOAD }]);
  });

  it("yields no candidate when the handback reported failure", () => {
    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), handbackResult("toolu_1", { is_error: true })])))
      .toEqual([]);
  });

  it("yields no candidate when the tool_result answers a different tool_use id", () => {
    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), handbackResult("toolu_other")])))
      .toEqual([]);
  });

  it("yields no candidate for a different tool's acknowledgement", () => {
    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1", { message: PAYLOAD }, "Bash"), handbackResult("toolu_1")])))
      .toEqual([]);
  });

  it("yields no candidate when the handback message is not a string", () => {
    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1", { message: { nested: true } }), handbackResult("toolu_1")])))
      .toEqual([]);
  });

  it("yields no candidate when the final user message carries more than one block", () => {
    const result = handbackResult("toolu_1");
    const twoBlocks = { ...result, message: { ...result.message, content: [...result.message.content, { type: "text", text: "extra" }] } };

    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), twoBlocks]))).toEqual([]);
  });

  it("does not search past an unrelated assistant line before the acknowledgement", () => {
    const unrelated = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "between" }] } };

    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), unrelated, handbackResult("toolu_1")])))
      .toEqual([]);
  });

  it("reports a malformed line inside the final turn as transcript corruption with its line number", () => {
    const path = transcript([prompt, "{broken", handbackResult("toolu_1")]);

    expect(() => claudeFinalPayloadCandidates(path)).toThrow(/invalid final Claude transcript JSON at line 2/);
  });

  it("yields no candidate for an acknowledgement with nothing before it", () => {
    expect(claudeFinalPayloadCandidates(transcript([handbackResult("toolu_1")]))).toEqual([]);
  });
});

describe("claudeFinalPayloadCandidates — handback within a multi-call final message", () => {
  // Claude writes a message with parallel calls as one line per block, all
  // sharing the message id, then one tool_result line per call.
  const line = (id: string, block: Record<string, unknown>) => ({ type: "assistant", message: { id, role: "assistant", content: [block] } });
  const handback = (toolId: string, message: unknown = PAYLOAD) => ({ type: "tool_use", id: toolId, name: "SubagentHandback", input: { message } });
  const bash = (toolId: string) => ({ type: "tool_use", id: toolId, name: "Bash", input: { command: "true" } });
  const attachment = { type: "attachment", attachment: { type: "hook" } };

  it("accepts a handback made in parallel with another call, past a trailing attachment line", () => {
    const candidates = claudeFinalPayloadCandidates(transcript([
      prompt,
      line("msg_1", { type: "text", text: "narration" }),
      line("msg_1", bash("toolu_bash")),
      line("msg_1", handback("toolu_hb")),
      handbackResult("toolu_bash"),
      handbackResult("toolu_hb"),
      attachment,
    ]));

    expect(candidates).toEqual([{ origin: "transcript.line[3].handback", text: PAYLOAD }]);
  });

  it("delivers nothing when the parallel handback itself failed, even though its sibling call succeeded", () => {
    expect(claudeFinalPayloadCandidates(transcript([
      prompt, line("msg_1", bash("toolu_bash")), line("msg_1", handback("toolu_hb")),
      handbackResult("toolu_bash"), handbackResult("toolu_hb", { is_error: true }),
    ]))).toEqual([]);
  });

  it("delivers nothing for a handback whose result never arrived", () => {
    expect(claudeFinalPayloadCandidates(transcript([
      prompt, line("msg_1", bash("toolu_bash")), line("msg_1", handback("toolu_hb")), handbackResult("toolu_bash"),
    ]))).toEqual([]);
  });

  it("reports two delivered handbacks as two candidates — ambiguity is the payload rule's call", () => {
    const candidates = claudeFinalPayloadCandidates(transcript([
      prompt, line("msg_1", handback("toolu_a")), line("msg_1", handback("toolu_b", "{}")),
      handbackResult("toolu_a"), handbackResult("toolu_b"),
    ]));

    expect(candidates).toHaveLength(2);
    expect(parseFinalPayload(candidates).ok).toBe(false);
  });

  it("never reaches a handback in an EARLIER message", () => {
    expect(claudeFinalPayloadCandidates(transcript([
      prompt,
      line("msg_1", handback("toolu_old")), handbackResult("toolu_old"),
      line("msg_2", bash("toolu_bash")), handbackResult("toolu_bash"),
    ]))).toEqual([]);
  });

  it("ignores a torn line in an earlier turn — it is not this capture's evidence", () => {
    // The walk stops at the first line of a different message, so it never
    // parses past it. (A torn line directly adjacent is still read, and fails.)
    expect(claudeFinalPayloadCandidates(transcript([
      prompt, "{torn", line("msg_0", { type: "text", text: "earlier" }),
      line("msg_1", handback("toolu_hb")), handbackResult("toolu_hb"),
    ]))).toEqual([{ origin: "transcript.line[3].handback", text: PAYLOAD }]);
  });
});

describe("claudeFinalPayloadCandidates — legacy assistant-text ending", () => {
  it("still hands over every text block of a final assistant message", () => {
    const final = { type: "assistant", message: { role: "assistant", content: [
      { type: "text", text: "first" }, { type: "tool_use", id: "x", name: "Read", input: {} }, { type: "text", text: "second" },
    ] } };

    expect(claudeFinalPayloadCandidates(transcript([prompt, final]))).toEqual([
      { origin: "transcript.line[1].block[0]", text: "first" },
      { origin: "transcript.line[1].block[1]", text: "second" },
    ]);
  });

  it("still yields no candidate for a final non-handback user message", () => {
    expect(claudeFinalPayloadCandidates(transcript([prompt, { type: "user", message: { role: "user", content: "later" } }]))).toEqual([]);
  });

  const attachment = { type: "attachment", attachment: { type: "hook" } };
  const textLine = (id: string, text: string) => ({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] } });

  it("reads a legacy text ending past a trailing non-conversation line", () => {
    expect(claudeFinalPayloadCandidates(transcript([prompt, textLine("msg_1", "final"), attachment])))
      .toEqual([{ origin: "transcript.line[1].block[0]", text: "final" }]);
  });

  it("yields no candidate for user endings: plain text, or a tool_result mixed with text", () => {
    const userText = { type: "user", message: { role: "user", content: [{ type: "text", text: "later" }] } };
    const mixed = { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" }, { type: "text", text: "and more" },
    ] } };

    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), userText]))).toEqual([]);
    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), mixed]))).toEqual([]);
  });

  it("hands over only the LAST line's text when a legacy message spans lines (unchanged legacy contract)", () => {
    expect(claudeFinalPayloadCandidates(transcript([prompt, textLine("msg_1", "first"), textLine("msg_1", "second")])))
      .toEqual([{ origin: "transcript.line[2].block[0]", text: "second" }]);
  });
});

describe("claudeSpawnPrompt", () => {
  it("reads the opening user message as the spawn prompt", () => {
    expect(claudeSpawnPrompt(transcript([prompt, handbackCall("toolu_1"), handbackResult("toolu_1")])))
      .toEqual({ ok: true, value: "LOOM_REQUEST_ID: request:alpha:1\nReview." });
  });

  it("joins text blocks of an array-form opening message", () => {
    const blocks = { type: "user", message: { role: "user", content: [{ type: "text", text: "LOOM_REQUEST_ID: request:a:1" }, { type: "text", text: "Go." }] } };

    expect(claudeSpawnPrompt(transcript([blocks]))).toEqual({ ok: true, value: "LOOM_REQUEST_ID: request:a:1\nGo." });
  });

  it("has no prompt when the transcript opens with something else", () => {
    expect(claudeSpawnPrompt(transcript([handbackCall("toolu_1")]))).toEqual({ ok: true, value: null });
  });

  it("reports an unreadable transcript as a failure, never an absent prompt", () => {
    expect(claudeSpawnPrompt(join(canonicalTempDir("loom-claude-missing-"), "absent.jsonl")))
      .toMatchObject({ ok: false, message: expect.stringContaining("cannot read Claude transcript") });
  });

  it("reports a malformed opening line as corruption", () => {
    expect(claudeSpawnPrompt(transcript(["{broken"])))
      .toMatchObject({ ok: false, message: expect.stringContaining("invalid opening Claude transcript JSON at line 1") });
  });
});
