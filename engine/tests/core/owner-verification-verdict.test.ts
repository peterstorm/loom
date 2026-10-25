import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mutationPlan, parseMutantCap } from "../../src/core/owner-verification/mutation-plan";
import {
  invariantVerdict,
  mutationBoundMs,
  ownerVerificationFailures,
  renderMutationVerdict,
  renderOwnerVerificationFailure,
  type MutantResult,
} from "../../src/core/owner-verification/verdict";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import { verifyOwed } from "../../src/core/owner-verification/obligations";
import type {
  CoverageVerdict,
  InvariantId,
  MutantCap,
  MutantOutcome,
  MutationPlan,
  OwnerObligation,
} from "../../src/core/owner-verification/types";
import { invariantId, ownerObligation } from "../fixtures/owner-obligation";

const OWNER = "src/rules/owner.ts";
const MATRIX = "tests/rules.matrix.test.ts";

const OWNER_TEXT = [
  "export function decide(age: number, member: boolean): boolean {",
  "  if (age >= 18 && member) {",
  "    return true;",
  "  }",
  '  log("rejected");',
  "  return false;",
  "}",
  "",
].join("\n");

const capOf = (raw: number): MutantCap => {
  const parsed = parseMutantCap(raw);
  if (!parsed.ok) throw new Error(`not a cap: ${raw}`);
  return parsed.value;
};

const planOf = (changed: readonly number[], cap = 24): MutationPlan => {
  const plan = mutationPlan({ ownerPath: OWNER, ownerText: OWNER_TEXT, changedLines: new Set(changed), cap: capOf(cap) });
  if (!plan.ok) throw new Error("the fixture owner parses");
  return plan.value;
};

const obligation = (invariant = "INV-1", mutation: OwnerObligation["mutation"] = { kind: "verify" }): OwnerObligation => ownerObligation({
  invariant,
  title: `rule ${invariant}`,
  statement: null,
  owner: OWNER,
  siblings: [{ path: "src/rules/sibling.ts", note: null }],
  matrixTest: MATRIX,
  mutation,
});

const COVERED: CoverageVerdict = { kind: "covered" };

const resultsOf = (plan: MutationPlan, outcome: (index: number) => MutantOutcome): readonly MutantResult[] =>
  plan.mutants.map((mutant, index) => ({ mutant, outcome: outcome(index) }));

const digest = (() => {
  const parsed = parseArtifactDigest("a".repeat(64));
  if (!parsed.ok) throw new Error("digest");
  return parsed.value;
})();

describe("invariantVerdict", () => {
  it("AS-010: AS-013: every mutant killed or timed out verifies with no survivor", () => {
    const plan = planOf([1, 2, 3, 4, 5, 6, 7]);
    const verdict = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, (index) => index % 2 === 0 ? { kind: "killed" } : { kind: "timed-out" }),
    });
    expect(verdict).toEqual({
      invariant: "INV-1", title: "rule INV-1", owner: OWNER, matrixTest: MATRIX, coverage: COVERED,
      mutation: { kind: "verified", generated: 8, killed: 4, timedOut: 4, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: true },
    });
    expect(ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 1, verdicts: [verdict] })).toEqual([]);
  });

  it("AS-011: a survivor is recorded with its operator, line, column, original and mutated text", () => {
    const plan = planOf([2]);
    const verdict = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, (index) => index === 2 ? { kind: "survived" } : { kind: "killed" }),
    });
    const swap = plan.mutants[2]!;
    expect(verdict.mutation).toEqual({
      kind: "verified", generated: 3, killed: 2, timedOut: 0, invalid: 0, unmutated: 0, ownerChangedInWave: true,
      survivors: [{ mutantId: swap.id, operator: "logical-swap", line: 2, column: 17, original: "&&", replacement: "||" }],
    });
  });

  it("AS-012: invalid mutants are counted apart, neither killed nor survived", () => {
    const plan = planOf([3]);
    const verdict = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, (index) => index === 0 ? { kind: "killed" } : { kind: "invalid", collectionErrors: [MATRIX] }),
    });
    expect(verdict.mutation).toMatchObject({ kind: "verified", generated: 2, killed: 1, invalid: 1, survivors: [] });
  });

  it("AS-015: the unmutated count is the sites the cap left out", () => {
    const plan = planOf([1, 2, 3, 4, 5, 6, 7], 3);
    const verdict = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan, results: resultsOf(plan, () => ({ kind: "killed" })),
    });
    expect(verdict.mutation).toMatchObject({ kind: "verified", generated: 3, killed: 3, unmutated: 5 });
  });

  it("AS-014: an owner unchanged in the Wave verifies with zero mutants and says so", () => {
    const verdict = invariantVerdict(obligation(), COVERED, { kind: "owner-unchanged", baseline: { kind: "green" } });
    expect(verdict.mutation).toEqual({ kind: "verified", generated: 0, killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: false });
    expect(renderMutationVerdict(verdict.mutation)).toBe("owner unchanged in Wave: 0 mutants generated");
  });

  it("AS-014: a changed owner with no mutable construct on its changed lines records zero mutants and says so", () => {
    const plan = planOf([1, 4, 7]);
    const verdict = invariantVerdict(obligation(), COVERED, { kind: "owner-changed", baseline: { kind: "green" }, plan, results: [] });
    expect(verdict.mutation).toEqual({ kind: "verified", generated: 0, killed: 0, timedOut: 0, invalid: 0, survivors: [], unmutated: 0, ownerChangedInWave: true });
    expect(renderMutationVerdict(verdict.mutation)).toBe("no mutable construct on the owner's changed lines: 0 mutants generated");
  });

  it("FR-008: a red baseline is the verdict, whatever the mutants did", () => {
    const plan = planOf([5]);
    const verdict = invariantVerdict(obligation(), COVERED, { kind: "owner-changed", baseline: { kind: "red", failures: ["matrix > x"] }, plan, results: [] });
    expect(verdict.mutation).toEqual({ kind: "red-baseline", failures: ["matrix > x"] });
    expect(invariantVerdict(obligation(), COVERED, { kind: "owner-unchanged", baseline: { kind: "red", failures: ["matrix > y"] } }).mutation)
      .toEqual({ kind: "red-baseline", failures: ["matrix > y"] });
  });

  it("FR-016: a baseline infrastructure failure, or any mutant's, is the verdict and never a kill", () => {
    const failure = { kind: "report-missing", detail: "no report" } as const;
    const plan = planOf([3]);
    expect(invariantVerdict(obligation(), COVERED, { kind: "owner-changed", baseline: { kind: "infrastructure", failure }, plan, results: [] }).mutation)
      .toEqual({ kind: "infrastructure", failure });
    expect(invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, (index) => index === 0 ? { kind: "killed" } : { kind: "infrastructure", failure }),
    }).mutation).toEqual({ kind: "infrastructure", failure });
    expect(invariantVerdict(obligation(), COVERED, { kind: "infrastructure", failure: { kind: "missing-wave-base", detail: "T2" } }).mutation)
      .toEqual({ kind: "infrastructure", failure: { kind: "missing-wave-base", detail: "T2" } });
  });

  it("FR-020: an exempt obligation's mutation verdict is its exemption; coverage still decides", () => {
    const exempt = obligation("INV-2", { kind: "exempt", reason: "generated code" });
    const missing: CoverageVerdict = { kind: "missing", paths: ["src/rules/sibling.ts"] };
    const verdict = invariantVerdict(exempt, missing, { kind: "exempt" });
    expect(verdict.mutation).toEqual({ kind: "exempt", reason: "generated code" });
    expect(verdict.coverage).toEqual(missing);
  });

  it("FR-016: a skipped mutation run of a non-exempt obligation fails closed as drift", () => {
    expect(invariantVerdict(obligation(), COVERED, { kind: "exempt" }).mutation)
      .toEqual({ kind: "infrastructure", failure: { kind: "plan-drift", detail: expect.stringContaining("INV-1") } });
  });

  it("FR-017: mutant results that are not the plan's mutants, in plan order, are plan-drift infrastructure, never a throw or a pass", () => {
    const plan = planOf([1, 2, 3, 4, 5, 6, 7]);
    const killed = resultsOf(plan, () => ({ kind: "killed" }));
    for (const results of [[], killed.slice(1), [...killed].reverse(), [...killed, killed[0]!]]) {
      const verdict = invariantVerdict(obligation(), COVERED, { kind: "owner-changed", baseline: { kind: "green" }, plan, results });
      expect(verdict.mutation).toEqual({ kind: "infrastructure", failure: { kind: "plan-drift", detail: expect.stringContaining("plan order") } });
      expect(ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 1, verdicts: [verdict] }))
        .toEqual([{ kind: "infrastructure", invariant: "INV-1", failure: verdict.mutation.kind === "infrastructure" ? verdict.mutation.failure : null }]);
    }
  });

  it("FR-016: generated mutants that are all invalid are the blocking no-valid-mutants infrastructure failure, never a verified pass", () => {
    const plan = planOf([2]);
    const verdict = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, () => ({ kind: "invalid", collectionErrors: ["matrix > import failed"] })),
    });
    expect(verdict.mutation).toEqual({
      kind: "infrastructure",
      failure: { kind: "no-valid-mutants", detail: expect.stringContaining(`all ${plan.mutants.length} generated mutants`) },
    });
    const failures = ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 1, verdicts: [verdict] });
    expect(failures.map(({ kind }) => kind)).toEqual(["infrastructure"]);
  });

  it("FR-016: invalid mutants beside a kill or a survivor still verify: only an all-invalid run lacks evidence", () => {
    const plan = planOf([2]);
    const withKill = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, (index) => index === 0 ? { kind: "killed" } : { kind: "invalid", collectionErrors: ["c"] }),
    });
    expect(withKill.mutation).toMatchObject({ kind: "verified", killed: 1, invalid: plan.mutants.length - 1, survivors: [] });
    const withSurvivor = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, (index) => index === 0 ? { kind: "survived" } : { kind: "invalid", collectionErrors: ["c"] }),
    });
    expect(withSurvivor.mutation).toMatchObject({ kind: "verified", killed: 0, invalid: plan.mutants.length - 1 });
    expect(ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 1, verdicts: [withSurvivor] }).map(({ kind }) => kind))
      .toEqual(["survivor"]);
  });
});

describe("ownerVerificationFailures", () => {
  const plan = planOf([2]);
  const survivorVerdict = invariantVerdict(obligation("INV-1"), { kind: "missing", paths: ["src/rules/sibling.ts"] }, {
    kind: "owner-changed", baseline: { kind: "green" }, plan, results: resultsOf(plan, () => ({ kind: "survived" })),
  });
  const redVerdict = invariantVerdict(obligation("INV-2"), COVERED, { kind: "owner-unchanged", baseline: { kind: "red", failures: ["matrix > r"] } });
  const infraVerdict = invariantVerdict(obligation("INV-3"), { kind: "infrastructure", failure: { kind: "coverage-bound-exceeded", detail: "513 files" } },
    { kind: "infrastructure", failure: { kind: "spawn-failed", detail: "ENOENT" } });
  const exemptVerdict = invariantVerdict(obligation("INV-4", { kind: "exempt", reason: "r" }), COVERED, { kind: "exempt" });

  it("AS-011: FR-014: every finding names its Invariant: missing siblings, survivors, red baselines and infrastructure", () => {
    const failures = ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 0, verdicts: [survivorVerdict, redVerdict, infraVerdict, exemptVerdict] });
    expect(failures.map((failure) => [failure.kind, failure.invariant])).toEqual([
      ["missing-siblings", "INV-1"],
      ["survivor", "INV-1"],
      ["survivor", "INV-1"],
      ["survivor", "INV-1"],
      ["red-baseline", "INV-2"],
      ["infrastructure", "INV-3"],
      ["infrastructure", "INV-3"],
    ]);
    expect(failures[1]).toEqual({
      kind: "survivor", invariant: "INV-1", owner: OWNER, matrixTest: MATRIX,
      survivor: { mutantId: plan.mutants[0]!.id, operator: "condition-negation", line: 2, column: 7, original: "age >= 18 && member", replacement: "!(age >= 18 && member)" },
    });
  });

  it("FR-016: an unavailable check is one failure of the whole check", () => {
    const failure = { kind: "plan-drift", detail: "INV-9 added" } as const;
    expect(ownerVerificationFailures({ kind: "unavailable", failure })).toEqual([{ kind: "infrastructure", invariant: null, failure }]);
  });

  it("AS-004: a Wave that owes nothing has no failure", () => {
    expect(ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 0, verdicts: [] })).toEqual([]);
  });

  it("AS-011: the survivor diagnostic names the Invariant, owner file and line, operator, and original and mutated text", () => {
    const [, survivor] = ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 0, verdicts: [survivorVerdict] });
    const message = renderOwnerVerificationFailure(survivor!);
    expect(message).toContain("INV-1");
    expect(message).toContain(`${OWNER}:2`);
    expect(message).toContain("condition-negation");
    expect(message).toContain("`age >= 18 && member`");
    expect(message).toContain("`!(age >= 18 && member)`");
    expect(message).toContain(MATRIX);
    expect(message).toContain("mutation exemption");
  });

  it("FR-014: every other failure renders its Invariant and evidence", () => {
    const failures = ownerVerificationFailures({ kind: "verified", obligationsDigest: digest, boundMs: 0, verdicts: [survivorVerdict, redVerdict, infraVerdict] });
    const [missing] = failures;
    expect(renderOwnerVerificationFailure(missing!)).toContain("src/rules/sibling.ts");
    const red = failures.find((failure) => failure.kind === "red-baseline")!;
    expect(renderOwnerVerificationFailure(red)).toMatch(/INV-2.*matrix > r/s);
    const infra = failures.filter((failure) => failure.kind === "infrastructure");
    expect(renderOwnerVerificationFailure(infra[0]!)).toMatch(/INV-3.*coverage-bound-exceeded.*513 files/s);
    expect(renderOwnerVerificationFailure({ kind: "infrastructure", invariant: null, failure: { kind: "plan-drift", detail: "d" } }))
      .toMatch(/plan-drift.*d/s);
  });
});

describe("renderMutationVerdict", () => {
  it("FR-013: summarizes every verdict kind", () => {
    const plan = planOf([1, 2, 3, 4, 5, 6, 7], 6);
    const verified = invariantVerdict(obligation(), COVERED, {
      kind: "owner-changed", baseline: { kind: "green" }, plan,
      results: resultsOf(plan, (index): MutantOutcome => index === 0 ? { kind: "survived" } : index === 1 ? { kind: "timed-out" } : index === 2 ? { kind: "invalid", collectionErrors: [MATRIX] } : { kind: "killed" }),
    });
    expect(renderMutationVerdict(verified.mutation)).toBe("6 mutants generated: 3 killed, 1 timed out, 1 invalid, 1 survived; 2 sites unmutated (cap)");
    expect(renderMutationVerdict({ kind: "exempt", reason: "generated code" })).toBe("mutation exempt: generated code");
    expect(renderMutationVerdict({ kind: "red-baseline", failures: ["a", "b"] })).toBe("baseline red: a; b");
    expect(renderMutationVerdict({ kind: "infrastructure", failure: { kind: "spawn-failed", detail: "x" } })).toBe("infrastructure (spawn-failed): x");
  });
});

describe("mutationBoundMs", () => {
  it("NFR-004: Σ owed non-exempt obligations × (1 baseline + selected) × per-mutant limit", () => {
    const owed = [obligation("INV-1"), obligation("INV-2"), obligation("INV-3", { kind: "exempt", reason: "r" }), obligation("INV-4")];
    const plans = new Map<InvariantId, MutationPlan>([
      [invariantId("INV-1"), planOf([2])], [invariantId("INV-2"), planOf([])], [invariantId("INV-3"), planOf([1, 2, 3, 4, 5, 6, 7])],
    ]);
    // INV-1: 1 + 3; INV-2: 1 + 0; INV-3 exempt; INV-4 has no plan: its baseline only.
    expect(mutationBoundMs(verifyOwed(owed), plans, 1_000)).toBe((4 + 1 + 1) * 1_000);
    expect(mutationBoundMs(verifyOwed([]), plans, 1_000)).toBe(0);
  });

  it("NFR-004: the bound grows with every selected mutant and never exceeds the cap's worth", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), fc.integer({ min: 1, max: 120_000 }), (cap, limit) => {
      const plan = planOf([1, 2, 3, 4, 5, 6, 7], cap);
      const bound = mutationBoundMs(verifyOwed([obligation()]), new Map([[invariantId("INV-1"), plan]]), limit);
      expect(bound).toBe((1 + plan.mutants.length) * limit);
      expect(bound).toBeLessThanOrEqual((1 + cap) * limit);
    }), { seed: 6_101, numRuns: 50 });
  });
});
