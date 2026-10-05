/**
 * Replacing an active Wave Gate run (shell): restart after every outstanding
 * reviewer slot exhausted its final attempt, and recovery of a run whose
 * authoritative Run Directory vanished. The shell proves the filesystem,
 * capture and subagent facts; core/wave-gate-replacement decides the
 * transition, which is re-derived under the state lock before it commits.
 */
import { dirname, join, resolve } from 'node:path';
import { parseArtifactDigest, parseOrchestrationRunId } from '../../../core/orchestration-contract';
import { captureKey } from '../../../core/harness-capture';
import { inspectRunDirectoryEntry, type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { TASK_GRAPH_PATH } from '../../../config';
import { StateManager } from '../../../state-manager';
import { anyActiveSubagent } from '../../../machine';
import type { TaskGraph } from '../../../types';
import { persistedWaveAttemptTwoCompatibilityProblem } from '../../../core/wave-gate-membership';
import { reviewerRejectionReason } from '../../../core/wave-reviewer-transcript';
import {
  prepareExhaustedWaveGateRestart,
  prepareOrphanedWaveGateRecovery,
  sameOrphanRecoveryRegistration,
  sameRestartRegistration,
  type OrphanedWaveGateRecoveryExpectation,
  type WaveGateRestartPreparation,
} from '../../../core/wave-gate-replacement';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import { durableCaptureRejection } from './durable-requests';
import { failed, type FacadeDriveResult } from './program-result';
import { parseRegisteredFacadeProgram } from './registration';
import { reportUncaughtWaveGateFailure } from './wave-gate-outcome';
import { issuedWaveProtocol } from './wave-review-context';
import { resumeWaveGateFacade } from './wave-gate';

async function exhaustedWaveReviewerAttempts(
  handle: RunDirHandle,
  graph: TaskGraph,
  registration: RegisteredWaveGateProgram,
): Promise<Readonly<{ ok: true; value: ReadonlySet<string> }> | Readonly<{ ok: false; message: string }>> {
  const issued = handle.readIssuedRequests();
  const captured = handle.readCapturedAttempts();
  if (!issued.ok) return { ok: false, message: issued.error.message };
  if (!captured.ok) return { ok: false, message: captured.error.message };
  const exhausted = new Set<string>();
  for (const task of graph.tasks.filter(({ id }) => registration.taskIds.includes(id))) {
    const run = task.review_run;
    if (run === undefined) continue;
    for (const slot of run.slot_authority ?? []) {
      if (run.evidence.some(({ agent }) => agent === slot.agent) || slot.attempted !== 2) continue;
      const attempts = issued.value.filter((candidate) =>
        candidate.program === "wave-gate" && candidate.attempt === 2 &&
        candidate.slotId === slot.slot_id && candidate.role === slot.agent);
      if (attempts.length !== 1) {
        return { ok: false, message: `Wave Gate restart requires exactly one attempt-2 authority for ${task.id}/${slot.agent}` };
      }
      const authority = attempts[0]!;
      const attemptOne = issued.value.find((candidate) => candidate.program === "wave-gate" && candidate.attempt === 1 &&
        candidate.slotId === slot.slot_id && candidate.role === slot.agent);
      if (attemptOne === undefined) return { ok: false, message: `Wave Gate restart lacks attempt-1 authority for ${task.id}/${slot.agent}` };
      const firstContext = handle.readContext(attemptOne.contextDigest);
      if (!firstContext.ok) return { ok: false, message: firstContext.error.message };
      const secondContext = handle.readContext(authority.contextDigest);
      if (!secondContext.ok) return { ok: false, message: secondContext.error.message };
      const authorityProblem = persistedWaveAttemptTwoCompatibilityProblem(
        attemptOne,
        authority,
        firstContext.value,
        secondContext.value,
      );
      if (authorityProblem !== null) {
        return { ok: false, message: `Wave Gate restart attempt-2 authority drifted for ${task.id}/${slot.agent}: ${authorityProblem}` };
      }
      const key = captureKey(slot.slot_id, 2);
      if (captured.value.has(key)) {
        const transcript = handle.readTranscriptBytes(authority);
        if (!transcript.ok) return { ok: false, message: transcript.error.message };
        const rejection = reviewerRejectionReason(task, slot.agent, transcript.value, issuedWaveProtocol(handle, registration, authority));
        if (rejection === null) {
          return {
            ok: false,
            message: `Wave Gate restart refused: ${task.id}/${slot.agent} has valid captured attempt-2 evidence; resume must apply it`,
          };
        }
        exhausted.add(key);
        continue;
      }
      const rejected = await durableCaptureRejection(handle, authority);
      if (rejected !== null) {
        const terminal = await handle.rejectCapture(authority, rejected);
        if (!terminal.ok) return { ok: false, message: terminal.error.message };
        exhausted.add(terminal.value);
      }
    }
  }
  return { ok: true, value: exhausted };
}

export async function restartWaveGateFacade(
  previousHandle: RunDirHandle,
  nextHandle: RunDirHandle,
  previousRegistration: RegisteredWaveGateProgram,
): Promise<FacadeDriveResult> {
  try {
    if (previousHandle.runId === nextHandle.runId) {
      return failed("Wave Gate restart requires a distinct fresh run directory");
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    const before = manager.load();
    const alreadyRestarted = before.active_wave_gate?.runId === nextHandle.runId;
    const completedRestart = before.wave_gate_history?.some((entry) => entry.runId === nextHandle.runId) === true;
    const existingProgram = nextHandle.readProgramRegistration();
    if (!existingProgram.ok) return failed(existingProgram.error.message);
    const storedProgramParse = existingProgram.value === null ? null : parseRegisteredFacadeProgram(existingProgram.value);
    if (storedProgramParse?.kind === "invalid") {
      return failed(`replacement run's registered program is invalid: ${storedProgramParse.message}`);
    }
    const storedProgram = storedProgramParse?.kind === "registered" ? storedProgramParse.program : null;
    if (completedRestart) {
      if (storedProgram === null || storedProgram.kind !== "wave-gate" ||
          storedProgram.restart?.previousRunId !== previousHandle.runId) {
        return failed("completed replacement lacks exact registered restart authority");
      }
      return resumeWaveGateFacade(nextHandle, storedProgram);
    }
    if (!alreadyRestarted) {
      const pristine = nextHandle.isPristine();
      if (!pristine.ok) return failed(pristine.error.message);
      if (!pristine.value) return failed("replacement Wave Gate run must be pristine before authority installation");
    }
    const exhausted = alreadyRestarted
      ? null
      : await exhaustedWaveReviewerAttempts(previousHandle, before, previousRegistration);
    if (exhausted !== null && !exhausted.ok) return failed(exhausted.message);

    let prepared: WaveGateRestartPreparation;
    if (alreadyRestarted) {
      const active = before.active_wave_gate!;
      const stored = storedProgram;
      if (stored === null || stored.kind !== "wave-gate" || active.wave !== stored.input.wave ||
          active.authorityDigest !== stored.authorityDigest || active.terminalOutcome !== null) {
        return failed("replacement run does not own compatible registered Wave Gate authority");
      }
      if (stored.restart?.previousRunId !== previousHandle.runId) {
        return failed("replacement run registration lacks exact previous-run restart audit authority");
      }
      prepared = Object.freeze({ graph: before, registration: stored, exhaustedSlots: stored.restart.exhaustedSlots });
    } else {
      const candidate = prepareExhaustedWaveGateRestart(
        before,
        previousHandle.runId,
        previousRegistration,
        nextHandle.runId,
        nextHandle.identity.runsRoot,
        exhausted!.value,
      );
      if (!candidate.ok) return failed(candidate.message);
      if (existingProgram.value === null) {
        const registered = await nextHandle.registerProgram(candidate.value.registration);
        if (!registered.ok) return failed(registered.error.message);
      } else {
        const stored = storedProgram;
        if (stored === null || stored.kind !== "wave-gate" || !sameRestartRegistration(stored, candidate.value.registration)) {
          return failed("replacement Wave Gate run is already registered under different authority");
        }
      }
      prepared = await manager.updateAndReturn((locked) => {
        const transition = prepareExhaustedWaveGateRestart(
          locked,
          previousHandle.runId,
          previousRegistration,
          nextHandle.runId,
          nextHandle.identity.runsRoot,
          exhausted!.value,
        );
        if (!transition.ok) throw new Error(transition.message);
        if (!sameRestartRegistration(transition.value.registration, candidate.value.registration)) {
          throw new Error("protected Wave authority changed while restart was being installed");
        }
        return { state: transition.value.graph, value: transition.value };
      });
    }
    if (prepared.exhaustedSlots.length === 0) {
      return failed("replacement registration contains no exhausted-slot restart audit evidence");
    }
    await previousHandle.writeCheckpoint(JSON.stringify({
      schemaVersion: 1,
      kind: "wave-gate-retired",
      previousRunId: previousHandle.runId,
      replacementRunId: nextHandle.runId,
      wave: previousRegistration.input.wave,
      exhaustedSlots: prepared.exhaustedSlots,
    }));
    return resumeWaveGateFacade(nextHandle, prepared.registration);
  } catch (error) {
    return failed(reportUncaughtWaveGateFailure(nextHandle.runId, error));
  }
}

/** Engine-owned recovery for a protected active run whose Run Directory is
 * gone. The shell proves filesystem/subagent facts; the pure transition is
 * re-derived under the state lock before retirement audit + replacement
 * authority are committed together. */
export async function recoverOrphanedWaveGateFacade(
  runsRoot: string,
  expected: OrphanedWaveGateRecoveryExpectation,
  nextHandle: RunDirHandle,
): Promise<FacadeDriveResult> {
  try {
    const parsedRunId = parseOrchestrationRunId(expected.runId);
    const parsedDigest = parseArtifactDigest(expected.authorityDigest);
    if (!parsedRunId.ok) return failed(parsedRunId.error.message);
    if (!parsedDigest.ok) return failed(parsedDigest.error.message);
    if (!Number.isSafeInteger(expected.wave) || expected.wave < 1) {
      return failed("orphan recovery wave must be a positive safe integer");
    }
    if (nextHandle.runId === parsedRunId.value) {
      return failed("orphan recovery requires a distinct replacement run identity");
    }
    const requestedRunsRoot = resolve(runsRoot);
    const legacyCanonicalRunsRoot = join(dirname(dirname(resolve(TASK_GRAPH_PATH))), "reviews", "wave-gate-runs");
    const manager = new StateManager(TASK_GRAPH_PATH);
    const before = manager.load();
    const authoritativeRunsRoot = before.active_wave_gate?.runsRoot ?? legacyCanonicalRunsRoot;
    if (requestedRunsRoot !== authoritativeRunsRoot) {
      return failed(`orphan recovery runs root ${requestedRunsRoot} does not match authoritative root ${authoritativeRunsRoot}`);
    }
    if (nextHandle.identity.runsRoot !== authoritativeRunsRoot) {
      return failed("replacement run must be a direct child of the authoritative Wave Gate runs root");
    }
    const inspectOrphan = () => inspectRunDirectoryEntry(
      authoritativeRunsRoot,
      join(authoritativeRunsRoot, parsedRunId.value),
    );
    const absent = inspectOrphan();
    if (!absent.ok) return failed(absent.error.message);
    if (absent.value.kind !== "absent") {
      return failed(`orphan recovery refused: authoritative Run Directory ${absent.value.reference.runDirectory} still exists`);
    }
    if (anyActiveSubagent(TASK_GRAPH_PATH)) {
      return failed("orphan recovery refused while a review or implementation subagent is active for this task graph");
    }

    const storedRaw = nextHandle.readProgramRegistration();
    if (!storedRaw.ok) return failed(storedRaw.error.message);
    const storedParse = storedRaw.value === null ? null : parseRegisteredFacadeProgram(storedRaw.value);
    if (storedParse?.kind === "invalid") {
      return failed(`replacement run's registered program is invalid: ${storedParse.message}`);
    }
    const stored = storedParse?.kind === "registered" ? storedParse.program : null;
    const replayAudit = before.orphaned_wave_gate_history?.find((audit) =>
      audit.runId === parsedRunId.value && audit.wave === expected.wave && audit.authorityDigest === parsedDigest.value &&
      audit.runsRoot === authoritativeRunsRoot && audit.runDirectory === join(authoritativeRunsRoot, parsedRunId.value) &&
      audit.replacementRunId === nextHandle.runId);
    if (before.active_wave_gate?.runId === nextHandle.runId) {
      const active = before.active_wave_gate;
      if (replayAudit === undefined || stored === null || stored.kind !== "wave-gate" ||
          stored.orphanRecovery?.previousRunId !== parsedRunId.value ||
          stored.orphanRecovery.previousAuthorityDigest !== parsedDigest.value ||
          active.wave !== expected.wave || active.authorityDigest !== stored.authorityDigest ||
          active.runsRoot !== nextHandle.identity.runsRoot ||
          replayAudit.replacementAuthorityDigest !== active.authorityDigest || active.terminalOutcome !== null) {
        return failed("replacement run lacks exact committed orphan-recovery authority");
      }
      return resumeWaveGateFacade(nextHandle, stored);
    }

    const pristine = nextHandle.isPristine();
    if (!pristine.ok) return failed(pristine.error.message);
    if (!pristine.value) return failed("replacement Wave Gate run must be pristine before orphan recovery");
    const candidate = prepareOrphanedWaveGateRecovery(before, {
      runId: parsedRunId.value,
      wave: expected.wave,
      authorityDigest: parsedDigest.value,
    }, authoritativeRunsRoot, nextHandle.runId, nextHandle.identity.runsRoot);
    if (!candidate.ok) return failed(candidate.message);
    if (storedRaw.value === null) {
      const registered = await nextHandle.registerProgram(candidate.value.registration);
      if (!registered.ok) return failed(registered.error.message);
    } else if (stored === null || stored.kind !== "wave-gate" ||
        !sameOrphanRecoveryRegistration(stored, candidate.value.registration)) {
      return failed("replacement Wave Gate run is already registered under different authority");
    }

    const committed = await manager.updateAndReturn((locked) => {
      const lockedAbsence = inspectOrphan();
      if (!lockedAbsence.ok) throw new Error(lockedAbsence.error.message);
      if (lockedAbsence.value.kind !== "absent") {
        throw new Error("authoritative Run Directory reappeared before orphan recovery could commit");
      }
      if (anyActiveSubagent(TASK_GRAPH_PATH)) {
        throw new Error("a review or implementation subagent became active before orphan recovery could commit");
      }
      const transition = prepareOrphanedWaveGateRecovery(locked, {
        runId: parsedRunId.value,
        wave: expected.wave,
        authorityDigest: parsedDigest.value,
      }, authoritativeRunsRoot, nextHandle.runId, nextHandle.identity.runsRoot);
      if (!transition.ok) throw new Error(transition.message);
      if (!sameOrphanRecoveryRegistration(transition.value.registration, candidate.value.registration)) {
        throw new Error("protected Wave authority changed while orphan recovery was being installed");
      }
      return { state: transition.value.graph, value: transition.value };
    });
    return resumeWaveGateFacade(nextHandle, committed.registration);
  } catch (error) {
    return failed(reportUncaughtWaveGateFailure(nextHandle.runId, error));
  }
}
