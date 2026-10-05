/**
 * How one captured Wave reviewer transcript resolves against its Task's current
 * Review Packet, under the protocol the request was ISSUED with, and whether
 * that resolution counts as accepted packet evidence. Pure: the program volume
 * reads the captured bytes and the issued protocol; this decides.
 */
import type { Task } from "../types";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  parseReviewerEvidence,
  resolveIssuedTaskReviewFindings,
  resolveTaskReviewFindings,
  type IssuedWaveReviewerProtocol,
} from "./review-output";

export function resolveWaveReviewerTranscript(
  task: Task, agent: string, bytes: Uint8Array, protocol: IssuedWaveReviewerProtocol,
) {
  if (protocol.subject.taskId !== task.id || protocol.request.role !== agent ||
      task.review_run?.packet_id !== protocol.subject.packetId ||
      (task.review_generation ?? 0) !== protocol.subject.generation) {
    return { kind: "ignored-stale" as const, agent, message: "issued reviewer protocol differs from the current Task Review Packet" };
  }
  if (protocol.protocolVersion === 1) {
    const admitted = parseReviewerEvidence(protocol, bytes);
    // Only genuinely issued v1 may retain its original diagnostic/retry bytes.
    // Authority failure is never an invitation to the historical parser.
    if (admitted.ok || admitted.error.code === "legacy-evidence-failed") {
      return constrainReviewResolutionToScope(resolveTaskReviewFindings(
        Buffer.from(bytes).toString("utf8"), agent, task.review_run, task.review_generation,
      ), protocol.subject.scope);
    }
  }
  return resolveIssuedTaskReviewFindings(protocol, bytes);
}

/** Why a captured attempt did NOT produce accepted packet evidence, or `null`
 *  when it did (including the final valid slot that closes the roster). */
export function reviewerRejectionReason(
  task: Task, agent: string, bytes: Uint8Array, protocol: IssuedWaveReviewerProtocol,
): string | null {
  const resolution = resolveWaveReviewerTranscript(task, agent, bytes, protocol);
  if (resolution.kind === "evidence-failed" || resolution.kind === "ignored-stale") return resolution.message;
  const slot = task.review_run?.slot_authority?.find((candidate) => candidate.agent === agent);
  const applied = applyReviewResolution(task, resolution, slot);
  const accepted = applied.review_run?.evidence.some((evidence) => evidence.agent === agent) === true ||
    // A final valid slot closes the roster and `finalizeReviewRun` removes the
    // packet entirely. That terminal transition is acceptance, not rejection.
    (task.review_run !== undefined && applied.review_run === undefined &&
      applied.review_error === undefined && applied.review_status !== "evidence_capture_failed");
  if (accepted) return null;
  return applied.review_error ?? "attempt did not produce accepted packet evidence";
}
