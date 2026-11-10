/**
 * `detectFormat`: only a first line that is a JSON object with
 * `type: "session"` and a present (not undefined) `version` is a Pi session header; every
 * other first line — malformed JSON, JSON that is not an object, an object
 * missing either field — is a Claude Code transcript. A first line that is
 * not JSON is the ordinary Claude case, not an error.
 */
import { describe, expect, it } from "vitest";
import { detectFormat } from "../../src/parsers/types";

const PI_HEADER = JSON.stringify({ type: "session", version: 3, id: "s-1" });

describe("detectFormat", () => {
  it.each([
    ["a Pi session header", PI_HEADER, "pi"],
    ["a Pi session header with a version of 0", JSON.stringify({ type: "session", version: 0 }), "pi"],
    ["a Pi session header followed by entries", `${PI_HEADER}\n{"type":"message"}`, "pi"],
    ["a session header without a version", JSON.stringify({ type: "session" }), "claude"],
    // Only an ABSENT version disqualifies a session header; any present value counts.
    ["a session header with a null version", JSON.stringify({ type: "session", version: null }), "pi"],
    ["a non-session object", JSON.stringify({ type: "user", version: 1 }), "claude"],
    ["a Claude transcript line", JSON.stringify({ type: "assistant", message: { content: [] } }), "claude"],
    ["malformed JSON", "{\"type\":\"session\",", "claude"],
    ["the empty string", "", "claude"],
    ["JSON null", "null", "claude"],
    ["a JSON array", JSON.stringify([{ type: "session", version: 1 }]), "claude"],
    ["a bare number", "42", "claude"],
    ["a JSON string", JSON.stringify("session"), "claude"],
    ["a Pi header that is not on the first line", `{"type":"user"}\n${PI_HEADER}`, "claude"],
  ] as const)("%s", (_label, content, format) => {
    expect(detectFormat(content)).toBe(format);
  });
});
