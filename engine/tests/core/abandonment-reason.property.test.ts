import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_ABANDONMENT_REASON, parseAbandonmentReason } from "../../src/core/abandonment-reason";

/** Text that may carry surrounding whitespace and may cross the bound. */
const operatorText = fc.tuple(
  fc.constantFrom("", " ", "\t", "\n  "),
  fc.string({ maxLength: MAX_ABANDONMENT_REASON + 8 }),
  fc.constantFrom("", " ", "\r\n", "  \t"),
).map(([before, body, after]) => `${before}${body}${after}`);

describe("parseAbandonmentReason", () => {
  it("admits exactly the trimmed, non-blank text within the bound", () => {
    fc.assert(fc.property(operatorText, (raw) => {
      const trimmed = raw.trim();
      const parsed = parseAbandonmentReason(raw);
      expect(parsed.ok).toBe(trimmed !== "" && trimmed.length <= MAX_ABANDONMENT_REASON);
    }));
  });

  it("mints a value that is its own trimmed form and parses back to itself", () => {
    fc.assert(fc.property(operatorText, (raw) => {
      const parsed = parseAbandonmentReason(raw);
      if (!parsed.ok) return;
      expect(parsed.value.trim()).toBe(parsed.value);
      expect(parsed.value.length).toBeGreaterThan(0);
      expect(parsed.value.length).toBeLessThanOrEqual(MAX_ABANDONMENT_REASON);
      expect(parseAbandonmentReason(parsed.value)).toEqual(parsed);
    }));
  });
});
