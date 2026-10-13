import { describe, expect, it } from "vitest";
import { changesFamily, invariantRoles, type OwnedInvariant } from "../../src/core/plan-paths";

const FAMILY: OwnedInvariant = {
  kind: "owned",
  owner: "src/probe.ts",
  siblings: [{ path: "src/panel.ts", note: null }, { path: "src/review.ts", note: "replay guard" }],
  matrixTest: "tests/probe.matrix.test.ts",
};

describe("invariantRoles — the one classification the validator and the brief share", () => {
  it("plays no role for a file list outside the family", () => {
    const roles = invariantRoles(["src/unrelated.ts"], FAMILY);
    expect(roles).toEqual({ owner: false, siblings: [], matrixTest: false });
    expect(changesFamily(roles)).toBe(false);
  });

  it("names every role a file list plays, siblings in declared order", () => {
    const roles = invariantRoles(["src/review.ts", "/repo/src/probe.ts", "src/panel.ts", "tests/probe.matrix.test.ts"], FAMILY);
    expect(roles).toEqual({ owner: true, siblings: FAMILY.siblings, matrixTest: true });
    expect(changesFamily(roles)).toBe(true);
  });

  it("does not count the matrix test alone as changing the family", () => {
    const roles = invariantRoles(["tests/probe.matrix.test.ts"], FAMILY);
    expect(roles.matrixTest).toBe(true);
    expect(changesFamily(roles)).toBe(false);
  });

  it("uses the plan-path rule: a bare basename does not claim a pathed sibling", () => {
    expect(invariantRoles(["panel.ts"], FAMILY).siblings).toEqual([]);
  });
});
