/**
 * Starting one Wave Gate: an unlocked preflight that rules out every refusal
 * knowable before a Run Directory is claimed, then the start that publishes
 * the run's program registration before installing protected active
 * authority and handing over to the resume reducer.
 */
import { realpathSync } from 'node:fs';
import { CURRENT_REVIEWER_PROTOCOL } from '../../../core/reviewer-contract';
import { parseRunDirectoryReference, type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { admitWaveGateRegistration } from '../../../core/wave-gate-registration';
import { TASK_GRAPH_PATH } from '../../../config';
import { StateManager } from '../../../state-manager';
import { deriveWaveStartReadiness } from '../../../core/wave-gate-checks';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import { waveGateAuthorityDigest } from '../../../core/wave-review-authority';
import { runFullTierWaveLint } from '../lint-wave-gate';
import { failed, type FacadeDriveResult } from './program-result';
import { reportUncaughtWaveGateFailure, waveBlocked } from './wave-gate-outcome';
import { resumeWaveGateFacade } from './wave-gate';

/** A Wave Gate start that passed its preflight against one TaskGraph snapshot.
 *  Only `prepareWaveGateFacadeStart` mints it (see `preparedWaveGateStarts`). */
export type PreparedWaveGateStart = Readonly<{
  runId: string;
  registration: RegisteredWaveGateProgram;
}>;

const preparedWaveGateStarts = new WeakSet<PreparedWaveGateStart>();

/**
 * Preflight one `start wave-gate` WITHOUT touching the runs root: the start
 * claims a Run Directory only after every refusal it can know in advance has
 * been ruled out — protected execute/current-Wave authority, a registration
 * the locked install would refuse (an active gate already owning the Wave, a
 * completed Wave, a mismatched abandoned successor), unmet start prerequisites
 * (executing Tasks, implementation proof, test evidence, new tests) and, where
 * a Verification Manifest gates the Wave, full-tier lint. Every one of these
 * used to surface only after registration, leaving a run to abandon.
 *
 * The locked registration re-decides admission through the same predicate,
 * because the graph can move between this snapshot and the install.
 */
export function prepareWaveGateFacadeStart(
  input: RegisteredWaveGateProgram["input"],
  runsRoot: string,
  run: string,
): Readonly<{ ok: true; value: PreparedWaveGateStart }> | Readonly<{ ok: false; message: string }> {
  try {
    const destination = parseRunDirectoryReference(runsRoot, run);
    if (!destination.ok) return { ok: false, message: destination.error.message };
    const graph = new StateManager(TASK_GRAPH_PATH).load();
    const wave = input.wave ?? graph.current_wave;
    if (graph.current_phase !== "execute" || wave === undefined || wave !== graph.current_wave) {
      return { ok: false, message: "wave-gate start requires exact protected execute/current_wave authority" };
    }
    const waveTasks = graph.tasks.filter((task) => task.wave === wave);
    if (waveTasks.length === 0) return { ok: false, message: `wave ${wave} has no tasks` };
    const taskIds = Object.freeze(waveTasks.map(({ id }) => id));
    const authorityDigest = waveGateAuthorityDigest(wave, taskIds, graph);
    const admission = admitWaveGateRegistration(graph, {
      runId: destination.value.runId,
      wave,
      authorityDigest,
      runsRoot: realRunsRoot(destination.value.runsRoot),
    }, taskIds);
    if (admission.kind === "refused") return { ok: false, message: admission.message };
    const readiness = deriveWaveStartReadiness(graph, waveTasks);
    if (readiness.kind === "not-ready") {
      return { ok: false, message: `wave ${wave} cannot start its Wave Gate: ${readiness.failures.join("; ")}` };
    }
    if (graph.verification_manifest !== undefined) {
      const lint = runFullTierWaveLint(waveTasks);
      if (lint.kind !== "allow") {
        return { ok: false, message: `wave ${wave} fails full-tier lint before its Wave Gate can start: ${"message" in lint ? lint.message : lint.kind}` };
      }
    }
    const prepared: PreparedWaveGateStart = Object.freeze({
      runId: destination.value.runId,
      registration: Object.freeze({
        schemaVersion: 2, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL, kind: "wave-gate", input: Object.freeze({ wave }),
        taskIds, authorityDigest,
      }),
    });
    preparedWaveGateStarts.add(prepared);
    return { ok: true, value: prepared };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** The runs root's real path, as the claimed Run Directory's identity will
 *  record it; a root that does not exist yet keeps its lexical form. */
function realRunsRoot(runsRoot: string): string {
  try {
    return realpathSync.native(runsRoot);
  } catch {
    return runsRoot;
  }
}

export async function startWaveGateFacade(
  handle: RunDirHandle,
  prepared: PreparedWaveGateStart,
): Promise<FacadeDriveResult> {
  if (!preparedWaveGateStarts.has(prepared) || handle.runId !== prepared.runId) {
    return failed("wave-gate start requires this Run's actual preflight");
  }
  const { registration } = prepared;
  try {
    const manager = new StateManager(TASK_GRAPH_PATH);
    // Publish the recoverable Run Directory program first. If publication is
    // refused, protected state remains byte-identical and no unsupported
    // active_wave_gate can be stranded.
    const stored = await handle.registerProgram(registration);
    if (!stored.ok) return failed(stored.error.message);
    await manager.registerActiveWaveGate({
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: handle.runId,
      wave: registration.input.wave,
      authorityDigest: registration.authorityDigest,
      revision: 0,
      runsRoot: handle.identity.runsRoot,
      terminalOutcome: null,
    }, registration.taskIds);
    return resumeWaveGateFacade(handle, registration);
  } catch (error) {
    return waveBlocked(handle, reportUncaughtWaveGateFailure(handle.runId, error));
  }
}
