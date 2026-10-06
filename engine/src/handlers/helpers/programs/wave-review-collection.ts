/**
 * Collecting the current Wave review batch's attempt-1 evidence: classify
 * every issued request's packet membership once, reconcile durably captured
 * transcripts, terminalize durable capture rejections into typed evidence
 * failures, and re-issue only genuinely undelivered attempt-1 requests.
 */
import type { AgentRequestAuthority } from '../../../core/orchestration-contract';
import { captureKey } from '../../../core/harness-capture';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import type { StateManager } from '../../../state-manager';
import { applyReviewResolution } from '../../../core/review-output';
import { specCheckNeedsReapplication } from '../../../core/spec-check';
import { applyCurrentSpecCheckCaptureRejection, specCheckSlotBelongsToWaveEpoch, waveReviewerSlotProblem } from '../../../core/wave-gate-membership';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import { durableCaptureRejection } from './durable-requests';
import { renderReviewProgramSpawnTask } from './spawn-task';
import { proceed, settled, waveBlocked, type WavePhase } from './wave-gate-outcome';
import { applyWaveFacadeSubmission } from './wave-gate-submission';
import { issuedWaveProtocol, readWaveRequestContext } from './wave-review-context';
import type { IssuedWaveReviewBatch } from './wave-review-requests';

/** Resume phase: settle the current batch's attempt-1 evidence, spawning any
 *  undelivered attempt-1 request; proceeds once none remains outstanding.
 *  `wave` is the caller's narrowed `registration.input.wave` and the only
 *  Wave this phase reads. */
export async function reconcileCurrentReviewEvidence(
  handle: RunDirHandle,
  manager: StateManager,
  registration: RegisteredWaveGateProgram,
  batch: IssuedWaveReviewBatch,
  captured: ReadonlySet<string>,
  wave: number,
): Promise<WavePhase> {
  const { refreshed, currentRuns, currentIssued } = batch;
  // Read and classify every current context once. Packet-membership filters
  // consume this cache rather than translating a later I/O failure into
  // `absent` or racing a second read against the pre-scan.
  const currentPacketMembership = new Map<string, boolean>();
  for (const authority of currentIssued.filter((request) => request.program === "wave-gate")) {
    const read = readWaveRequestContext(handle, authority);
    if (!read.ok) return settled(read.result);
    const context = read.context;
    if (context.kind === "absent") {
      currentPacketMembership.set(authority.requestId, false);
      continue;
    }
    if (authority.role === "spec-check-invoker") {
      currentPacketMembership.set(
        authority.requestId,
        specCheckSlotBelongsToWaveEpoch(refreshed, authority, context.value),
      );
      continue;
    }
    const taskRun = context.value.taskRun;
    const task = taskRun === null ? undefined : currentRuns.find(({ id }) => id === taskRun.taskId);
    currentPacketMembership.set(
      authority.requestId,
      task !== undefined && waveReviewerSlotProblem(
        refreshed, task, context.value, issuedWaveProtocol(handle, registration, authority),
      ) === null,
    );
  }
  const belongsToCurrentPacket = (request: AgentRequestAuthority): boolean =>
    currentPacketMembership.get(request.requestId) === true;

  // Transcript capture is durable before semantic application. Reconcile the
  // crash window idempotently under exact current packet/slot authority.
  for (const request of currentIssued.filter((authority) => authority.program === "wave-gate" &&
    belongsToCurrentPacket(authority) && captured.has(captureKey(authority.slotId, authority.attempt)))) {
    const now = manager.load();
    if (request.role === "spec-check-invoker" &&
        !specCheckNeedsReapplication(now.spec_check, wave)) continue;
    const read = readWaveRequestContext(handle, request);
    if (!read.ok) return settled(read.result);
    const context = read.context;
    const taskId = context.kind === "loaded" ? context.value.taskRun?.taskId : undefined;
    if (request.role !== "spec-check-invoker") {
      const task = now.tasks.find(({ id }) => id === taskId);
      if (task?.review_run === undefined || task.review_run.evidence.some(({ agent }) => agent === request.role)) continue;
    }
    const bytes = handle.readTranscriptBytes(request);
    if (!bytes.ok) return settled(waveBlocked(handle, bytes.error.message));
    const applied = await applyWaveFacadeSubmission(handle, request, bytes.value);
    if (!applied.ok) return settled(waveBlocked(handle, `captured Wave evidence could not be reconciled: ${applied.message}`));
  }

  // A durable harness capture rejection is a completed FAILED semantic
  // attempt, not an invitation to respawn attempt 1 forever. Terminalize the
  // slot and project a typed evidence failure so ordinary attempt-2 recovery
  // issues the diagnostic-rich retry.
  for (const request of currentIssued.filter((authority) => authority.program === "wave-gate" && authority.attempt === 1 &&
    belongsToCurrentPacket(authority) && !captured.has(captureKey(authority.slotId, authority.attempt)))) {
    const rejection = await durableCaptureRejection(handle, request);
    if (rejection === null) continue;
    const terminal = await handle.rejectCapture(request, rejection);
    if (!terminal.ok) return settled(waveBlocked(handle, terminal.error.message));
    const read = readWaveRequestContext(handle, request);
    if (!read.ok) return settled(read.result);
    const context = read.context;
    if (request.role === "spec-check-invoker") {
      if (context.kind !== "loaded") {
        return settled(waveBlocked(handle, "rejected spec-check request lacks exact Wave authority"));
      }
      const runAt = new Date().toISOString();
      await manager.updateAndReturn((locked) => {
        const applied = applyCurrentSpecCheckCaptureRejection(
          locked,
          request,
          context.value,
          "durable capture rejection: no transcript was captured - re-run /wave-gate",
          runAt,
        );
        return { state: applied.state, value: applied.applied };
      });
    } else {
      const taskRun = context.kind === "loaded" ? context.value.taskRun : null;
      if (context.kind !== "loaded" || taskRun === null) {
        return settled(waveBlocked(handle, "rejected reviewer request lacks exact Task authority"));
      }
      const protocol = issuedWaveProtocol(handle, registration, request);
      await manager.update((locked) => {
        const target = locked.tasks.find(({ id }) => id === taskRun.taskId);
        if (target === undefined || waveReviewerSlotProblem(locked, target, context.value, protocol) !== null) return locked;
        const slot = target.review_run?.slot_authority?.find(({ agent }) => agent === request.role);
        const resolution = {
          kind: "evidence-failed" as const,
          agent: request.role,
          message: `attempt 1 capture rejected: ${rejection}`,
        };
        return {
          ...locked,
          tasks: locked.tasks.map((task) => task.id === taskRun.taskId
            ? applyReviewResolution(task, resolution, slot)
            : task),
        };
      });
    }
  }

  // Only current Wave review requests may outrank Review Packet recovery.
  // Refutation requests are resumed later, after every packet has closed.
  const rejectedInitials = new Set<string>();
  for (const request of currentIssued.filter((authority) => authority.program === "wave-gate" && authority.attempt === 1)) {
    if (await durableCaptureRejection(handle, request) !== null) rejectedInitials.add(request.requestId);
  }
  const settledSpecCheck = refreshed.spec_check?.wave === wave &&
    refreshed.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED";
  const uncapturedInitialReviews = currentIssued.filter((request) => request.program === "wave-gate" && request.attempt === 1 &&
    belongsToCurrentPacket(request) && !(request.role === "spec-check-invoker" && settledSpecCheck) &&
    !captured.has(captureKey(request.slotId, request.attempt)) &&
    !rejectedInitials.has(request.requestId));
  if (uncapturedInitialReviews.length > 0) {
    return settled({ ok: true, action: {
      kind: "spawn-batch", runId: handle.runId,
      requests: uncapturedInitialReviews.map((authority) => ({
        authority,
        context: { digest: authority.contextDigest, slot: { kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` } },
        task: renderReviewProgramSpawnTask(handle, authority, "Read the immutable context packet at LOOM_CONTEXT_PATH and complete the exact Wave review request.", registration),
      })),
    } });
  }
  return proceed();
}
