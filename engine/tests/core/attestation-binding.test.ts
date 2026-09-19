/**
 * Attestation dispatch binding: the engine-derived
 * `LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT` line, its derivation guards, and
 * `authorizeImplementationSpawn`'s require/forbid behavior on both the initial
 * and the retry arm.
 *
 * The binding is what makes an attestation child provable: a prompt carrying
 * the exact context line was written for exactly this Task's stored attested
 * obligation set and policy (the digest binds both), so a drifted proof cannot
 * ride an old appendix and a plain prompt cannot arm a verify-only child.
 */

import { describe, expect, it } from "vitest";
import {
  IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL,
  authorizeImplementationSpawn,
  createImplementationAttemptContext,
  deriveImplementationAttestationContext,
  deriveImplementationRetryDisposition,
  parseImplementationAttestationContext,
} from "../../src/core/implementation-retry";
import {
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  settleImplementationAttempt,
  type ImplementationAttemptAuthority,
  type ImplementationAttemptSettlementReceipt,
} from "../../src/core/implementation-completion";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import type { TaskProof } from "../../src/core/proof-obligations";
import type { VerificationPolicy } from "../../src/core/verification-policy";

const ATTESTED_POLICY: VerificationPolicy = Object.freeze({
  regression: Object.freeze({ kind: "required" as const }),
  newTests: Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" }),
});

const attestationProof = (): TaskProof =>
  derivePendingTaskProof({
    verificationPolicy: ATTESTED_POLICY,
    declaredArtifacts: ["src/a.ts"],
    declaredArtifactExpectation: "attested",
  });

const attestationTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "T1",
  implementation_attestation: true,
  proof: attestationProof(),
  verification_policy: {
    regression: { kind: "required" },
    new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
  },
  new_tests_required: false,
  ...overrides,
});

const attestationAppendix = (): string => {
  const derived = deriveImplementationAttestationContext(attestationTask() as never);
  if (!derived.ok) throw new Error(derived.error);
  return derived.promptAppendix;
};

/** A real parser-proven retry-required receipt for T1, minted the way the
 * existing retry suite mints them: settle a plain task with a completion claim
 * that fails its proof. */
const retryReceipt = (): ImplementationAttemptSettlementReceipt => {
  const attempt = attemptAuthority(1, "attest-retry-attempt");
  const suite = (() => {
    const built = createTaskCompletionSuiteAuthority(attempt);
    if (!built.ok) throw new Error(built.error.errors.join("; "));
    return built.value;
  })();
  const result = settleImplementationAttempt({
    id: "T1",
    status: "pending",
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    active_implementation_attempt: attempt,
    implementation_attempt_history: [],
  }, attempt, attempt, {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: "2026-09-19T00:02:00.000Z",
    evidence: { taskCompleted: false, testResult: { verdict: "trusted-pass" }, filesModified: [] },
    proofEvaluationPolicy: { untrustedPass: "reject" },
  }, {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: suite.implementationAuthorityDigest,
    suiteDigest: suite.suiteDigest,
    checks: [{ checkId: suite.checks[0].checkId, scope: "task", outcome: { kind: "accepted", changedPaths: [] } }],
  });
  if (!result.ok || result.value.kind !== "retry-required") throw new Error("retry receipt fixture failed");
  return result.value.receipt;
};

const attemptAuthority = (semanticAttempt: 1 | 2, reservationId: string): ImplementationAttemptAuthority => {
  const created = createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 1,
    semanticAttempt,
    reservationId: reservationId as never,
    headSha: "a".repeat(40),
    reservedAt: `2026-09-19T00:00:0${semanticAttempt}.000Z`,
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
};

describe("deriveImplementationAttestationContext", () => {
  it("derives a deterministic context whose digest binds the obligation set and policy", () => {
    const first = deriveImplementationAttestationContext(attestationTask() as never);
    const second = deriveImplementationAttestationContext(attestationTask() as never);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.context).toEqual(second.context);
    expect(first.promptAppendix).toBe(second.promptAppendix);
    expect(first.promptAppendix).toContain(IMPLEMENTATION_ATTESTATION_CONTEXT_LABEL);
    expect(first.context.taskId).toBe("T1");
    expect(first.context.attestationProofDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the digest when the attested obligation set changes", () => {
    const widened = deriveImplementationAttestationContext(attestationTask({
      proof: derivePendingTaskProof({
        verificationPolicy: ATTESTED_POLICY,
        declaredArtifacts: ["src/a.ts", "src/b.ts"],
        declaredArtifactExpectation: "attested",
      }),
    }) as never);
    const base = deriveImplementationAttestationContext(attestationTask() as never);
    expect(widened.ok && base.ok).toBe(true);
    if (!widened.ok || !base.ok) return;
    expect(widened.context.attestationProofDigest).not.toBe(base.context.attestationProofDigest);
  });

  it("refuses a task that is not in attestation mode, carries no proof, malformed proof, or changed arms", () => {
    expect(deriveImplementationAttestationContext({ id: "T1" })).toMatchObject({
      ok: false,
      error: "Task T1 is not in attestation mode",
    });
    expect(deriveImplementationAttestationContext(attestationTask({ proof: undefined }) as never))
      .toMatchObject({ ok: false, error: "Task T1 carries no attestation proof" });
    expect(deriveImplementationAttestationContext(attestationTask({ proof: { nonsense: true } }) as never))
      .toMatchObject({ ok: false, error: expect.stringContaining("malformed proof") });
    const changedProof = derivePendingTaskProof({
      verificationPolicy: ATTESTED_POLICY,
      declaredArtifacts: ["src/a.ts"],
      declaredArtifactExpectation: "changed",
    });
    expect(deriveImplementationAttestationContext(attestationTask({ proof: changedProof }) as never))
      .toMatchObject({
        ok: false,
        error: "Task T1 attestation proof carries declared-artifact-changed obligations; attestation requires the attested arm",
      });
  });

  it("refuses a malformed stored verification policy instead of throwing", () => {
    expect(deriveImplementationAttestationContext(attestationTask({
      verification_policy: { regression: { kind: "required" }, new_tests: { kind: "waived", reason: "bogus" } },
    }) as never)).toMatchObject({
      ok: false,
      error: expect.stringContaining("malformed verification policy"),
    });
  });

  it("round-trips through the context parser", () => {
    const derived = deriveImplementationAttestationContext(attestationTask() as never);
    if (!derived.ok) throw new Error(derived.error);
    const parsed = parseImplementationAttestationContext(derived.context);
    expect(parsed).toMatchObject({ ok: true, value: derived.context });
    expect(parseImplementationAttestationContext({ ...derived.context, extra: true }).ok).toBe(false);
    expect(parseImplementationAttestationContext({
      ...derived.context,
      attestationProofDigest: "z".repeat(64),
    }).ok).toBe(false);
  });
});

describe("authorizeImplementationSpawn — attestation binding", () => {
  const promptWith = (appendix: string | null, retryAppendix: string | null = null): string =>
    ["Implement Task T1.", appendix, retryAppendix].filter((line) => line !== null).join("\n");

  it("admits an initial attestation spawn only with the exact context line", () => {
    const appendix = attestationAppendix();
    expect(authorizeImplementationSpawn(attestationTask() as never, promptWith(appendix)))
      .toMatchObject({ ok: true, kind: "initial", semanticAttempt: 1 });
    expect(authorizeImplementationSpawn(attestationTask() as never, promptWith(null)))
      .toMatchObject({
        ok: false,
        error: "Task T1 is in attestation mode and requires the exact attestation context from orchestration status",
      });
    const tampered = promptWith(appendix.replace(/"taskId":"T1"/, "\"taskId\":\"T9\""));
    expect(authorizeImplementationSpawn(attestationTask() as never, tampered))
      .toMatchObject({
        ok: false,
        error: "Task T1 attestation context bytes do not match the stored attestation proof",
      });
  });

  it("refuses an attestation context on a task that is not in attestation mode", () => {
    const appendix = attestationAppendix();
    expect(authorizeImplementationSpawn({ id: "T1" }, promptWith(appendix)))
      .toMatchObject({
        ok: false,
        error: "Task T1 is not in attestation mode; refusing a caller-supplied attestation context",
      });
    expect(authorizeImplementationSpawn({ id: "T1" }, promptWith(null)))
      .toMatchObject({ ok: true, kind: "initial" });
  });

  it("requires the attestation line on the retry arm too, beside the byte-exact retry context", () => {
    const receipt = retryReceipt();
    const task = attestationTask({
      implementation_attempt_history: [receipt],
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
    });
    const disposition = deriveImplementationRetryDisposition(task as never);
    if (disposition.kind !== "retry") throw new Error("retry lineage fixture failed");
    const retryLine = disposition.promptAppendix;
    const appendix = attestationAppendix();

    // Retry line without the attestation line: refused.
    expect(authorizeImplementationSpawn(task as never, promptWith(null, retryLine))).toMatchObject({
      ok: false,
      error: "Task T1 is in attestation mode and requires the exact attestation context from orchestration status",
    });
    // Both lines: attempt 2 admitted.
    expect(authorizeImplementationSpawn(task as never, promptWith(appendix, retryLine))).toMatchObject({
      ok: true,
      kind: "retry",
      semanticAttempt: 2,
      predecessorReceiptId: receipt.receiptId,
    });
    // Tampered attestation line: refused even with the exact retry line.
    const tamperedAppendix = appendix.replace(/"taskId":"T1"/, "\"taskId\":\"T9\"");
    expect(authorizeImplementationSpawn(task as never, promptWith(tamperedAppendix, retryLine)))
      .toMatchObject({ ok: false });
  });

  it("attempt context creation still binds the admitted prompt bytes", () => {
    const appendix = attestationAppendix();
    const prompt = promptWith(appendix);
    const admission = authorizeImplementationSpawn(attestationTask() as never, prompt);
    expect(admission).toMatchObject({ ok: true });
    if (!admission.ok) return;
    const authority = {
      schemaVersion: 1,
      kind: "implementation-attempt-authority",
      taskId: "T1",
      wave: 1,
      semanticAttempt: 1,
      reservationId: "attest-bind-attempt",
      headSha: "1".repeat(40),
      reservedAt: "2026-09-19T00:00:00.000Z",
      taskScopeBaselineDigest: "a".repeat(64),
      dirtySetBaselineDigest: "b".repeat(64),
      authorityDigest: "c".repeat(64),
    };
    const context = createImplementationAttemptContext({
      authority: authority as never,
      prompt,
      admission,
    });
    expect(context.promptDigest).toBe(admission.promptDigest);
    expect(context.retryContext).toBeNull();
    // A different prompt (no appendix) cannot mint the same context.
    expect(() => createImplementationAttemptContext({
      authority: authority as never,
      prompt: promptWith(null),
      admission,
    })).toThrow(/prompt does not match admitted prompt bytes/);
  });
});
