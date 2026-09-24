/**
 * Attestation proof arms (D4 option 2): the `declared-artifact-attested`
 * obligation/failure/evidence triple, its derivation, its parsers, and its
 * settlement behavior through the real Implementation Completion Oracle.
 *
 * The attested arm inverts the changed arm's comparison against the SAME
 * observed write set: a verify-only child leaves declared bytes untouched, so
 * absence from the changed set satisfies; a write is drift, never evidence.
 */

import { describe, expect, it } from "vitest";
import {
  derivePendingTaskProof,
  deriveProofObligations,
  evaluateProofObligations,
  parseProofEvidence,
  parseProofFailure,
  parseProofObligation,
  parseProofObligationInput,
  parseTaskProof,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ObservedProofEvidence,
} from "../../src/core/proof-obligations";
import { LEGACY_TESTS_WAIVED_POLICY, REQUIRED_VERIFICATION_POLICY, serializeVerificationPolicy, type VerificationPolicy } from "../../src/core/verification-policy";
import {
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  parseIsoInstant,
  parseReservationId,
  settleImplementationAttempt,
} from "../../src/core/implementation-completion";

const observed = (overrides: Partial<ObservedProofEvidence> = {}): ObservedProofEvidence => ({
  taskCompleted: true,
  testResult: { verdict: "trusted-pass" },
  filesModified: [],
  newTestsWritten: false,
  newTestEvidence: "",
  ...overrides,
});

/** The attestation policy in its in-memory (camelCase) shape. */
const ATTESTED_POLICY: VerificationPolicy = Object.freeze({
  regression: Object.freeze({ kind: "required" as const }),
  newTests: Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" }),
});

describe("attestation obligation derivation", () => {
  it("derives attested declared-artifact obligations under the attested expectation", () => {
    const obligations = deriveProofObligations({
      verificationPolicy: REQUIRED_VERIFICATION_POLICY,
      declaredArtifacts: ["src/a.ts", "src/b.ts"],
      declaredArtifactExpectation: "attested",
    });
    expect(obligations.map((obligation) => obligation.kind)).toEqual([
      "task-completed", "regression-test-pass", "new-tests", "attempt-scope-attested",
      "declared-artifact-attested", "declared-artifact-attested",
    ]);
    expect(obligations.slice(4)).toEqual([
      { kind: "declared-artifact-attested", artifact: "src/a.ts" },
      { kind: "declared-artifact-attested", artifact: "src/b.ts" },
    ]);
  });

  it("defaults to the changed expectation and carries it through both input arms", () => {
    expect(deriveProofObligations({
      newTestsRequired: false,
      declaredArtifacts: ["src/a.ts"],
    }).map((obligation) => obligation.kind)).toEqual([
      "task-completed", "declared-artifact-changed",
    ]);
    expect(deriveProofObligations({
      newTestsRequired: false,
      declaredArtifacts: ["src/a.ts"],
      declaredArtifactExpectation: "changed",
    })[1]).toEqual({ kind: "declared-artifact-changed", artifact: "src/a.ts" });
  });

  it("derives a regression-only attestation proof from the waived-new-tests policy", () => {
    const proof = derivePendingTaskProof({
      verificationPolicy: ATTESTED_POLICY,
      declaredArtifacts: ["src/a.ts"],
      declaredArtifactExpectation: "attested",
    });
    expect(proof.obligations.map((obligation) => obligation.kind)).toEqual([
      "task-completed", "regression-test-pass", "attempt-scope-attested", "declared-artifact-attested",
    ]);
  });
});

describe("attestation obligation evaluation", () => {
  it("satisfies when the artifact is absent from the observed write set", () => {
    const proof = evaluateProofObligations(
      deriveProofObligations({
        verificationPolicy: ATTESTED_POLICY,
        declaredArtifacts: ["src/a.ts"],
        declaredArtifactExpectation: "attested",
      }),
      observed(),
    );
    expect(proof.state).toBe("satisfied");
    if (proof.state === "satisfied") {
      expect(proof.evidence).toContainEqual({ kind: "declared-artifact-attested", artifact: "src/a.ts" });
    }
  });

  it("fails with declared-artifact-drifted when the artifact was written", () => {
    const proof = evaluateProofObligations(
      deriveProofObligations({
        verificationPolicy: ATTESTED_POLICY,
        declaredArtifacts: ["src/a.ts", "src/b.ts"],
        declaredArtifactExpectation: "attested",
      }),
      observed({ filesModified: ["src/b.ts"] }),
    );
    expect(proof.state).toBe("failed");
    if (proof.state === "failed") {
      expect(proof.failures).toContainEqual({ kind: "attempt-scope-drifted" });
      expect(proof.failures).toContainEqual({ kind: "declared-artifact-drifted", artifact: "src/b.ts" });
      // The untouched sibling still carries its satisfied result — no result is
      // lost merely because a sibling drifted.
      expect(proof.results).toContainEqual(expect.objectContaining({
        state: "satisfied",
        obligation: { kind: "declared-artifact-attested", artifact: "src/a.ts" },
      }));
    }
  });

  it("fails when any registered attempt-scope path outside file_list changes", () => {
    const proof = evaluateProofObligations(
      deriveProofObligations({
        verificationPolicy: ATTESTED_POLICY,
        declaredArtifacts: ["src/a.ts"],
        declaredArtifactExpectation: "attested",
      }),
      observed({ filesModified: ["src/extra.ts"] }),
    );
    expect(proof).toMatchObject({
      state: "failed",
      failures: [{ kind: "attempt-scope-drifted" }],
      results: expect.arrayContaining([expect.objectContaining({
        state: "satisfied",
        obligation: { kind: "declared-artifact-attested", artifact: "src/a.ts" },
      })]),
    });
  });
});

describe("attestation parsers", () => {
  it("round-trips the attested obligation, failure, and evidence arms", () => {
    expect(parseProofObligation({ kind: "attempt-scope-attested" }))
      .toEqual({ ok: true, value: { kind: "attempt-scope-attested" } });
    expect(parseProofFailure({ kind: "attempt-scope-drifted" }))
      .toEqual({ ok: true, value: { kind: "attempt-scope-drifted" } });
    expect(parseProofEvidence({ kind: "attempt-scope-attested" }))
      .toEqual({ ok: true, value: { kind: "attempt-scope-attested" } });
    expect(parseProofObligation({ kind: "declared-artifact-attested", artifact: "src/a.ts" }))
      .toEqual({ ok: true, value: { kind: "declared-artifact-attested", artifact: "src/a.ts" } });
    expect(parseProofObligation({ kind: "declared-artifact-attested" }).ok).toBe(false);
    expect(parseProofFailure({ kind: "declared-artifact-drifted", artifact: "src/a.ts" }))
      .toEqual({ ok: true, value: { kind: "declared-artifact-drifted", artifact: "src/a.ts" } });
    expect(parseProofEvidence({ kind: "declared-artifact-attested", artifact: "src/a.ts" }))
      .toEqual({ ok: true, value: { kind: "declared-artifact-attested", artifact: "src/a.ts" } });
  });

  it("keys attested obligations by kind and artifact, keeping the set unique", () => {
    const obligation = { kind: "declared-artifact-attested", artifact: "src/a.ts" };
    const result = { state: "pending", obligation };
    expect(parseTaskProof({
      state: "pending",
      obligations: [{ kind: "task-completed" }, obligation],
      results: [{ state: "pending", obligation: { kind: "task-completed" } }, result],
    })).toMatchObject({ ok: true });
    expect(parseTaskProof({
      state: "pending",
      obligations: [obligation, { ...obligation }],
      results: [result, { ...result }],
    })).toMatchObject({ ok: false, errors: expect.arrayContaining(["proof obligations must be unique"]) });
  });

  it("refuses a drifted failure attached to a changed obligation and vice versa", () => {
    expect(parseTaskProof({
      state: "failed",
      obligations: [{ kind: "declared-artifact-attested", artifact: "src/a.ts" }],
      results: [{
        state: "failed",
        obligation: { kind: "declared-artifact-attested", artifact: "src/a.ts" },
        failure: { kind: "declared-artifact-not-changed", artifact: "src/a.ts" },
      }],
      failures: [{ kind: "declared-artifact-not-changed", artifact: "src/a.ts" }],
    })).toMatchObject({ ok: false });
    expect(parseTaskProof({
      state: "satisfied",
      obligations: [{ kind: "declared-artifact-attested", artifact: "src/a.ts" }],
      results: [{
        state: "satisfied",
        obligation: { kind: "declared-artifact-attested", artifact: "src/a.ts" },
        evidence: { kind: "declared-artifact-changed", artifact: "src/a.ts" },
      }],
      evidence: [{ kind: "declared-artifact-changed", artifact: "src/a.ts" }],
    })).toMatchObject({ ok: false });
  });

  it("validates declaredArtifactExpectation on the obligation input", () => {
    expect(parseProofObligationInput({
      verificationPolicy: serializeVerificationPolicy(REQUIRED_VERIFICATION_POLICY),
      declaredArtifacts: [],
      declaredArtifactExpectation: "attested",
    })).toMatchObject({ ok: true, value: { declaredArtifactExpectation: "attested" } });
    expect(parseProofObligationInput({
      newTestsRequired: true,
      declaredArtifacts: [],
      declaredArtifactExpectation: "inverted",
    })).toMatchObject({ ok: false, errors: expect.arrayContaining(["declaredArtifactExpectation must be changed or attested"]) });
    expect(parseProofObligationInput({
      verificationPolicy: serializeVerificationPolicy(LEGACY_TESTS_WAIVED_POLICY),
      declaredArtifacts: ["x.ts"],
      declaredArtifactExpectation: "attested",
    })).toMatchObject({
      ok: true,
      value: { declaredArtifacts: ["x.ts"], declaredArtifactExpectation: "attested" },
    });
  });
});

describe("attestation settlement through the Implementation Completion Oracle", () => {
  const instant = parseIsoInstant("2026-09-19T00:00:00.000Z");
  const reservation = parseReservationId("attest-settle-attempt");
  if (!instant.ok || !reservation.ok) throw new Error("fixture identity failed");
  const authority = (() => {
    const created = createImplementationAttemptAuthority({
      taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservation.value,
      headSha: "1".repeat(40), reservedAt: instant.value,
      taskScopeBaseline: [{ artifact: "src/a.ts", snapshot: { kind: "sha256", digest: "a".repeat(64) } }],
      dirtySetBaseline: [],
    });
    if (!created.ok) throw new Error(created.error.errors.join("; "));
    return created.value;
  })();
  const suite = (() => {
    const built = createTaskCompletionSuiteAuthority(authority);
    if (!built.ok) throw new Error(built.error.errors.join("; "));
    return built.value;
  })();
  const suiteResult = {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: suite.implementationAuthorityDigest,
    suiteDigest: suite.suiteDigest,
    checks: [{
      checkId: suite.checks[0].checkId,
      scope: "task",
      outcome: { kind: "accepted", changedPaths: [] },
    }],
  };
  const attestationProof = derivePendingTaskProof({
    verificationPolicy: ATTESTED_POLICY,
    declaredArtifacts: ["src/a.ts"],
    declaredArtifactExpectation: "attested",
  });
  const settleableTask = {
    id: "T1",
    status: "pending" as const,
    proof: attestationProof,
    active_implementation_attempt: authority,
    implementation_attempt_history: [],
  };
  const observation = {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: "2026-09-19T00:01:00.000Z",
    evidence: observed(),
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
  };

  it("settles a verify-only child as implemented", () => {
    const result = settleImplementationAttempt(
      settleableTask, authority, authority, observation, suiteResult,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.value.kind !== "implemented") throw new Error(JSON.stringify(result));
    expect(result.value.receipt).toMatchObject({ transition: "implemented", semanticAttempt: 1 });
    expect(result.value.proof.evidence).toContainEqual({
      kind: "declared-artifact-attested", artifact: "src/a.ts",
    });
  });

  it("settles a writing child as retry-required with a drifted failure", () => {
    const drifted = {
      ...observation,
      evidence: observed({ filesModified: ["src/a.ts"] }),
    };
    const result = settleImplementationAttempt(
      settleableTask, authority, authority, drifted, suiteResult,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.value.kind !== "retry-required") throw new Error(JSON.stringify(result));
    expect(result.value.receipt).toMatchObject({ transition: "retry-required", semanticAttempt: 1 });
    expect(result.value.failures).toEqual(expect.arrayContaining([
      { kind: "proof-obligation-failure", failure: { kind: "attempt-scope-drifted" } },
      { kind: "proof-obligation-failure", failure: { kind: "declared-artifact-drifted", artifact: "src/a.ts" } },
    ]));
  });

  it("still demands the classified regression on an attestation task", () => {
    const noTests = {
      ...observation,
      evidence: observed({ testResult: undefined }),
    };
    const result = settleImplementationAttempt(
      settleableTask, authority, authority, noTests, suiteResult,
    );
    expect(result).toMatchObject({ ok: true });
    if (!result.ok || result.value.kind !== "retry-required") throw new Error(JSON.stringify(result));
    expect(result.value.failures).toContainEqual({
      kind: "proof-obligation-failure",
      failure: { kind: "test-result-missing" },
    });
  });
});
