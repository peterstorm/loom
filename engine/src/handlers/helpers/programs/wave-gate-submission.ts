/**
 * Applying one captured Wave Gate transcript to protected state: a spec-check
 * settles the current epoch's spec-check evidence; a reviewer transcript
 * resolves against its Task's exact current Review Packet slot. Membership is
 * re-judged under the state lock; the captured bytes are re-read, never
 * trusted from a caller's decoded string.
 */
import type { AgentRequestAuthority } from '../../../core/orchestration-contract';
import { observeTaskGraphProjectBoundary, TASK_GRAPH_PATH } from '../../../config';
import { StateManager } from '../../../state-manager';
import { observeWaveSpecCheckDocuments } from '../../../orchestration/wave-spec-check-documents';
import { applyReviewResolution } from '../../../core/review-output';
import { parseSpecCheckOutput, settleSpecCheck, specCheckAuthorityProblem } from '../../../core/spec-check';
import { reconcileWaveBlock } from '../../../core/wave-gate-model';
import { epochSettledFloor, readWaveReviewContext, waveSpecCheckDocumentsMatch } from '../../../core/wave-review-authority';
import { waveReviewerSlotProblem } from '../../../core/wave-gate-membership';
import { resolveWaveReviewerTranscript } from '../../../core/wave-reviewer-transcript';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { reportUncaughtWaveGateFailure } from './wave-gate-outcome';
import { issuedWaveProtocol, readRegisteredWaveProgram } from './wave-review-context';

type WaveFacadeSubmissionResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; message: string }>;

export async function applyWaveFacadeSubmission(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  raw: string | Uint8Array,
): Promise<WaveFacadeSubmissionResult> {
  try {
    const packet = handle.readContext(authority.contextDigest);
    if (!packet.ok) return { ok: false, message: packet.error.message };
    const parsedContext = readWaveReviewContext([packet.value], authority.contextDigest);
    if (parsedContext.kind === "absent") return { ok: false, message: "Wave request context lacks subject authority" };
    if (parsedContext.kind === "corrupt") return { ok: false, message: parsedContext.message };
    const context = parsedContext.value;
    if (context.subject.role !== authority.role || context.runId !== authority.runId) {
      return { ok: false, message: "Wave request role drifted from immutable subject authority" };
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    if (authority.role === "spec-check-invoker") {
      const specCheckDocuments = context.specCheckDocuments;
      if (specCheckDocuments === null) {
        return { ok: false, message: "Wave spec-check request predates byte-bound document authority" };
      }
      const currentObservation = observeWaveSpecCheckDocuments({
        specFile: specCheckDocuments.spec.path,
        planFile: specCheckDocuments.plan.path,
        projectBoundary: observeTaskGraphProjectBoundary(manager.getPath()),
      });
      const currentDocuments = currentObservation.authority;
      const parsed = parseSpecCheckOutput(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
      const wave = context.wave;
      const batchEpoch = context.batchEpoch;
      return manager.updateAndReturn<WaveFacadeSubmissionResult>((locked) => {
        const epoch = locked.wave_review_epoch;
        const capabilityProblem = specCheckAuthorityProblem(
          locked,
          authority,
          specCheckDocuments,
        );
        if (capabilityProblem !== null || locked.current_wave !== wave ||
            locked.active_wave_gate?.authorityDigest !== context.authorityDigest ||
            epoch?.wave !== wave || epoch.batchEpoch !== batchEpoch ||
            !waveSpecCheckDocumentsMatch(currentDocuments, specCheckDocuments)) {
          const expected = `${locked.current_wave}/${locked.active_wave_gate?.runId ?? "none"}/${locked.active_wave_gate?.authorityDigest ?? "none"}/${epoch?.runId ?? "none"}/${epoch?.wave ?? "none"}/${(epoch?.batchEpoch ?? "none").slice(0, 12)}`;
          const message = `Wave spec-check request ${authority.requestId} does not belong to the exact current review epoch (expected current_wave/runId/digest/epoch-runId/epoch-wave/epoch-batch: ${expected}; request wave ${wave}, digest ${context.authorityDigest}, runId ${authority.runId}, batch ${batchEpoch.slice(0, 12)})`;
          return { state: locked, value: { ok: false as const, message } };
        }
        // The aggregate command updates captured evidence and its derived Wave
        // block together, using only floor authority from this exact epoch.
        const state = settleSpecCheck(locked, {
          kind: "registered-transcript",
          parsed,
          wave,
          runAt: new Date().toISOString(),
          floor: epochSettledFloor(locked.wave_review_epoch),
        }).state;
        return { state, value: { ok: true as const } };
      });
    }
    const taskId = context.subject.taskId;
    if (typeof taskId !== "string") return { ok: false, message: "Wave reviewer request lacks Task identity" };
    const registration = readRegisteredWaveProgram(handle);
    const protocol = issuedWaveProtocol(handle, registration, authority);
    // Submission follows durable capture. Re-read its original bytes rather than
    // trust a CLI's decoded string (or a conflicting duplicate submission).
    const captured = handle.readTranscriptBytes(authority);
    if (!captured.ok) return { ok: false, message: captured.error.message };
    const bytes = captured.value;
    return manager.updateAndReturn<WaveFacadeSubmissionResult>((locked) => {
      const target = locked.tasks.find((task) => task.id === taskId);
      if (target === undefined) {
        return {
          state: locked,
          value: { ok: false as const, message: `Wave reviewer task ${taskId} is no longer in the protected task graph` },
        };
      }
      const slot = target.review_run?.slot_authority?.find((candidate) => candidate.agent === authority.role);
      const problem = waveReviewerSlotProblem(locked, target, context, protocol);
      if (problem !== null) {
        return {
          state: locked,
          value: {
            ok: false as const,
            message: `Wave reviewer request ${authority.requestId} does not belong to Task ${taskId}'s exact current Review Packet slot: ${problem}`,
          },
        };
      }
      const resolution = resolveWaveReviewerTranscript(target, authority.role, bytes, protocol);
      const tasks = locked.tasks.map((task) =>
        task.id === taskId ? applyReviewResolution(task, resolution, slot) : task);
      return {
        state: {
          ...locked,
          tasks,
          wave_gates: reconcileWaveBlock(locked.wave_gates, tasks, locked.spec_check, context.wave),
        },
        value: { ok: true as const },
      };
    });
  } catch (error) {
    return { ok: false, message: reportUncaughtWaveGateFailure(authority.runId, error) };
  }
}
