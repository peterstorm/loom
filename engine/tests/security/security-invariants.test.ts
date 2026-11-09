/**
 * Cross-cutting invariants the review found asserted in prose but unpinned in
 * tests. Each case here was reachable with the suite green before it existed:
 *
 *   INV-S2   a unit settles ONCE per wave — a second settlement is refused, so a
 *            `blocked` disposition can never be silently upgraded to `covered`;
 *   INV-S6b  the published documents are a function of the finding SET, not its
 *            arrival order (two hunters' files may land in either order);
 *   INV-S5   `validateLedger` is total: arbitrary junk is refused, never thrown on.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalCoverageId } from "../../src/core/security-audit-contract";
import {
  assignUnits,
  recordUnitResult,
  seedCoverageUnit,
  validateLedger,
  type CoverageLedger,
  type UnitResult,
} from "../../src/core/security-coverage";
import { parseSecurityFindings, type SecurityFinding } from "../../src/core/security-findings";
import { renderRunDocuments } from "../../src/core/security-reports";
import {
  HUNTER_AGENT as HUNTER,
  aConfirmedFinding,
  aNeedsValidationFinding,
  aRejectedFinding,
  aRunMetadata,
  aSeed,
  ok,
} from "./fixtures";

const anAssignedLedger = (): CoverageLedger => {
  const seeded = ok(seedCoverageUnit(aSeed()));
  return ok(assignUnits([seeded], [{ coverageId: seeded.coverage_id, agentId: HUNTER, wave: 1 }])).ledger;
};

/** A settlement the ledger accepts for any terminal status: one source check
 *  owns the reviewed path, and a fingerprint is filed only for `candidate`. */
const aResult = (overrides: Partial<UnitResult> = {}): UnitResult => {
  const status = overrides.status ?? "covered";
  return {
    coverageId: canonicalCoverageId(aSeed().refs),
    agentId: HUNTER,
    wave: 1,
    reviewedPaths: ["src/api/login.ts"],
    checks: [{
      agent_id: HUNTER,
      reviewed_paths: ["src/api/login.ts"],
      invariant: "Every request field reaches the query as a bound parameter.",
      method: "source",
      result: "The field is interpolated into the query string.",
      artifact: null,
    }],
    fingerprints: status === "candidate" ? ["api/login:sqli-email"] : [],
    unresolved: status === "blocked" ? ["no database container to reproduce the payload"] : [],
    ...overrides,
    status,
  };
};

describe("a unit settles once per wave (INV-S2)", () => {
  it("refuses a second settlement of the same unit", () => {
    const settled = ok(recordUnitResult(anAssignedLedger(), aResult({ status: "blocked" })));
    const again = recordUnitResult(settled, aResult({ status: "covered" }));
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.kind).toBe("unit-not-in-flight");
    // The refusal left the first disposition alone: `blocked` is not upgradable.
    expect(settled[0]?.status).toBe("blocked");
  });

  it("never accepts more than one settlement, whatever the sequence of statuses", () => {
    const statuses = ["covered", "candidate", "blocked"] as const;
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...statuses), { minLength: 1, maxLength: 5 }), (attempts) => {
        let ledger = anAssignedLedger();
        let accepted = 0;
        for (const status of attempts) {
          const next = recordUnitResult(ledger, aResult({ status }));
          if (next.ok) {
            ledger = next.value;
            accepted += 1;
          }
        }
        // Exactly one settlement lands, and it is the first one: a later
        // disposition never overwrites an earlier one.
        expect(accepted).toBe(1);
        expect(ledger[0]?.status).toBe(attempts[0]);
      }),
      { numRuns: 40 },
    );
  });

  it("refuses a settlement by a sibling hunter, a stale wave, or an unknown cell", () => {
    expect(recordUnitResult(anAssignedLedger(), aResult({ agentId: "security-hunter-agent-b" })).ok).toBe(false);
    expect(recordUnitResult(anAssignedLedger(), aResult({ wave: 2 })).ok).toBe(false);
    expect(recordUnitResult(anAssignedLedger(), aResult({ coverageId: "no::such::cell::x" })).ok).toBe(false);
  });
});

const metadata = aRunMetadata({ sourceRef: { commit: "a".repeat(40), worktreeDirty: false }, published: true });

/** A sorted set: the PARSER requires order, so order-invariance is a property of
 *  the RENDERER and is asserted by handing it the same set shuffled. */
const aFindingSet = (): readonly SecurityFinding[] =>
  ok(parseSecurityFindings([
    aConfirmedFinding({ fingerprint: "a/first" }),
    aConfirmedFinding({ fingerprint: "b/second" }),
    aNeedsValidationFinding({ fingerprint: "c/third" }),
    aRejectedFinding({ fingerprint: "d/fourth" }),
  ]));

describe("published documents are order-invariant (INV-S6b)", () => {
  it("renders the same bytes for every permutation of the finding set", () => {
    const ledger = ok(recordUnitResult(anAssignedLedger(), aResult({ status: "covered" })));
    const baseline = renderRunDocuments({ metadata, ledger, findings: aFindingSet(), locator: "/out" });
    const set = [...aFindingSet()];
    fc.assert(
      fc.property(fc.shuffledSubarray(set, { minLength: set.length, maxLength: set.length }), (shuffled) => {
        expect(renderRunDocuments({ metadata, ledger, findings: shuffled, locator: "/out" })).toEqual(baseline);
      }),
      { numRuns: 25 },
    );
  });

  it("orders each document's entries by fingerprint, not by arrival", () => {
    const ledger = ok(recordUnitResult(anAssignedLedger(), aResult({ status: "covered" })));
    const documents = renderRunDocuments({ metadata, ledger, findings: aFindingSet(), locator: "/out" });
    // Each document carries the verdicts it is about; within one, order follows
    // the fingerprint, so a reader comparing two runs sees the same sequence.
    const expectations: readonly (readonly [document: string, fingerprints: readonly string[]])[] = [
      ["FINDINGS-DETAIL.md", ["a/first", "b/second"]],
      ["NEEDS-VALIDATION.md", ["c/third"]],
      // REPORT.md's needs-validation table names a lead by TITLE, not by
      // fingerprint, so the fingerprints it can be ordered by are these three.
      ["REPORT.md", ["a/first", "b/second", "d/fourth"]],
    ];
    for (const [document, fingerprints] of expectations) {
      const body = documents[document] ?? "";
      const positions = fingerprints.map((fingerprint) => body.indexOf(fingerprint));
      expect(positions.every((position) => position >= 0), document).toBe(true);
      expect([...positions].sort((left, right) => left - right), document).toEqual(positions);
    }
  });
});

describe("validateLedger is total (INV-S5)", () => {
  const junk = fc.oneof(
    fc.anything(),
    fc.array(fc.anything(), { maxLength: 3 }),
    fc.record({ status: fc.string(), coverage_id: fc.string() }),
  );

  it("refuses arbitrary input instead of throwing on it", () => {
    fc.assert(
      fc.property(junk, (value) => {
        expect(Array.isArray(validateLedger(value as CoverageLedger))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("refuses null, a bare object, and an array of junk", () => {
    for (const value of [null, {}, [null], [{}], [{ status: "covered" }], [42]]) {
      expect(validateLedger(value as CoverageLedger).length).toBeGreaterThan(0);
    }
  });
});
