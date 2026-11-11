/**
 * The `behaviour-preserved` obligation (ADR-0068): what a Distill Task owes,
 * which observations discharge it, and that its stored Proof reads back.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PI_STRUCTURED_EVIDENCE_POLICY,
  TRUSTED_LEDGER_ONLY_POLICY,
  deriveProofObligations,
  evaluateTaskProof,
  parseObservedProofEvidence,
  parseProofObligationInput,
  parseTaskProof,
  type ObservedProofEvidence,
  type ProofObligationInput,
  type ProofTestResult,
} from "../../src/core/proof-obligations";
import type { ConformanceViolation, ContractConformance } from "../../src/core/skeleton/types";
import { observedEvidence } from "../fixtures/task-lifecycle";

const SCOPE = ["src/price.ts", "src/order.ts"];

const DISTILL: ProofObligationInput = {
  verificationPolicy: {
    regression: { kind: "waived", reason: "distill-pass" },
    newTests: { kind: "waived", reason: "distill-pass" },
  },
  declaredArtifacts: SCOPE,
  declaredArtifactExpectation: "preserved",
};

const attempt = (overrides: Partial<ObservedProofEvidence>): ObservedProofEvidence =>
  observedEvidence({ taskCompleted: true, filesModified: [], ...overrides });

const RETYPED: ConformanceViolation = { subject: "priceOrder", reason: "retyped", remedy: null };
const violating = (artifact: string): ContractConformance => ({ kind: "judged", violations: new Map([[artifact, [RETYPED]]]) });

const PI_PASS: ProofTestResult = { verdict: "untrusted", passed: true, label: "pi", provenance: "pi-structured" };

describe("behaviour-preserved", () => {
  it("is the only obligation a preserved scope adds, whatever the scope holds", () => {
    expect(deriveProofObligations(DISTILL)).toEqual([{ kind: "task-completed" }, { kind: "behaviour-preserved" }]);
    expect(deriveProofObligations({ ...DISTILL, declaredArtifacts: [] })).toEqual(deriveProofObligations(DISTILL));
  });

  it("is satisfied as unchanged when the attempt left the scope alone, with no test run at all", () => {
    const proof = evaluateTaskProof(DISTILL, attempt({}));
    expect(proof).toMatchObject({ state: "satisfied" });
    expect(proof.results[1]).toEqual({
      state: "satisfied",
      obligation: { kind: "behaviour-preserved" },
      evidence: { kind: "behaviour-preserved", basis: { kind: "unchanged" } },
    });
  });

  it("records a restoration, with what the attempt would have failed with", () => {
    const proof = evaluateTaskProof(DISTILL, attempt({ restoredAfter: ["proof:regression-tests-failed"] }));
    expect(proof.results[1]).toMatchObject({
      evidence: { kind: "behaviour-preserved", basis: { kind: "restored", after: ["proof:regression-tests-failed"] } },
    });
  });

  it("is satisfied by a trusted pass after a change, keeping the pass's provenance", () => {
    const changed = attempt({ filesModified: ["src/price.ts"], testResult: { verdict: "trusted-pass" } });
    expect(evaluateTaskProof(DISTILL, changed).results[1]).toMatchObject({
      evidence: { basis: { kind: "tests-passed", provenance: "evidence-ledger" } },
    });
    const onPi = attempt({ filesModified: ["src/price.ts"], testResult: PI_PASS });
    expect(evaluateTaskProof(DISTILL, onPi, PI_STRUCTURED_EVIDENCE_POLICY).results[1]).toMatchObject({
      evidence: { basis: { kind: "tests-passed", provenance: "pi-structured" } },
    });
  });

  it.each<[string, Partial<ObservedProofEvidence>, string]>([
    ["no test run", {}, "test-result-missing"],
    ["a failing run", { testResult: { verdict: "trusted-fail" } }, "regression-tests-failed"],
    ["a pass the policy does not admit", { testResult: PI_PASS }, "untrusted-regression-pass"],
  ])("fails a changed scope with %s, by the regression obligation's own failure", (_label, evidence, kind) => {
    const proof = evaluateTaskProof(DISTILL, attempt({ filesModified: ["src/price.ts"], ...evidence }), TRUSTED_LEDGER_ONLY_POLICY);
    expect(proof).toMatchObject({ state: "failed", failures: [{ kind }] });
  });

  it("fails a changed path that violates its contract even under a trusted pass, and ignores an unchanged one", () => {
    const pass: Partial<ObservedProofEvidence> = { filesModified: ["src/price.ts"], testResult: { verdict: "trusted-pass" } };
    expect(evaluateTaskProof(DISTILL, attempt({ ...pass, contractConformance: violating("src/price.ts") }))).toMatchObject({
      state: "failed",
      failures: [{ kind: "declared-artifact-contract-violated", artifact: "src/price.ts", violations: [RETYPED] }],
    });
    expect(evaluateTaskProof(DISTILL, attempt({ ...pass, contractConformance: violating("src/order.ts") }))).toMatchObject({
      state: "satisfied",
    });
  });

  it("holds for every observation: an untouched scope is always preserved, and a satisfied proof reads back", () => {
    const testResult = fc.constantFrom<ProofTestResult | undefined>(
      undefined,
      { verdict: "trusted-pass" },
      { verdict: "trusted-fail" },
      PI_PASS,
    );
    const changed = fc.subarray(SCOPE);
    fc.assert(fc.property(testResult, changed, fc.boolean(), (result, filesModified, completed) => {
      const proof = evaluateTaskProof(DISTILL, attempt({
        taskCompleted: completed,
        filesModified,
        ...(result === undefined ? {} : { testResult: result }),
      }));
      const preserved = proof.results[1];
      // Nothing changed: no test verdict can fail the obligation.
      if (filesModified.length === 0) expect(preserved?.state).toBe("satisfied");
      // Something changed: only a ledger-trusted pass satisfies it under the default policy.
      else expect(preserved?.state === "satisfied").toBe(result?.verdict === "trusted-pass");
      expect(parseTaskProof(JSON.parse(JSON.stringify(proof)))).toEqual({ ok: true, value: proof });
    }));
  });
});

describe("behaviour-preserved at the parse boundaries", () => {
  it("reads the preserved expectation and refuses any other spelling", () => {
    expect(parseProofObligationInput({ newTestsRequired: false, declaredArtifacts: SCOPE, declaredArtifactExpectation: "preserved" }))
      .toMatchObject({ ok: true, value: { declaredArtifactExpectation: "preserved" } });
    expect(parseProofObligationInput({ newTestsRequired: false, declaredArtifacts: SCOPE, declaredArtifactExpectation: "kept" }))
      .toEqual({ ok: false, errors: ["declaredArtifactExpectation must be one of changed, attested, preserved"] });
  });

  it("reads a restoration reason list and refuses an empty one", () => {
    const base = { taskCompleted: true, filesModified: [], contractConformance: { kind: "not-owed" } };
    expect(parseObservedProofEvidence({ ...base, restoredAfter: ["proof:test-result-missing"] }))
      .toMatchObject({ ok: true, value: { restoredAfter: ["proof:test-result-missing"] } });
    expect(parseObservedProofEvidence({ ...base, restoredAfter: [] })).toMatchObject({ ok: false });
  });

  it.each([
    ["a basis of another kind", { kind: "behaviour-preserved", basis: { kind: "skipped" } }],
    ["a restoration with no reason", { kind: "behaviour-preserved", basis: { kind: "restored", after: [] } }],
    ["a pass of unknown provenance", { kind: "behaviour-preserved", basis: { kind: "tests-passed", provenance: "transcript" } }],
    ["evidence of another obligation", { kind: "task-completed" }],
  ])("refuses a stored proof whose behaviour-preserved result carries %s", (_label, evidence) => {
    const obligations = [{ kind: "task-completed" }, { kind: "behaviour-preserved" }];
    const results = [
      { state: "satisfied", obligation: obligations[0], evidence: { kind: "task-completed" } },
      { state: "satisfied", obligation: obligations[1], evidence },
    ];
    expect(parseTaskProof({ state: "satisfied", obligations, results, evidence: results.map((result) => result.evidence) }))
      .toMatchObject({ ok: false });
  });

  it("refuses a failed behaviour-preserved result carrying another obligation's failure", () => {
    const obligations = [{ kind: "task-completed" }, { kind: "behaviour-preserved" }];
    const failure = { kind: "new-tests-not-observed" };
    const results = [
      { state: "satisfied", obligation: obligations[0], evidence: { kind: "task-completed" } },
      { state: "failed", obligation: obligations[1], failure },
    ];
    expect(parseTaskProof({ state: "failed", obligations, results, failures: [failure] })).toMatchObject({ ok: false });
  });
});
