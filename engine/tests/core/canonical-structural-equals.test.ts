/**
 * Direct coverage for `canonicalStructuralEquals`.
 *
 * The function backs every checkpoint/replay idempotency comparison in
 * `standalone-review-machine.ts`, and each distinction it draws is load-bearing
 * there: a checkpoint that compared equal when it should not would let a
 * replayed run widen its own authority. Until now it was only ever exercised
 * transitively through those call sites, so an inverted branch inside it —
 * treating a Map as a record, a Date as its fields, an absent key as an
 * `undefined` one — would have shown up as a distant behavioural bug rather
 * than a failing test here.
 */

import { describe, expect, it } from "vitest";
import { canonicalRecord, canonicalStructuralEquals } from "../../src/core/orchestration-contract";

const jsonRoundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe("canonicalStructuralEquals", () => {
  describe("the prototype distinction it deliberately ignores", () => {
    it("equates a canonical record with the plain object a JSON round trip produces", () => {
      const canonical = canonicalRecord({ runId: "run.a", attempt: 1, nested: canonicalRecord({ slot: "s-1" }) });
      expect(canonicalStructuralEquals(canonical, jsonRoundTrip(canonical))).toBe(true);
    });

    it("equates two canonical records with the same fields", () => {
      expect(canonicalStructuralEquals(canonicalRecord({ a: 1 }), canonicalRecord({ a: 1 }))).toBe(true);
    });
  });

  describe("the prototype distinctions it must keep", () => {
    it("refuses a Map that merely carries the same entries as a record", () => {
      expect(canonicalStructuralEquals(new Map([["a", 1]]), { a: 1 })).toBe(false);
    });

    it("refuses a Set that merely carries the same members as an array", () => {
      expect(canonicalStructuralEquals(new Set([1, 2]), [1, 2])).toBe(false);
    });

    it("refuses a Date compared against the string JSON turns it into", () => {
      const date = new Date("2026-08-11T00:00:00.000Z");
      expect(canonicalStructuralEquals(date, jsonRoundTrip(date))).toBe(false);
    });

    it("refuses a RegExp compared against the empty object JSON turns it into", () => {
      expect(canonicalStructuralEquals(/abc/g, jsonRoundTrip(/abc/g))).toBe(false);
    });

    it("refuses a class instance compared against a plain record with the same fields", () => {
      class Authority { constructor(readonly runId: string) {} }
      expect(canonicalStructuralEquals(new Authority("run.a"), { runId: "run.a" })).toBe(false);
    });
  });

  describe("absent keys are not undefined keys", () => {
    it("refuses an own key whose value is undefined against an absent key", () => {
      expect(canonicalStructuralEquals({ a: 1, b: undefined }, { a: 1 })).toBe(false);
    });

    it("refuses the same pair in the opposite argument order", () => {
      expect(canonicalStructuralEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    });

    it("is exactly the distinction a JSON round trip erases", () => {
      const withUndefined = { a: 1, b: undefined };
      expect(canonicalStructuralEquals(withUndefined, jsonRoundTrip(withUndefined))).toBe(false);
    });
  });

  describe("Map and Set compare as multisets, not by iteration order", () => {
    it("equates Maps whose entries were inserted in a different order", () => {
      expect(canonicalStructuralEquals(
        new Map<string, unknown>([["a", 1], ["b", 2]]),
        new Map<string, unknown>([["b", 2], ["a", 1]]),
      )).toBe(true);
    });

    it("equates Sets whose members were inserted in a different order", () => {
      expect(canonicalStructuralEquals(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    });

    it("equates Maps keyed by structurally equal object keys", () => {
      expect(canonicalStructuralEquals(
        new Map([[{ slot: "s-1" }, "left"]]),
        new Map([[{ slot: "s-1" }, "left"]]),
      )).toBe(true);
    });

    it("refuses Maps of equal size whose values differ under one key", () => {
      expect(canonicalStructuralEquals(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    });

    it("refuses Maps of different size", () => {
      expect(canonicalStructuralEquals(new Map([["a", 1]]), new Map([["a", 1], ["b", 2]]))).toBe(false);
    });

    it("consumes each candidate once, so a duplicate cannot match two members", () => {
      expect(canonicalStructuralEquals(
        new Set([{ id: 1 }, { id: 1 }]),
        new Set([{ id: 1 }, { id: 2 }]),
      )).toBe(false);
    });
  });

  describe("scalars and arrays", () => {
    it("distinguishes NaN from a non-number and equates NaN with itself", () => {
      expect(canonicalStructuralEquals(Number.NaN, Number.NaN)).toBe(true);
      expect(canonicalStructuralEquals(Number.NaN, 0)).toBe(false);
    });

    it("keeps +0 and -0 distinct, as Object.is does", () => {
      expect(canonicalStructuralEquals(0, -0)).toBe(false);
    });

    it("refuses an array compared against a record with numeric keys", () => {
      expect(canonicalStructuralEquals([1, 2], { 0: 1, 1: 2 })).toBe(false);
    });

    it("compares arrays position by position", () => {
      expect(canonicalStructuralEquals([1, 2], [2, 1])).toBe(false);
      expect(canonicalStructuralEquals([1, 2], [1, 2])).toBe(true);
    });

    it("refuses null against a record", () => {
      expect(canonicalStructuralEquals(null, {})).toBe(false);
    });
  });

  describe("cycles terminate instead of recursing forever", () => {
    it("equates two structurally identical self-referential records", () => {
      const left: Record<string, unknown> = { runId: "run.a" };
      left.self = left;
      const right: Record<string, unknown> = { runId: "run.a" };
      right.self = right;
      expect(canonicalStructuralEquals(left, right)).toBe(true);
    });

    it("still separates cyclic structures that differ outside the cycle", () => {
      const left: Record<string, unknown> = { runId: "run.a" };
      left.self = left;
      const right: Record<string, unknown> = { runId: "run.b" };
      right.self = right;
      expect(canonicalStructuralEquals(left, right)).toBe(false);
    });
  });

  // The cycle memo records "this pair is currently being compared", never "this
  // pair compared equal". Map/Set matching tries candidates speculatively and
  // tolerates failures, so a pair registered by a REJECTED candidate must not
  // survive to answer for a different comparison later in the structure —
  // otherwise two plainly different values report equal, and a mismatched
  // checkpoint passes the agreement check this function exists to enforce.
  describe("a rejected speculative match never poisons a later comparison", () => {
    it("separates sets whose failed trial pairing recurs in another field", () => {
      const shared = { tag: "S" };
      const decoy = { tag: "D" };

      const left = { a: new Set([shared, { tag: "D" }]), b: new Set([shared]) };
      const right = { a: new Set([decoy, { tag: "S" }]), b: new Set([decoy]) };

      // Field `b` is {tag:"S"} against {tag:"D"} — plainly unequal. It is only
      // reachable as `true` if matching field `a` left the (shared, decoy)
      // pairing it rejected behind in the memo.
      expect(canonicalStructuralEquals(left, right)).toBe(false);
    });

    it("separates maps whose failed trial pairing recurs in another field", () => {
      const shared = { tag: "S" };
      const decoy = { tag: "D" };

      const left = {
        a: new Map([[shared, 1], [{ tag: "D" }, 2]]),
        b: new Map([[shared, 1]]),
      };
      const right = {
        a: new Map([[decoy, 2], [{ tag: "S" }, 1]]),
        b: new Map([[decoy, 1]]),
      };

      expect(canonicalStructuralEquals(left, right)).toBe(false);
    });

    it("still equates values that genuinely share references across fields", () => {
      const shared = { tag: "S" };
      const other = { tag: "D" };

      const left = { a: new Set([shared, other]), b: new Set([shared]) };
      const right = {
        a: new Set([{ tag: "S" }, { tag: "D" }]),
        b: new Set([{ tag: "S" }]),
      };

      expect(canonicalStructuralEquals(left, right)).toBe(true);
    });

    it("separates records reusing one reference under two differing keys", () => {
      const shared = { id: 1 };
      const left = { x: shared, y: shared };
      const right = { x: { id: 1 }, y: { id: 2 } };

      expect(canonicalStructuralEquals(left, right)).toBe(false);
    });
  });
});
