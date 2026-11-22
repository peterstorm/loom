import { describe, it, expect } from "vitest";
import { isNoFindingSentinel } from "../../src/utils/no-finding-sentinel";

describe("isNoFindingSentinel", () => {
  const sentinels = [
    "none",
    "None",
    "(none)",
    "(none) — the prior critical is fixed",
    "none — all paths covered",
    "none.",
    "N/A",
    "n/a",
    "nil",
    "null",
    "  none  ",
  ];

  for (const s of sentinels) {
    it(`treats ${JSON.stringify(s)} as a sentinel`, () => {
      expect(isNoFindingSentinel(s)).toBe(true);
    });
  }

  const realFindings = [
    "none of the callers check the Result",
    "nonexistent handler for X",
    "errors.ts:201 — 429 maps to infra-unreachable",
  ];

  for (const f of realFindings) {
    it(`treats ${JSON.stringify(f)} as a real finding`, () => {
      expect(isNoFindingSentinel(f)).toBe(false);
    });
  }

  it("returns false for the empty string (callers drop empty text before asking)", () => {
    expect(isNoFindingSentinel("")).toBe(false);
  });
});
