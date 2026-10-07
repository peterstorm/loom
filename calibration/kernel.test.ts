import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nonEmpty } from "./kernel";

describe("NonEmpty constructor", () => {
  it("proves a list non-empty, or returns null for an empty one", () => {
    expect(nonEmpty([])).toBeNull();
    expect(nonEmpty([1, 2])).toEqual([1, 2]);
  });

  it("keeps every item in order and freezes the proof (property)", () => {
    fc.assert(fc.property(fc.array(fc.integer(), { minLength: 1 }), (values) => {
      const proven = nonEmpty(values);
      expect(proven).toEqual(values);
      expect(Object.isFrozen(proven)).toBe(true);
    }));
  });
});
