import type { Task } from "../types";
import { createEscalationRemediationReceipt, type ImplementationAttemptSettlementReceipt } from "./implementation-completion";
import {
  deriveImplementationAttestationContext,
  deriveImplementationRetryDisposition,
} from "./implementation-retry";
import { derivePendingTaskProof, type PendingTaskProof } from "./proof-obligations";
import { canonicalJson, sha256Hex } from "./review-packet";
import {
  serializeVerificationPolicy,
  type VerificationPolicy,
} from "./verification-policy";

export const ATTESTATION_VERIFICATION_POLICY: VerificationPolicy = Object.freeze({
  regression: Object.freeze({ kind: "required" }),
  newTests: Object.freeze({ kind: "waived", reason: "existing-tests-sufficient" }),
});

export type AttestationPlan = Readonly<{
  taskId: string;
  obligations: readonly string[];
  attestationProofDigest: string;
  promptAppendix: string;
}>;

export type AttestationCommand = Readonly<{
  task: Task;
  plan: AttestationPlan;
}>;

const attestedProofFor = (task: Task): PendingTaskProof =>
  derivePendingTaskProof({
    verificationPolicy: ATTESTATION_VERIFICATION_POLICY,
    declaredArtifacts: task.file_list ?? [],
    declaredArtifactExpectation: "attested",
  });

export function attestedTask(task: Task): Task {
  return Object.freeze({
    ...task,
    status: "pending",
    implementation_attestation: true,
    verification_policy: serializeVerificationPolicy(ATTESTATION_VERIFICATION_POLICY),
    new_tests_required: undefined,
    proof: attestedProofFor(task),
    revalidation_required: undefined,
    legacy_missing_proof: undefined,
  });
}

/** Pure aggregate command: eligibility, rewritten Task and audit plan are one result. */
export function armImplementationAttestation(
  task: Task,
  input: Readonly<{ executing: boolean }>,
): Readonly<{ ok: true; value: AttestationCommand }> | Readonly<{ ok: false; message: string }> {
  if (task.status !== "pending") {
    return { ok: false, message: `Task ${task.id} has status ${task.status}; attestation applies only to pending Tasks with unsatisfied proof` };
  }
  if (task.active_implementation_attempt !== undefined || task.reserved_at !== undefined || input.executing) {
    return { ok: false, message: `Task ${task.id} carries a live implementation attempt; finish or settle it before attesting` };
  }
  const disposition = deriveImplementationRetryDisposition(task);
  if (disposition.kind === "invalid") {
    return { ok: false, message: `Task ${task.id} has invalid attempt lineage: ${disposition.errors.join("; ")}` };
  }
  if (disposition.kind === "escalated") {
    return { ok: false, message: `Task ${task.id} has a terminal implementation failure; remediate the escalation before attesting` };
  }
  if (task.implementation_attestation === true) {
    return { ok: false, message: `Task ${task.id} is already in attestation mode; nothing to attest` };
  }
  if (task.proof?.state === "satisfied") {
    return { ok: false, message: `Task ${task.id} already carries satisfied proof; nothing to attest` };
  }
  const rewritten = attestedTask(task);
  const context = deriveImplementationAttestationContext(rewritten);
  if (!context.ok) return { ok: false, message: `attestation context derivation failed for ${task.id}: ${context.error}` };
  const proof = attestedProofFor(task);
  return {
    ok: true,
    value: Object.freeze({
      task: rewritten,
      plan: Object.freeze({
        taskId: task.id,
        obligations: Object.freeze(proof.obligations.map((obligation) =>
          "artifact" in obligation ? `${obligation.kind}:${obligation.artifact}` : obligation.kind)),
        attestationProofDigest: context.context.attestationProofDigest,
        promptAppendix: context.promptAppendix,
      }),
    }),
  };
}

export type RemediationPlan = Readonly<{
  taskId: string;
  terminalReceiptId: string;
  terminalAuthorityDigest: string;
  failureKinds: readonly [string, ...string[]];
}>;

export function planEscalationRemediation(
  task: Task,
  input: Readonly<{ executing: boolean; terminalReceiptId: string }>,
): Readonly<{ ok: true; value: RemediationPlan }> | Readonly<{ ok: false; message: string }> {
  if (task.status === "completed" || task.status === "implemented") {
    return { ok: false, message: `Task ${task.id} already reached ${task.status}; nothing to remediate` };
  }
  if (task.active_implementation_attempt !== undefined || task.reserved_at !== undefined || input.executing) {
    return { ok: false, message: `Task ${task.id} carries a live implementation attempt; remediation requires a settled lineage` };
  }
  const disposition = deriveImplementationRetryDisposition(task);
  if (disposition.kind === "invalid") {
    return { ok: false, message: `Task ${task.id} has invalid attempt lineage: ${disposition.errors.join("; ")}` };
  }
  if (disposition.kind !== "escalated") {
    return { ok: false, message: `Task ${task.id} is no longer escalated (current disposition: ${disposition.kind}); nothing to remediate` };
  }
  if (disposition.receiptId !== input.terminalReceiptId) {
    return {
      ok: false,
      message: `Task ${task.id}'s terminal escalation is receipt ${disposition.receiptId}, not ${input.terminalReceiptId}; ` +
        "read the exact receipt from orchestration status and repeat",
    };
  }
  const terminal = (task.implementation_attempt_history ?? [])
    .find((receipt) => receipt.receiptId === input.terminalReceiptId);
  if (terminal === undefined) {
    return { ok: false, message: `terminal escalation receipt ${input.terminalReceiptId} is absent from Task ${task.id} history` };
  }
  return {
    ok: true,
    value: Object.freeze({
      taskId: task.id,
      terminalReceiptId: input.terminalReceiptId,
      terminalAuthorityDigest: terminal.authorityDigest,
      failureKinds: disposition.failureKinds,
    }),
  };
}

export type EscalationRemediationCommand = Readonly<{
  task: Task;
  plan: RemediationPlan;
  receipt: ImplementationAttemptSettlementReceipt;
}>;

/** Pure aggregate command: terminal eligibility, exact receipt and updated Task are inseparable. */
export function remediateImplementationEscalation(
  task: Task,
  input: Readonly<{ executing: boolean; terminalReceiptId: string; observedAt: string }>,
): Readonly<{ ok: true; value: EscalationRemediationCommand }> | Readonly<{ ok: false; message: string }> {
  const plan = planEscalationRemediation(task, input);
  if (!plan.ok) return plan;
  const reservationId = `remediation-${sha256Hex(canonicalJson({
    kind: "escalation-remediation",
    taskId: task.id,
    terminalReceiptId: input.terminalReceiptId,
    observedAt: input.observedAt,
  }))}`;
  const receipt = createEscalationRemediationReceipt({
    taskId: task.id,
    reservationId,
    authorityDigest: plan.value.terminalAuthorityDigest,
    observedAt: input.observedAt,
    failureKinds: plan.value.failureKinds,
  });
  if (!receipt.ok) return { ok: false, message: receipt.error.errors.join("; ") };
  return {
    ok: true,
    value: Object.freeze({
      task: Object.freeze({
        ...task,
        implementation_attempt_history: Object.freeze([
          ...(task.implementation_attempt_history ?? []),
          receipt.value,
        ]),
      }),
      plan: plan.value,
      receipt: receipt.value,
    }),
  };
}
