/**
 * `allOk` — the accumulator `frozenPathDigests` and `contractWriter` combine
 * their per-path results with. Its contract is operator-facing ("every
 * drifted path named"), so it is pinned against a reference partition:
 * all-ok yields every value in input order; any error yields every error in
 * input order, and the ok values interleaved with them are dropped.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allOk, err, ok } from "../../src/core/acceptance-contract/kernel";
import { nonEmptyOf, type DomainResult } from "../../src/core/orchestration-contract";

type Result = DomainResult<number, string>;

const result: fc.Arbitrary<Result> = fc.oneof(
  fc.integer().map((value): Result => ok(value)),
  fc.string().map((error): Result => err(error)),
);
const results = fc.tuple(result, fc.array(result, { maxLength: 12 })).map(([head, tail]) => nonEmptyOf(head, ...tail));

describe("allOk", () => {
  it("is every value in input order when no result failed, else every error in input order", () => {
    fc.assert(fc.property(results, (list) => {
      const errors = list.flatMap((entry) => (entry.ok ? [] : [entry.error]));
      const okValues = list.flatMap((entry) => (entry.ok ? [entry.value] : []));
      expect(allOk(list)).toEqual(errors.length === 0 ? { ok: true, value: okValues } : { ok: false, error: errors });
    }));
  });

  it("names every failure, including failures that follow ok results", () => {
    expect(allOk(nonEmptyOf<Result>(err("a"), ok(1), err("b"), ok(2), err("c")))).toEqual({ ok: false, error: ["a", "b", "c"] });
    expect(allOk(nonEmptyOf<Result>(ok(1), ok(2), err("late")))).toEqual({ ok: false, error: ["late"] });
  });

  it("freezes what it returns", () => {
    fc.assert(fc.property(results, (list) => {
      const combined = allOk(list);
      expect(Object.isFrozen(combined)).toBe(true);
      expect(Object.isFrozen(combined.ok ? combined.value : combined.error)).toBe(true);
    }));
  });
});
