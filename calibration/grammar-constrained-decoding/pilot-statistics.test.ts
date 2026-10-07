import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bootstrapInterval, jsonInterval, nearestRankQuantile, quantileRecord, shuffled } from "./pilot-statistics";

describe("statistics", () => {
  it("ranks terminal failures (+inf) into quantiles instead of dropping them", () => {
    expect(nearestRankQuantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(nearestRankQuantile([...Array.from({ length: 94 }, () => 1), ...Array.from({ length: 6 }, () => Infinity)], 0.95)).toBe(Infinity);
    expect(Number.isNaN(nearestRankQuantile([], 0.5))).toBe(true);
  });

  it("produces a deterministic percentile bootstrap interval", () => {
    const values = Array.from({ length: 50 }, (_unused, index) => index);
    const mean = (sample: readonly number[]) => sample.reduce((sum, value) => sum + value, 0) / sample.length;
    const first = bootstrapInterval(values, mean, 400, 7, 0.95);
    expect(bootstrapInterval(values, mean, 400, 7, 0.95)).toEqual(first);
    expect(first.lower).toBeLessThan(24.5);
    expect(first.upper).toBeGreaterThan(24.5);
    expect(bootstrapInterval([5, 5, 5], mean, 200, 1, 0.95)).toMatchObject({ lower: 5, upper: 5 });
  });

  it("records quantiles and intervals as JSON-safe data: +inf is terminal-failure-dominated, NaN is no samples", () => {
    expect(quantileRecord(12)).toEqual({ kind: "finite", ms: 12 });
    expect(quantileRecord(Infinity)).toEqual({ kind: "terminal-failure-dominated" });
    expect(quantileRecord(Number.NaN)).toEqual({ kind: "no-samples" });
    expect(jsonInterval({ lower: Number.NaN, upper: Infinity, level: 0.95 })).toEqual({ lower: null, upper: null, level: 0.95 });
  });

  it("shuffles into a seeded permutation without mutating its input (property)", () => {
    fc.assert(fc.property(fc.array(fc.integer()), fc.nat(), (values, seed) => {
      const before = [...values];
      const once = shuffled(values, seed);
      expect(values).toEqual(before);
      expect(shuffled(values, seed)).toEqual(once);
      expect([...once].sort((a, b) => a - b)).toEqual([...values].sort((a, b) => a - b));
    }), { numRuns: 100 });
  });

  it("adding an emission terminal failure never improves the p95 ratio (failures are never hidden)", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 20, maxLength: 60 }),
      fc.nat({ max: 19 }),
      (latencies, failAt) => {
        const ratio = (emission: readonly number[]) => nearestRankQuantile(emission, 0.95) / nearestRankQuantile(latencies, 0.95);
        const failed = latencies.map((value, index) => (index === failAt ? Infinity : value));
        expect(ratio(failed)).toBeGreaterThanOrEqual(ratio(latencies));
      },
    ), { numRuns: 100 });
  });
});
