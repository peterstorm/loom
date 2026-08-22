import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  confirmUiResponse,
  MAX_INTERACTIVE_RPC_FRAME_BYTES,
  parsePiRpcLine,
  StrictLfJsonlDecoder,
  valueUiResponse,
} from "../../../pi/interactive-rpc";

describe("Pi interactive RPC parser", () => {
  it("parses each supported dialog into a closed request variant", () => {
    expect(parsePiRpcLine(JSON.stringify({
      type: "extension_ui_request",
      id: "q-1",
      method: "select",
      title: "Pick",
      options: ["A", "B"],
      timeout: 1000,
    }))).toEqual({
      ok: true,
      value: {
        kind: "extension-ui",
        request: { kind: "select", id: "q-1", title: "Pick", options: ["A", "B"], timeout: 1000 },
      },
    });
    expect(parsePiRpcLine(JSON.stringify({
      type: "extension_ui_request", id: "q-2", method: "confirm", title: "Continue?", message: "Proceed",
    }))).toMatchObject({ ok: true, value: { request: { kind: "confirm", id: "q-2" } } });
    expect(parsePiRpcLine(JSON.stringify({
      type: "extension_ui_request", id: "q-3", method: "input", title: "Name", placeholder: "value",
    }))).toMatchObject({ ok: true, value: { request: { kind: "input", id: "q-3" } } });
    expect(parsePiRpcLine(JSON.stringify({
      type: "extension_ui_request", id: "q-4", method: "editor", title: "Edit", prefill: "a\nb",
    }))).toMatchObject({ ok: true, value: { request: { kind: "editor", id: "q-4", prefill: "a\nb" } } });
  });

  it("fails closed on malformed, unknown, or incomplete UI requests", () => {
    for (const line of [
      "{broken",
      JSON.stringify({ type: "extension_ui_request", id: "q", method: "select", title: "Pick", options: [] }),
      JSON.stringify({ type: "extension_ui_request", id: "q", method: "custom", title: "No" }),
      JSON.stringify({ type: "extension_ui_request", id: "q", method: "confirm", title: "No message" }),
    ]) {
      expect(parsePiRpcLine(line).ok).toBe(false);
    }
  });

  it("builds method-specific correlated responses", () => {
    expect(valueUiResponse("select-1", "A")).toEqual({ type: "extension_ui_response", id: "select-1", value: "A" });
    expect(confirmUiResponse("confirm-1", false)).toEqual({
      type: "extension_ui_response", id: "confirm-1", confirmed: false,
    });
  });
});

describe("strict LF JSONL framing", () => {
  it("does not split U+2028 or U+2029 inside JSON strings", () => {
    const decoder = new StrictLfJsonlDecoder();
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: `a\u2028b\u2029c` } });
    const decoded = decoder.push(Buffer.from(`${line}\n`, "utf8"));
    expect(decoded).toEqual({ ok: true, value: [line] });
    expect(decoder.finish()).toEqual({ ok: true, value: [] });
  });

  it("fails closed on an unterminated final frame", () => {
    const decoder = new StrictLfJsonlDecoder();
    expect(decoder.push(Buffer.from('{"type":"agent_settled"}')).ok).toBe(true);
    expect(decoder.finish()).toEqual({ ok: false, error: "Pi RPC stream ended with an unterminated frame" });
  });

  it("rejects an oversized unterminated remainder after a complete frame", () => {
    const decoder = new StrictLfJsonlDecoder();
    const decoded = decoder.push(Buffer.from(
      `${JSON.stringify({ type: "agent_settled" })}\n${"x".repeat(MAX_INTERACTIVE_RPC_FRAME_BYTES + 1)}`,
      "utf8",
    ));

    expect(decoded).toEqual({
      ok: false,
      error: `Pi RPC frame exceeds ${MAX_INTERACTIVE_RPC_FRAME_BYTES} bytes before LF delimiter`,
    });
  });

  it("reassembles arbitrary UTF-8 byte chunking without changing records", () => {
    fc.assert(fc.property(
      fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
      fc.array(fc.integer({ min: 1, max: 19 }), { minLength: 1, maxLength: 30 }),
      (values, chunkSizes) => {
        const lines = values.map((value, index) => JSON.stringify({ type: "event", index, value }));
        const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
        const decoder = new StrictLfJsonlDecoder();
        const observed: string[] = [];
        let offset = 0;
        let chunkIndex = 0;
        while (offset < bytes.length) {
          const size = chunkSizes[chunkIndex % chunkSizes.length]!;
          const decoded = decoder.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
          expect(decoded.ok).toBe(true);
          if (decoded.ok) observed.push(...decoded.value);
          offset += size;
          chunkIndex += 1;
        }
        expect(decoder.finish()).toEqual({ ok: true, value: [] });
        expect(observed).toEqual(lines);
      },
    ));
  });
});
