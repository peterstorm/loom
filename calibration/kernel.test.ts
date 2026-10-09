import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { errorMessage, nonEmpty } from "./kernel";

describe("errorMessage (the one rendering of a caught value)", () => {
  it("reads an Error's own message and renders anything else as text", () => {
    expect(errorMessage(new Error("fetch exploded"))).toBe("fetch exploded");
    expect(errorMessage("not even an Error")).toBe("not even an Error");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("is total: a value String() cannot render is named by its type, never rethrown", () => {
    const throwingToString = { toString: () => { throw new Error("no text for you"); } };
    const hostile = new Proxy({}, { get: () => { throw new Error("trap"); }, getPrototypeOf: () => { throw new Error("trap"); } });
    const lyingError = Object.defineProperty(new Error("hidden"), "message", { get: () => { throw new Error("no message"); } });
    expect(errorMessage(Object.create(null))).toBe("an unprintable thrown object");
    expect(errorMessage(throwingToString)).toBe("an unprintable thrown object");
    expect(errorMessage(hostile)).toBe("an unprintable thrown object");
    expect(errorMessage(lyingError)).toBe("an unprintable thrown object");
  });

  it("never throws, whatever was caught (property)", () => {
    fc.assert(fc.property(fc.anything({ withNullPrototype: true, withBoxedValues: true, withMap: true, withSet: true }), (caught) => {
      expect(typeof errorMessage(caught)).toBe("string");
    }), { numRuns: 300 });
  });
});

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
