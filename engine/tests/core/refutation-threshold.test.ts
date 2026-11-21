/**
 * The refutation threshold: the one bar every Refutation Panel is judged
 * against, a function of its roster alone.
 *
 * (Round 14 also moved the file-based review-panel helper's run-policy rules
 * here; they retired with that helper, ADR-0096.)
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { defaultRefutationThreshold } from "../../src/core/review-panel";

describe("defaultRefutationThreshold — the one bar, a function of the roster", () => {
  it("requires unanimity at the minimum panel size", () => {
    expect(defaultRefutationThreshold(2)).toBe(2);
  });

  it("takes two of three and three of five", () => {
    expect(defaultRefutationThreshold(3)).toBe(2);
    expect(defaultRefutationThreshold(5)).toBe(3);
  });

  it("property: the smallest refutation count that outnumbers every other vote", () => {
    // A strict majority: one fewer refutation is at most half the panel, so a
    // tie keeps the finding; and the bar never exceeds the panel itself.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 64 }), (lenses) => {
        const threshold = defaultRefutationThreshold(lenses);
        return threshold * 2 > lenses && (threshold - 1) * 2 <= lenses && threshold <= lenses;
      }),
    );
  });
});
