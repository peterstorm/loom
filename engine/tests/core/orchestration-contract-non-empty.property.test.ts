/**
 * The kernel's non-empty list constructors carry the proof of non-emptiness
 * for every caller, so their own contract is pinned here: frozen results,
 * order kept, `nonEmpty([])` the one null, `mapNonEmpty`'s index, and
 * `concatNonEmpty` placing the proving list between its neighbours.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  concatNonEmpty,
  mapNonEmpty,
  nonEmpty,
  nonEmptyOf,
  type NonEmpty,
} from "../../src/core/orchestration-contract";

const values = fc.array(fc.integer(), { maxLength: 12 });
const nonEmptyValues = fc.tuple(fc.integer(), values).map(([head, tail]) => nonEmptyOf(head, ...tail));

describe("nonEmptyOf", () => {
  it("is the frozen list of its head then its tail", () => {
    fc.assert(fc.property(fc.integer(), values, (head, tail) => {
      const list = nonEmptyOf(head, ...tail);
      expect(list).toEqual([head, ...tail]);
      expect(Object.isFrozen(list)).toBe(true);
    }));
  });
});

describe("nonEmpty", () => {
  it("is null exactly for the empty list", () => {
    expect(nonEmpty([])).toBeNull();
  });

  it("is a frozen copy of any non-empty list, order kept, never the input itself", () => {
    fc.assert(fc.property(values.filter((list) => list.length > 0), (list) => {
      const proven = nonEmpty(list);
      expect(proven).toEqual(list);
      expect(proven).not.toBe(list);
      expect(Object.isFrozen(proven)).toBe(true);
    }));
  });
});

describe("mapNonEmpty", () => {
  it("agrees with Array.map, passing 0 for the head and i+1 for the tail", () => {
    fc.assert(fc.property(nonEmptyValues, (list) => {
      const mapped = mapNonEmpty(list, (value, index) => [value, index] as const);
      expect(mapped).toEqual(list.map((value, index) => [value, index]));
      expect(Object.isFrozen(mapped)).toBe(true);
    }));
  });
});

describe("concatNonEmpty", () => {
  it("is before, then the proving list, then after — frozen", () => {
    fc.assert(fc.property(values, nonEmptyValues, values, (before, proof, after) => {
      const joined: NonEmpty<number> = concatNonEmpty(before, proof, after);
      expect(joined).toEqual([...before, ...proof, ...after]);
      expect(Object.isFrozen(joined)).toBe(true);
    }));
  });

  it("defaults `after` to nothing", () => {
    fc.assert(fc.property(values, nonEmptyValues, (before, proof) => {
      expect(concatNonEmpty(before, proof)).toEqual([...before, ...proof]);
    }));
  });
});
