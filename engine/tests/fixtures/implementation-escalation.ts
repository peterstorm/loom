import {
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  settleImplementationAttempt,
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  type ImplementationAttemptSettlementReceipt,
} from "../../src/core/implementation-completion";
import { TRUSTED_LEDGER_ONLY_POLICY, derivePendingTaskProof } from "../../src/core/proof-obligations";

const valueOf = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("implementation escalation fixture construction failed");
  return result.value;
};

const authority = (semanticAttempt: 1 | 2, reservationId: string, second: number) =>
  valueOf(createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 1,
    semanticAttempt,
    reservationId,
    headSha: "a".repeat(40),
    reservedAt: `2026-09-01T00:00:${String(second).padStart(2, "0")}.000Z`,
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  }));

const suite = (attempt: ReturnType<typeof authority>) => {
  const authorized = valueOf(createTaskCompletionSuiteAuthority(attempt));
  return {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: authorized.implementationAuthorityDigest,
    suiteDigest: authorized.suiteDigest,
    checks: [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "accepted", changedPaths: [] },
    }],
  };
};

const observation = (observedAt: string) => ({
  schemaVersion: 1,
  kind: "implementation-observed",
  observedAt,
  evidence: {
    taskCompleted: false,
    testResult: { verdict: "trusted-pass" },
    filesModified: [],
    newTestsWritten: false,
    newTestEvidence: "waived",
  },
  proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
});

const settle = (
  attempt: ReturnType<typeof authority>,
  history: readonly ImplementationAttemptSettlementReceipt[],
  observedAt: string,
): ImplementationAttemptSettlementReceipt => {
  const result = settleImplementationAttempt({
    id: "T1",
    status: "pending",
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    active_implementation_attempt: attempt,
    implementation_attempt_history: history,
  }, attempt, attempt, observation(observedAt), suite(attempt));
  if (!result.ok || result.value.kind === "ignored") {
    throw new Error("implementation escalation fixture settlement failed");
  }
  return result.value.receipt;
};

export function implementationEscalatedLineage(): Readonly<{
  retry: ImplementationAttemptSettlementReceipt;
  escalation: ImplementationAttemptSettlementReceipt;
}> {
  const retry = settle(authority(1, "rsv-retry", 1), [], "2026-09-01T00:01:00.000Z");
  const escalation = settle(authority(2, "rsv-escalate", 2), [retry], "2026-09-01T00:02:00.000Z");
  return Object.freeze({ retry, escalation });
}

export function implementationEscalatedTaskFields(): Readonly<Record<string, unknown>> {
  const { retry, escalation } = implementationEscalatedLineage();
  return Object.freeze({
    implementation_attempt_history: Object.freeze([retry, escalation]),
    implementation_retry_protocol: 2,
    implementation_retry_history_start: 0,
    terminal_receipt: escalation.receiptId,
  });
}
