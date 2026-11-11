/**
 * The positive-integer predicate: the one check every `PositiveInt` has passed.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isPositiveInt } from "../../src/linter/positive-int";

describe("isPositiveInt", () => {
  it("accepts every whole number from one up", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (value) => {
      expect(isPositiveInt(value)).toBe(true);
    }));
  });

  it("refuses zero and every negative integer", () => {
    fc.assert(fc.property(fc.integer({ max: 0 }), (value) => {
      expect(isPositiveInt(value)).toBe(false);
    }));
  });

  it("refuses every number that is not whole", () => {
    fc.assert(fc.property(fc.double().filter((value) => !Number.isInteger(value)), (value) => {
      expect(isPositiveInt(value)).toBe(false);
    }));
  });

  it.each([["a numeric string", "8"], ["null", null], ["undefined", undefined], ["true", true], ["an array", [8]], ["a bigint", 8n]])(
    "refuses %s: only a number can be one",
    (_label, raw) => {
      expect(isPositiveInt(raw)).toBe(false);
    },
  );
});
