/**
 * What one owner check runs, decided purely before anything runs
 * (`owed-verification.ts`; FR-002, FR-008, AS-004, AS-005): the gate's
 * decision from the plan integrity result, the owed obligations and the
 * authorized check, and the runner's per-obligation plan. No Git fixture is
 * involved; the shells only read the plan and execute what this decides.
 */

import { describe, expect, it } from "vitest";
import { freezeVerificationManifest, type AffectedRunner } from "../../src/core/verification-manifest";
import { obligationsDigest } from "../../src/core/owner-verification/obligations";
import {
  ownerObservationDecision,
  verificationRuns,
  type OwedVerification,
} from "../../src/core/owner-verification/owed-verification";
import { MUTANT_TIMEOUT_MS } from "../../src/core/owner-verification/mutation-plan";
import type { OwnerInfrastructureFailure, OwnerObligation } from "../../src/core/owner-verification/types";
import type { OwnerCheckAuthority } from "../../src/core/owner-check-authority";
import { invariantId, ownerObligation } from "../fixtures/owner-obligation";

const ADMISSION = ownerObligation({
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: null,
  owner: "src/rules/owner.ts",
  siblings: [{ path: "src/rules/sibling-a.ts", note: "admits members" }],
  matrixTest: "tests/rules.matrix.test.ts",
  mutation: { kind: "verify" },
});

const FEES = ownerObligation({
  invariant: "INV-2",
  title: "Fees are computed only by fees.ts",
  statement: null,
  owner: "src/fees.ts",
  siblings: [],
  matrixTest: "tests/fees.matrix.test.ts",
  mutation: { kind: "exempt", reason: "equivalent mutants only" },
});

const STAMP: readonly OwnerObligation[] = [ADMISSION, FEES];

const authorityOwing = (...owed: readonly OwnerObligation[]): OwnerCheckAuthority => ({
  obligationsDigest: obligationsDigest(STAMP),
  owed: owed.map(({ invariant }) => invariant),
});

const PLAN_UNREADABLE: OwnerInfrastructureFailure = { kind: "plan-unreadable", detail: "plan .claude/plans/p.md cannot be read: ENOENT" };

function owedOf(...owed: readonly OwnerObligation[]): OwedVerification {
  const decision = ownerObservationDecision({ integrity: null, owed, authority: authorityOwing(...owed) });
  if (decision.kind !== "must-run") throw new Error(`expected must-run, got ${decision.kind}`);
  return decision.owed;
}

const RUNNER: AffectedRunner = (() => {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    affectedRunner: {
      executable: "node",
      args: ["scripts/runner.mjs", "{files}"],
      cwd: ".",
      timeoutMs: 30_000,
      report: { kind: "required-file", path: ".loom/completion-reports/affected.junit.xml" },
    },
  })));
  if (!frozen.ok || frozen.value.affectedRunner === undefined) throw new Error("fixture manifest refused");
  return frozen.value.affectedRunner;
})();

describe("ownerObservationDecision — the gate's owner check before anything runs", () => {
  it("FR-002: a plan that no longer derives the stamp makes the check unavailable, whatever is owed", () => {
    expect(ownerObservationDecision({ integrity: PLAN_UNREADABLE, owed: [ADMISSION], authority: authorityOwing(ADMISSION) }))
      .toEqual({ kind: "unavailable", failure: PLAN_UNREADABLE });
    expect(ownerObservationDecision({ integrity: PLAN_UNREADABLE, owed: [], authority: authorityOwing() }))
      .toEqual({ kind: "unavailable", failure: PLAN_UNREADABLE });
  });

  it("AS-004: AS-005: a Wave owing nothing records verified [] with bound 0, bound to the authorized stamp", () => {
    expect(ownerObservationDecision({ integrity: null, owed: [], authority: authorityOwing() })).toEqual({
      kind: "verified-empty",
      observation: { kind: "verified", obligationsDigest: obligationsDigest(STAMP), boundMs: 0, verdicts: [] },
    });
  });

  it("an owed list must-run, pairing the obligations in stamp order with the authorized digest", () => {
    const decision = ownerObservationDecision({ integrity: null, owed: STAMP, authority: authorityOwing(...STAMP) });
    expect(decision).toMatchObject({ kind: "must-run", owed: { obligationsDigest: obligationsDigest(STAMP), obligations: STAMP } });
  });

  it.each([
    ["the check owes ids the Wave does not", [ADMISSION], authorityOwing(ADMISSION, FEES)],
    ["the Wave owes obligations the check does not", [ADMISSION, FEES], authorityOwing(ADMISSION)],
    ["the same ids in another order", [FEES, ADMISSION], authorityOwing(ADMISSION, FEES)],
    ["the check owes nothing while the Wave owes", [ADMISSION], authorityOwing()],
    ["the check owes while the Wave owes nothing", [], authorityOwing(ADMISSION)],
  ] as const)("owed obligations that disagree with the authorized check are plan drift, never a run: %s", (_case, owed, authority) => {
    const decision = ownerObservationDecision({ integrity: null, owed, authority });
    expect(decision).toMatchObject({ kind: "unavailable", failure: { kind: "plan-drift" } });
    if (decision.kind === "unavailable") expect(decision.failure.detail).toContain(`[${authority.owed.join(", ")}]`);
  });

  it("the drift detail names both id lists", () => {
    const decision = ownerObservationDecision({ integrity: null, owed: [ADMISSION], authority: { ...authorityOwing(), owed: [invariantId("INV-7")] } });
    expect(decision).toEqual({
      kind: "unavailable",
      failure: { kind: "plan-drift", detail: "the owner check owes [INV-7], but the Wave's stamped obligations are [INV-1]" },
    });
  });
});

describe("verificationRuns — each owed obligation's run, decided once", () => {
  it("FR-008: a verify obligation mutates through the frozen runner, an exempt one runs coverage only, in stamp order", () => {
    const planned = verificationRuns(owedOf(ADMISSION, FEES), RUNNER);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.runs).toEqual([
      { kind: "mutate", obligation: ADMISSION, runner: RUNNER },
      { kind: "exempt", obligation: FEES },
    ]);
    expect(planned.value.verifying).toEqual([ADMISSION]);
    expect(planned.value.perRunMs).toBe(Math.min(MUTANT_TIMEOUT_MS, RUNNER.timeoutMs));
  });

  it("a Wave owing mutation without a frozen runner is runner-missing, naming every obligation that owes it", () => {
    expect(verificationRuns(owedOf(ADMISSION, FEES), undefined)).toEqual({
      ok: false,
      error: { kind: "runner-missing", detail: "INV-1 owe mutation verification, but the frozen verification manifest declares no affectedRunner" },
    });
  });

  it("a Wave owing only exempt obligations needs no runner and reports a zero per-run bound", () => {
    expect(verificationRuns(owedOf(FEES), undefined)).toEqual({
      ok: true,
      value: { runs: [{ kind: "exempt", obligation: FEES }], verifying: [], perRunMs: 0 },
    });
  });

  it("decides by each obligation's policy, never by object identity: an equal copy is planned the same", () => {
    const copy = ownerObligation({ ...ADMISSION, invariant: ADMISSION.invariant });
    expect(copy).not.toBe(ADMISSION);
    const planned = verificationRuns(owedOf(copy), RUNNER);
    expect(planned.ok && planned.value.runs[0].kind).toBe("mutate");
  });
});
