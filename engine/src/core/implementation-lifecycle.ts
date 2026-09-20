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

export type ImplementationLifecycleError =
  | Readonly<{ kind: "task-not-pending"; taskId: string; status: Task["status"] }>
  | Readonly<{ kind: "live-attempt"; taskId: string; operation: "attestation" | "remediation" }>
  | Readonly<{ kind: "invalid-lineage"; taskId: string; errors: readonly string[] }>
  | Readonly<{ kind: "terminal-escalation"; taskId: string }>
  | Readonly<{ kind: "already-attested"; taskId: string }>
  | Readonly<{ kind: "proof-already-satisfied"; taskId: string }>
  | Readonly<{ kind: "attestation-context-invalid"; taskId: string; detail: string }>
  | Readonly<{ kind: "task-already-settled"; taskId: string; status: "completed" | "implemented" }>
  | Readonly<{ kind: "not-escalated"; taskId: string; disposition: string }>
  | Readonly<{ kind: "terminal-receipt-mismatch"; taskId: string; expected: string; received: string }>
  | Readonly<{ kind: "terminal-receipt-missing"; taskId: string; receiptId: string }>
  | Readonly<{ kind: "remediation-receipt-invalid"; taskId: string; errors: readonly string[] }>;

type LifecycleResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ImplementationLifecycleError }>;

const lifecycleFailure = (error: ImplementationLifecycleError): Readonly<{ ok: false; error: ImplementationLifecycleError }> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

const attestedProofFor = (task: Task): PendingTaskProof =>
  derivePendingTaskProof({
    verificationPolicy: ATTESTATION_VERIFICATION_POLICY,
    declaredArtifacts: task.file_list ?? [],
    declaredArtifactExpectation: "attested",
  });

function attestedTask(task: Task, proof: PendingTaskProof): Task {
  return Object.freeze({
    ...task,
    status: "pending",
    implementation_attestation: true,
    verification_policy: serializeVerificationPolicy(ATTESTATION_VERIFICATION_POLICY),
    new_tests_required: undefined,
    proof,
    revalidation_required: undefined,
    legacy_missing_proof: undefined,
  });
}

/** Pure aggregate command: eligibility, rewritten Task and audit plan are one result. */
export function armImplementationAttestation(
  task: Task,
  input: Readonly<{ executing: boolean }>,
): LifecycleResult<AttestationCommand> {
  if (task.status !== "pending") {
    return lifecycleFailure({ kind: "task-not-pending", taskId: task.id, status: task.status });
  }
  if (task.active_implementation_attempt !== undefined || task.reserved_at !== undefined || input.executing) {
    return lifecycleFailure({ kind: "live-attempt", taskId: task.id, operation: "attestation" });
  }
  const disposition = deriveImplementationRetryDisposition(task);
  if (disposition.kind === "invalid") {
    return lifecycleFailure({ kind: "invalid-lineage", taskId: task.id, errors: Object.freeze([...disposition.errors]) });
  }
  if (disposition.kind === "escalated") {
    return lifecycleFailure({ kind: "terminal-escalation", taskId: task.id });
  }
  if (task.implementation_attestation === true) {
    return lifecycleFailure({ kind: "already-attested", taskId: task.id });
  }
  if (task.proof?.state === "satisfied") {
    return lifecycleFailure({ kind: "proof-already-satisfied", taskId: task.id });
  }
  const proof = attestedProofFor(task);
  const rewritten = attestedTask(task, proof);
  const context = deriveImplementationAttestationContext(rewritten);
  if (!context.ok) {
    return lifecycleFailure({ kind: "attestation-context-invalid", taskId: task.id, detail: context.error });
  }
  return Object.freeze({
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
  });
}

export type RemediationPlan = Readonly<{
  taskId: string;
  terminalReceiptId: string;
  terminalAuthorityDigest: string;
  failureKinds: readonly [string, ...string[]];
}>;

function escalationRemediationPlan(
  task: Task,
  input: Readonly<{ executing: boolean; terminalReceiptId: string }>,
): LifecycleResult<RemediationPlan> {
  if (task.status === "completed" || task.status === "implemented") {
    return lifecycleFailure({ kind: "task-already-settled", taskId: task.id, status: task.status });
  }
  if (task.active_implementation_attempt !== undefined || task.reserved_at !== undefined || input.executing) {
    return lifecycleFailure({ kind: "live-attempt", taskId: task.id, operation: "remediation" });
  }
  const disposition = deriveImplementationRetryDisposition(task);
  if (disposition.kind === "invalid") {
    return lifecycleFailure({ kind: "invalid-lineage", taskId: task.id, errors: Object.freeze([...disposition.errors]) });
  }
  if (disposition.kind !== "escalated") {
    return lifecycleFailure({ kind: "not-escalated", taskId: task.id, disposition: disposition.kind });
  }
  if (disposition.receiptId !== input.terminalReceiptId) {
    return lifecycleFailure({
      kind: "terminal-receipt-mismatch",
      taskId: task.id,
      expected: disposition.receiptId,
      received: input.terminalReceiptId,
    });
  }
  const terminal = (task.implementation_attempt_history ?? [])
    .find((receipt) => receipt.receiptId === input.terminalReceiptId);
  if (terminal === undefined) {
    return lifecycleFailure({ kind: "terminal-receipt-missing", taskId: task.id, receiptId: input.terminalReceiptId });
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      taskId: task.id,
      terminalReceiptId: input.terminalReceiptId,
      terminalAuthorityDigest: terminal.authorityDigest,
      failureKinds: disposition.failureKinds,
    }),
  });
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
): LifecycleResult<EscalationRemediationCommand> {
  const plan = escalationRemediationPlan(task, input);
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
  if (!receipt.ok) {
    return lifecycleFailure({
      kind: "remediation-receipt-invalid",
      taskId: task.id,
      errors: Object.freeze([...receipt.error.errors]),
    });
  }
  return Object.freeze({
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
  });
}
