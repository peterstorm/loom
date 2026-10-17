/**
 * The one constructor of a storable completion failure message
 * (`FailureMessage`): `parseFailureMessage` admits exactly what the at-rest
 * parser stores, and `boundedFailureMessage` fits any text into it, so a
 * message a check minted can always be parsed back.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_FAILURE_MESSAGE_LENGTH,
  boundedFailureMessage,
  parseCompletionProcessOutcome,
  parseCompletionReportOutcome,
  parseFailureMessage,
} from "../../src/core/completion-suite";

const REPORT = ".loom/completion-reports/verify.junit.xml";

describe("parseFailureMessage", () => {
  it.each<[string, unknown]>([
    ["an empty string", ""],
    ["a blank string", " \n\t "],
    ["a message one character too long", "x".repeat(MAX_FAILURE_MESSAGE_LENGTH + 1)],
    ["a number", 7],
    ["null", null],
  ])("refuses %s", (_label, raw) => {
    expect(parseFailureMessage(raw)).toBeNull();
  });

  it("admits a non-blank message up to the bound, unchanged", () => {
    expect(parseFailureMessage("spawn vitest ENOENT")).toBe("spawn vitest ENOENT");
    const longest = "x".repeat(MAX_FAILURE_MESSAGE_LENGTH);
    expect(parseFailureMessage(longest)).toBe(longest);
  });
});

describe("the at-rest parser's two message arms use the one constructor", () => {
  it.each<[string, string, boolean]>([
    ["a valid message", "EACCES: permission denied", true],
    ["a blank message", "   ", false],
    ["an over-length message", "x".repeat(MAX_FAILURE_MESSAGE_LENGTH + 1), false],
  ])("an unreadable report with %s is admitted exactly when the message is storable", (_label, message, admitted) => {
    const parsed = parseCompletionReportOutcome({ kind: "unreadable", path: REPORT, message });
    expect(parsed.ok).toBe(admitted);
    if (parsed.ok) expect(parsed.value).toEqual({ kind: "unreadable", path: REPORT, message });
    else expect(parsed.error.errors.join("; ")).toContain(`at most ${MAX_FAILURE_MESSAGE_LENGTH} characters`);
  });

  it("a spawn failure with a blank or over-length message is refused", () => {
    for (const message of ["", "x".repeat(MAX_FAILURE_MESSAGE_LENGTH + 1)]) {
      expect(parseCompletionProcessOutcome({ kind: "spawn-failed", message }).ok).toBe(false);
    }
  });
});

describe("boundedFailureMessage", () => {
  it("keeps the first MAX_FAILURE_MESSAGE_LENGTH characters of a long message", () => {
    const message = boundedFailureMessage(`LINT ENGINE ERROR: ${"y".repeat(10_000)}`, "fallback");
    expect(message).toHaveLength(MAX_FAILURE_MESSAGE_LENGTH);
    expect(message.startsWith("LINT ENGINE ERROR: ")).toBe(true);
  });

  it("uses the fallback for a blank message, and a fixed message when the fallback is blank too", () => {
    expect(boundedFailureMessage("   ", "the lint returned nothing")).toBe("the lint returned nothing");
    expect(boundedFailureMessage("", "")).toBe("completion check failed without a message");
  });

  it("always yields a message the at-rest parser stores, whatever the text and fallback", () => {
    fc.assert(fc.property(fc.string({ maxLength: 6_000 }), fc.string({ maxLength: 6_000 }), (text, fallback) => {
      const message = boundedFailureMessage(text, fallback);
      expect(parseFailureMessage(message)).toBe(message);
      expect(parseCompletionProcessOutcome({ kind: "spawn-failed", message })).toEqual({
        ok: true,
        value: { kind: "spawn-failed", message },
      });
    }));
  });
});
