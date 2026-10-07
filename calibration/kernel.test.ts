import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { including, nonEmpty } from "./kernel";

describe("NonEmpty constructors", () => {
  it("proves a list non-empty, or returns null for an empty one", () => {
    expect(nonEmpty([])).toBeNull();
    expect(nonEmpty([1, 2])).toEqual([1, 2]);
  });

  it("inserts one item between two lists, keeping both orders (property)", () => {
    fc.assert(fc.property(fc.array(fc.integer()), fc.integer(), fc.array(fc.integer()), (before, item, after) => {
      const joined = including(before, item, after);
      expect(joined).toEqual([...before, item, ...after]);
      expect(Object.isFrozen(joined)).toBe(true);
    }));
  });
});
