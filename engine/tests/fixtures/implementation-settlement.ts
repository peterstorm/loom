import { derivePendingTaskProof, TRUSTED_LEDGER_ONLY_POLICY } from "../../src/core/proof-obligations";
import {
  createImplementationAttemptAuthority,
  settleImplementationAttempt,
  type ImplementationAttemptSettlementReceipt,
} from "../../src/core/implementation-completion";
import { labelledValue } from "./parse-result";
import { observedEvidence } from "./task-lifecycle";

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
  const authority = labelledValue("implementation settlement", createImplementationAttemptAuthority({
    taskId,
    wave: 1,
    semanticAttempt: attemptNumber,
    reservationId: `status-attempt-${attemptNumber}`,
    headSha: "a".repeat(40),
    reservedAt: `2026-09-01T00:00:0${attemptNumber}.000Z`,
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  }));
  const result = settleImplementationAttempt({
    id: taskId,
    status: "pending",
    proof: derivePendingTaskProof({ declaredArtifactExpectation: "changed", newTestsRequired: false, declaredArtifacts: [] }),
    active_implementation_attempt: authority,
    implementation_attempt_history: history,
  }, authority, authority, {
    schemaVersion: 1,
    kind: "implementation-observed",
    observedAt: `2026-09-01T00:01:0${attemptNumber}.000Z`,
    evidence: observedEvidence({
      taskCompleted: false,
      testResult: { verdict: "trusted-pass" },
      filesModified: [],
      newTestsWritten: false,
      newTestEvidence: "waived",
    }),
    proofEvaluationPolicy: TRUSTED_LEDGER_ONLY_POLICY,
  }, { kind: "accepted" });
  if (!result.ok || result.value.kind === "ignored") throw new Error("implementation settlement fixture failed");
  return result.value.receipt;
}
