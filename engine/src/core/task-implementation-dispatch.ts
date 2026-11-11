import type { Task, WaveImplementationDispatch } from "../types";
import {
  deriveImplementationAttestationContext,
  deriveImplementationRetryDisposition,
} from "./implementation-retry";
import { distillPromptAppendix, isDistillTask } from "./distill-task";
import { canonicalRecord, type NonEmpty } from "./orchestration-contract";

export type TaskImplementationDispatchDerivation =
  | Readonly<{ kind: "dispatch"; dispatch: WaveImplementationDispatch }>
  | Readonly<{ kind: "escalated"; receiptId: string; failureKinds: NonEmpty<string> }>
  | Readonly<{ kind: "invalid-retry"; errors: NonEmpty<string> }>
  | Readonly<{ kind: "invalid-attestation"; error: string }>;

/**
 * The ONE derivation of what implementation dispatch a Task is owed, from its
 * protected settlement history: status projects it into the Wave recovery and
 * the implementation brief renders exactly it, so a rendered brief always
 * carries the appendix the spawn gate will authorize.
 *
 * Attestation Tasks bind their dispatch to the engine-derived attestation
 * context (digest over the stored attested obligation set + policy). The load
 * boundary proved mode/obligations/policy lockstep, so derivation can only
 * fail on an in-memory graph; either way no dispatch a child could not legally
 * be admitted on is emitted.
 *
 * A Distill Task's dispatch carries the fixed distill appendix (ADR-0068),
 * which the spawn gate binds as well. The appendices follow the retry context
 * in one order: attestation, then distill.
 */
export function deriveTaskImplementationDispatch(task: Task): TaskImplementationDispatchDerivation {
  const disposition = deriveImplementationRetryDisposition(task);
  if (disposition.kind === "invalid") return canonicalRecord({ kind: "invalid-retry" as const, errors: disposition.errors });
  if (disposition.kind === "escalated") {
    return canonicalRecord({
      kind: "escalated" as const,
      receiptId: disposition.receiptId,
      failureKinds: disposition.failureKinds,
    });
  }
  const appendices: string[] = [];
  if (task.implementation_attestation === true) {
    const attestation = deriveImplementationAttestationContext(task);
    if (!attestation.ok) return canonicalRecord({ kind: "invalid-attestation" as const, error: attestation.error });
    appendices.push(attestation.promptAppendix);
  }
  if (isDistillTask(task)) appendices.push(distillPromptAppendix(task));
  const dispatch: WaveImplementationDispatch = disposition.kind === "initial"
    ? canonicalRecord({
        kind: "initial-implementation",
        taskId: task.id,
        semanticAttempt: 1,
        promptAppendix: appendices.length === 0 ? null : appendices.join("\n"),
      })
    : canonicalRecord({
        kind: "retry-implementation",
        taskId: task.id,
        semanticAttempt: 2,
        promptAppendix: [disposition.promptAppendix, ...appendices].join("\n"),
      });
  return canonicalRecord({ kind: "dispatch" as const, dispatch });
}
