import { match } from "ts-pattern";
import type { ImplementationLifecycleError } from "../../core/implementation-lifecycle";

/** Render typed lifecycle refusals only at the imperative-shell boundary. */
export const renderImplementationLifecycleError = (error: ImplementationLifecycleError): string =>
  match(error)
    .with({ kind: "task-not-pending" }, ({ taskId, status }) =>
      `Task ${taskId} has status ${status}; attestation applies only to pending Tasks with unsatisfied proof`)
    .with({ kind: "live-attempt", operation: "attestation" }, ({ taskId }) =>
      `Task ${taskId} carries a live implementation attempt; finish or settle it before attesting`)
    .with({ kind: "live-attempt", operation: "remediation" }, ({ taskId }) =>
      `Task ${taskId} carries a live implementation attempt; remediation requires a settled lineage`)
    .with({ kind: "invalid-lineage" }, ({ taskId, errors }) =>
      `Task ${taskId} has invalid attempt lineage: ${errors.join("; ")}`)
    .with({ kind: "terminal-escalation" }, ({ taskId }) =>
      `Task ${taskId} has a terminal implementation failure; remediate the escalation before attesting`)
    .with({ kind: "already-attested" }, ({ taskId }) =>
      `Task ${taskId} is already in attestation mode; nothing to attest`)
    .with({ kind: "proof-already-satisfied" }, ({ taskId }) =>
      `Task ${taskId} already carries satisfied proof; nothing to attest`)
    .with({ kind: "attestation-context-invalid" }, ({ taskId, detail }) =>
      `attestation context derivation failed for ${taskId}: ${detail}`)
    .with({ kind: "task-already-settled" }, ({ taskId, status }) =>
      `Task ${taskId} already reached ${status}; nothing to remediate`)
    .with({ kind: "not-escalated" }, ({ taskId, disposition }) =>
      `Task ${taskId} is no longer escalated (current disposition: ${disposition}); nothing to remediate`)
    .with({ kind: "terminal-receipt-mismatch" }, ({ taskId, expected, received }) =>
      `Task ${taskId}'s terminal escalation is receipt ${expected}, not ${received}; ` +
        "read the exact receipt from orchestration status and repeat")
    .with({ kind: "terminal-receipt-missing" }, ({ taskId, receiptId }) =>
      `terminal escalation receipt ${receiptId} is absent from Task ${taskId} history`)
    .with({ kind: "remediation-receipt-invalid" }, ({ errors }) => errors.join("; "))
    .exhaustive();
