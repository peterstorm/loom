/**
 * An attestation drift (an attested attempt that changed bytes) is terminal by
 * what the receipt records, not by the Task's current flag. Reopening clears
 * `implementation_attestation` (task-revalidation), and the lineage that
 * escalated on a drift and was remediated must still replay as valid after.
 */
import { describe, expect, it } from "vitest";
import {
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  createEscalationRemediationReceipt,
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  settleImplementationAttempt,
  type ImplementationAttemptSettlementReceipt,
} from "../../src/core/implementation-completion";
import { deriveImplementationRetryDisposition } from "../../src/core/implementation-retry";
import { derivePendingTaskProof, TRUSTED_LEDGER_ONLY_POLICY } from "../../src/core/proof-obligations";
import { semanticAttemptReceipt } from "../fixtures/implementation-settlement";
import { labelledValue } from "../fixtures/parse-result";
import { observedEvidence } from "../fixtures/task-lifecycle";

const TASK = "T7";
const FILE = "src/a.ts";
const attestedProof = () => derivePendingTaskProof({
  verificationPolicy: { regression: { kind: "required" }, newTests: { kind: "waived", reason: "existing-tests-sufficient" } },
  declaredArtifacts: [FILE],
  declaredArtifactExpectation: "attested",
});

/** The real receipt of an attested attempt 1 that wrote its declared file: attestation drift. */
function driftReceipt(): ImplementationAttemptSettlementReceipt {
  const authority = labelledValue("drift settlement", createImplementationAttemptAuthority({
    taskId: TASK, wave: 1, semanticAttempt: 1, reservationId: "status-attempt-1", headSha: "a".repeat(40),
    reservedAt: "2026-09-01T00:00:01.000Z", taskScopeBaseline: [], dirtySetBaseline: [],
  }));
  const suite = labelledValue("drift settlement", createTaskCompletionSuiteAuthority(authority));
  const result = settleImplementationAttempt({
    id: TASK, status: "pending", proof: attestedProof(),
    active_implementation_attempt: authority, implementation_attempt_history: [],
  }, authority, authority, {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: "2026-09-01T00:01:01.000Z",
    evidence: observedEvidence({
      taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: [FILE],
      newTestsWritten: false, newTestEvidence: "waived",
    }),
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
  }, {
    schemaVersion: 1, kind: "task-completion-suite-result",
    implementationAuthorityDigest: suite.implementationAuthorityDigest, suiteDigest: suite.suiteDigest,
    checks: [{ checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT, scope: "task", outcome: { kind: "accepted", changedPaths: [FILE] } }],
  });
  if (!result.ok || result.value.kind === "ignored") throw new Error("drift settlement fixture failed");
  return result.value.receipt;
}

/** The drift, then the operator's remediation of it. */
function remediatedDriftHistory(): readonly ImplementationAttemptSettlementReceipt[] {
  const drift = driftReceipt();
  const remediation = createEscalationRemediationReceipt({
    taskId: TASK, reservationId: "remediation-1", authorityDigest: drift.authorityDigest,
    observedAt: "2026-09-01T00:02:00.000Z", failureKinds: drift.failureKinds,
  });
  if (!remediation.ok) throw new Error("remediation fixture failed");
  return [drift, remediation.value];
}

const task = (attested: boolean) => ({
  id: TASK,
  implementation_attempt_history: remediatedDriftHistory(),
  implementation_retry_protocol: 2 as const,
  implementation_retry_history_start: 0,
  ...(attested ? { implementation_attestation: true as const } : {}),
});

describe("an attestation drift is terminal by its receipt", () => {
  it("records the drift as a retry-required settlement with drift failure kinds", () => {
    const drift = driftReceipt();
    expect(drift.transition).toBe("retry-required");
    expect(drift.failureKinds.some((kind) => kind.includes("drifted"))).toBe(true);
  });

  it("replays a remediated drift as a fresh attempt 1 while the Task is attested", () => {
    expect(deriveImplementationRetryDisposition(task(true)).kind).toBe("initial");
  });

  it("still replays it as valid once reopening has cleared the attestation flag", () => {
    expect(deriveImplementationRetryDisposition(task(false)).kind).toBe("initial");
  });

  it("escalates an unremediated drift even without the attestation flag", () => {
    const drift = driftReceipt();
    const disposition = deriveImplementationRetryDisposition({
      id: TASK, implementation_attempt_history: [drift],
      implementation_retry_protocol: 2, implementation_retry_history_start: 0,
    });
    expect(disposition).toMatchObject({ kind: "escalated", receiptId: drift.receiptId, failureKinds: drift.failureKinds });
  });

  it("keeps an ordinary failure on a non-attested Task a retry", () => {
    const failure = semanticAttemptReceipt(TASK, 1, []);
    expect(failure.failureKinds.some((kind) => kind.includes("drifted"))).toBe(false);
    const disposition = deriveImplementationRetryDisposition({
      id: TASK, implementation_attempt_history: [failure],
      implementation_retry_protocol: 2, implementation_retry_history_start: 0,
    });
    expect(disposition.kind).toBe("retry");
    if (disposition.kind === "retry") expect(disposition.context.predecessorReceiptId).toBe(failure.receiptId);
  });
});
