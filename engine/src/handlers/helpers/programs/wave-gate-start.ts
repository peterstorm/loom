/**
 * Starting one Wave Gate: an unlocked preflight that rules out every refusal
 * knowable before a Run Directory is claimed and plans the start's Successor
 * Carry, then the start that publishes the run's program registration before
 * installing protected active authority and handing over to the resume
 * reducer.
 */
import { realpathSync } from 'node:fs';
import { WAVE_REVIEWER_PROTOCOL_V4 } from '../../../core/reviewer-contract';
import { openRunDirectory, parseRunDirectoryReference, type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { admitWaveGateRegistration, successionPredecessorOf } from '../../../core/wave-gate-registration';
import { TASK_GRAPH_PATH } from '../../../config';
import { StateManager } from '../../../state-manager';
import { deriveWaveStartReadiness } from '../../../core/wave-gate-checks';
import type { DomainResult } from '../../../core/orchestration-contract';
import type { RegisteredWaveGateProgram, WaveGateSuccessionAudit } from '../../../core/wave-gate-program';
import { waveGateAuthorityDigest, waveReviewView } from '../../../core/wave-review-authority';
import { planSuccessorCarry, type TaskNotCarried } from '../../../core/wave-review-carry';
import type { RetiredWaveReviewRun, TaskGraph } from '../../../types';
import { observeReviewedWorkspace } from '../reviewed-workspace';
import { runFullTierWaveLint } from '../lint-wave-gate';
import { failed, type FacadeDriveResult } from './program-result';
import { parseRegisteredFacadeProgram } from './registration';
import { reportUncaughtWaveGateFailure, waveBlocked } from './wave-gate-outcome';
import { resumeWaveGateFacade } from './wave-gate';

/** A Wave Gate start that passed its preflight against one TaskGraph snapshot.
 *  Only `prepareWaveGateFacadeStart` mints it (see `preparedWaveGateStarts`). */
export type PreparedWaveGateStart = Readonly<{
  runId: string;
  registration: RegisteredWaveGateProgram;
  /** Each reviewed Task the start issues in full although it succeeds a
   *  retired run, and why its accepted review did not carry (ADR-0090). */
  notCarried: readonly TaskNotCarried[];
}>;

/** How a start treats the accepted reviews of the run it succeeds. */
export type WaveGateStartOptions = Readonly<{
  /** `--fresh-review`: carry nothing and issue every reviewed Task in full. */
  freshReview: boolean;
}>;

const preparedWaveGateStarts = new WeakSet<PreparedWaveGateStart>();

/**
 * The registration of the retired run `predecessor`, read from its Run
 * Directory under `runsRoot`, or why it could not be. The pure carry plan
 * proves it is the run the protected record retired.
 */
function loadPredecessorRegistration(
  runsRoot: string,
  predecessor: RetiredWaveReviewRun,
): DomainResult<RegisteredWaveGateProgram, string> {
  const opened = openRunDirectory(runsRoot, predecessor.runId);
  if (!opened.ok) return { ok: false, error: opened.error.message };
  const raw = opened.value.readProgramRegistration();
  if (!raw.ok) return { ok: false, error: raw.error.message };
  if (raw.value === null) return { ok: false, error: `run ${predecessor.runId} has no registered program` };
  const parsed = parseRegisteredFacadeProgram(raw.value);
  if (parsed.kind !== "registered" || parsed.program.kind !== "wave-gate") {
    return { ok: false, error: `run ${predecessor.runId} holds no Wave Gate registration` };
  }
  return { ok: true, value: parsed.program };
}

/**
 * What a fresh start carries from the retired run it succeeds (ADR-0090):
 * the shell loads the predecessor's registration and the reviewed workspaces,
 * and the pure `planSuccessorCarry` decides. Nothing is planned for
 * `--fresh-review`, nor for a Wave with no retired run to succeed.
 */
function successorCarryOf(
  graph: TaskGraph,
  wave: number,
  taskIds: readonly string[],
  runsRoot: string,
  options: WaveGateStartOptions,
): Readonly<{ succession?: WaveGateSuccessionAudit }> & Pick<PreparedWaveGateStart, "notCarried"> {
  const predecessor = options.freshReview ? null : successionPredecessorOf(graph, wave);
  if (predecessor === null) return { notCarried: [] };
  const reviewed = waveReviewView(graph.tasks.filter(({ id }) => taskIds.includes(id))).reviewed;
  const plan = planSuccessorCarry({
    graph,
    taskIds,
    protocol: WAVE_REVIEWER_PROTOCOL_V4,
    predecessor,
    previous: loadPredecessorRegistration(runsRoot, predecessor),
    workspaces: observeReviewedWorkspace(reviewed),
  });
  return { ...(plan.succession === undefined ? {} : { succession: plan.succession }), notCarried: plan.notCarried };
}

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
 * It also plans the start's Successor Carry from the same snapshot, so the
 * registration freezes it; the locked install re-checks its provenance.
 *
 * The locked registration re-decides admission through the same predicate,
 * because the graph can move between this snapshot and the install.
 */
export function prepareWaveGateFacadeStart(
  input: RegisteredWaveGateProgram["input"],
  runsRoot: string,
  run: string,
  options: WaveGateStartOptions = { freshReview: false },
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
    const { succession, notCarried } = successorCarryOf(graph, wave, taskIds, destination.value.runsRoot, options);
    const fresh = {
      schemaVersion: 2, reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4, kind: "wave-gate", input: Object.freeze({ wave }),
      taskIds, authorityDigest,
    } as const;
    const prepared: PreparedWaveGateStart = Object.freeze({
      runId: destination.value.runId,
      registration: Object.freeze(succession === undefined ? fresh : { ...fresh, succession }),
      notCarried,
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

/**
 * Name each reviewed Task the start issues in full although it succeeds a
 * retired run, and why its accepted review did not carry, as one JSON line on
 * the start's diagnostic output. The reasons are the start's result, never
 * part of the registration.
 */
function reportNotCarried(runId: string, notCarried: readonly TaskNotCarried[]): void {
  if (notCarried.length === 0) return;
  process.stderr.write(`${JSON.stringify({ kind: "wave-gate-start-not-carried", runId, notCarried })}\n`);
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
    }, registration.taskIds, registration.succession);
    reportNotCarried(handle.runId, prepared.notCarried);
    return resumeWaveGateFacade(handle, registration);
  } catch (error) {
    return waveBlocked(handle, reportUncaughtWaveGateFailure(handle.runId, error));
  }
}
