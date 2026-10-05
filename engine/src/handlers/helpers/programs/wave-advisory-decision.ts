/**
 * The Wave Gate advisory user decision: its canonical request identity, the
 * publication of every byte the request references, and the resume phase that
 * suspends on an unapproved advisory set or continues with the approved drive.
 */
import { awaitUserAction, canonicalStructuralEquals, type AwaitUserAction } from '../../../core/orchestration-contract';
import {
  deriveWaveAdvisoryDecisionRequest,
  deriveWaveGateDriveStep,
  waveAdvisoryDecisionActionRequest,
  type WaveAdvisoryDecisionRequest,
} from '../../../core/wave-gate-preparation';
import { advisoryDecisionApproved } from '../../../core/wave-gate-membership';
import type { Task } from '../../../types';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { proceed, settled, waveBlocked, type WavePhase } from './wave-gate-outcome';

type WaveReadiness = Parameters<typeof deriveWaveGateDriveStep>[0];
type WaveGateDriveStep = Extract<ReturnType<typeof deriveWaveGateDriveStep>, { ok: true }>["value"];

export function waveAdvisoryDecisionRequestId(
  runId: string,
  tasks: readonly Task[],
): string {
  const request = deriveWaveAdvisoryDecisionRequest(runId, tasks);
  if (!request.ok) throw new Error(request.error.message);
  return request.value.requestId;
}

/** Publish every byte referenced by the canonical user-decision request. */
export async function publishWaveAdvisoryDecisionRequest(
  handle: RunDirHandle,
  material: WaveAdvisoryDecisionRequest,
): Promise<Readonly<{ ok: true; request: AwaitUserAction["request"] }> | Readonly<{ ok: false; message: string }>> {
  const actionRequest = waveAdvisoryDecisionActionRequest(material);
  if (!actionRequest.ok) return { ok: false, message: actionRequest.error.message };
  const action = awaitUserAction(actionRequest.value);
  if (!action.ok) return { ok: false, message: action.error.message };
  if (material.advisories[0].reference.runId !== handle.runId) {
    return { ok: false, message: "advisory decision material belongs to a different run" };
  }
  const published = await handle.publishArtifactSet(material.advisories.map(({ reference, bytes }) => ({
    relativePath: reference.slot.path.slice("artifacts/".length),
    bytes,
  })));
  if (!published.ok) return { ok: false, message: published.error.message };
  const expectedRefs = material.advisories.map(({ reference }) => reference);
  if (!canonicalStructuralEquals(published.value, expectedRefs)) {
    return { ok: false, message: "published advisory artifacts differ from core-derived references" };
  }
  const context = await handle.publishDecisionContext(material.context.digest, material.context.bytes);
  if (!context.ok) return { ok: false, message: context.error.message };
  if (context.value.digest !== material.context.digest) {
    return { ok: false, message: "published advisory context differs from core-derived context authority" };
  }
  return { ok: true, request: action.value.request };
}

/** Resume phase: derive the gate's drive step, suspending on the advisory
 *  decision until the user approves it. */
export async function driveWaveAdvisoryDecision(
  handle: RunDirHandle,
  readiness: WaveReadiness,
): Promise<WavePhase<WaveGateDriveStep>> {
  const pendingDrive = deriveWaveGateDriveStep(readiness, false);
  if (!pendingDrive.ok) return settled(waveBlocked(handle, pendingDrive.error.message));
  const drive = pendingDrive.value;
  if (drive.kind !== "await-advisory-decision") return proceed(drive);
  if (!advisoryDecisionApproved(await handle.readEvents(), drive.material.requestId)) {
    const published = await publishWaveAdvisoryDecisionRequest(handle, drive.material);
    return settled(published.ok
      ? { ok: true, action: { kind: "await-user", runId: handle.runId, request: published.request } }
      : waveBlocked(handle, published.message));
  }
  const approvedDrive = deriveWaveGateDriveStep(readiness, true);
  return approvedDrive.ok ? proceed(approvedDrive.value) : settled(waveBlocked(handle, approvedDrive.error.message));
}
