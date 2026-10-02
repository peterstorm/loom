import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { parseFinalPayload } from "../../../src/core/harness-capture";
import { claudeFinalPayloadCandidates, claudeSpawnPrompt } from "../../../src/handlers/subagent-stop/capture-orchestration-result";

/**
 * The shapes a Claude subagent transcript can end in, as payload capture sees
 * them. The SubagentHandback ending is the one structural exception to "only
 * the final line is read" and must not become a general fallback search.
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

  it("does not search beyond the line immediately before the acknowledgement", () => {
    const unrelated = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "between" }] } };

    expect(claudeFinalPayloadCandidates(transcript([prompt, handbackCall("toolu_1"), unrelated, handbackResult("toolu_1")])))
      .toEqual([]);
  });

  it("reports a malformed handback-call line as transcript corruption with its line number", () => {
    const path = transcript([prompt, "{broken", handbackResult("toolu_1")]);

    expect(() => claudeFinalPayloadCandidates(path)).toThrow(/invalid handback call Claude transcript JSON at line 2/);
  });

  it("yields no candidate for an acknowledgement with nothing before it", () => {
    expect(claudeFinalPayloadCandidates(transcript([handbackResult("toolu_1")]))).toEqual([]);
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
