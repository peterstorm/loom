import { derivePendingTaskProof, TRUSTED_LEDGER_ONLY_POLICY } from "../../src/core/proof-obligations";
import {
  TASK_BYTE_SCOPE_CHECK_ID_TEXT,
  createImplementationAttemptAuthority,
  createTaskCompletionSuiteAuthority,
  settleImplementationAttempt,
  type ImplementationAttemptSettlementReceipt,
} from "../../src/core/implementation-completion";

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`implementation settlement fixture failed: ${JSON.stringify(result.error)}`);
  return result.value;
};

/**
 * The real settlement receipt of one failed semantic implementation attempt
 * (the Task did not complete), minted through the production settlement core
 * so retry/escalation derivations see authentic history.
 */
export function semanticAttemptReceipt(
  taskId: string,
  attemptNumber: 1 | 2,
  history: readonly ImplementationAttemptSettlementReceipt[],
): ImplementationAttemptSettlementReceipt {
  const authority = unwrap(createImplementationAttemptAuthority({
    taskId,
    wave: 1,
    semanticAttempt: attemptNumber,
    reservationId: `status-attempt-${attemptNumber}`,
    headSha: "a".repeat(40),
    reservedAt: `2026-09-01T00:00:0${attemptNumber}.000Z`,
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  }));
  const suiteAuthority = unwrap(createTaskCompletionSuiteAuthority(authority));
  const result = settleImplementationAttempt({
    id: taskId,
    status: "pending",
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    active_implementation_attempt: authority,
    implementation_attempt_history: history,
  }, authority, authority, {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: `2026-09-01T00:01:0${attemptNumber}.000Z`,
    evidence: {
      taskCompleted: false,
      testResult: { verdict: "trusted-pass" },
      filesModified: [],
      newTestsWritten: false,
      newTestEvidence: "waived",
    },
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
  }, {
    schemaVersion: 1,
    kind: "task-completion-suite-result",
    implementationAuthorityDigest: suiteAuthority.implementationAuthorityDigest,
    suiteDigest: suiteAuthority.suiteDigest,
    checks: [{
      checkId: TASK_BYTE_SCOPE_CHECK_ID_TEXT,
      scope: "task",
      outcome: { kind: "accepted", changedPaths: [] },
    }],
  });
  if (!result.ok || result.value.kind === "ignored") throw new Error("implementation settlement fixture failed");
  return result.value.receipt;
}
