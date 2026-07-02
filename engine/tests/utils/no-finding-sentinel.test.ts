import { describe, it, expect } from "vitest";
import { isNoFindingSentinel, dropNoFindingSentinels } from "../../src/utils/no-finding-sentinel";

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

  it("returns false for the empty string (handled separately by dropNoFindingSentinels)", () => {
    expect(isNoFindingSentinel("")).toBe(false);
  });
});

describe("dropNoFindingSentinels", () => {
  it("drops empty strings and sentinels, preserving real findings", () => {
    expect(dropNoFindingSentinels(["", "none", "real finding"])).toEqual(["real finding"]);
  });

  it("drops parenthesized + explanatory sentinels", () => {
    expect(
      dropNoFindingSentinels(["(none) — prior critical fixed", "SQL injection in db.ts"])
    ).toEqual(["SQL injection in db.ts"]);
  });

  it("preserves a real finding that starts with 'none'", () => {
    expect(dropNoFindingSentinels(["none of the error paths are handled"])).toEqual([
      "none of the error paths are handled",
    ]);
  });

  it("returns an empty array when every entry is a sentinel or empty", () => {
    expect(dropNoFindingSentinels(["none", "", "N/A", "  nil  "])).toEqual([]);
  });
});
