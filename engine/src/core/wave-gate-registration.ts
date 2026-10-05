/**
 * Wave Gate registration — the ONE decision over whether a fresh Wave Gate run
 * may install itself as the protected active registration, and the protected
 * TaskGraph that install produces.
 *
 * Two callers ask it: the locked `StateManager.registerActiveWaveGate`
 * transition persists `installWaveGateRegistration`'s decision under the
 * TaskGraph lock, and the `start wave-gate` preflight asks
 * `admitWaveGateRegistration` the same question of an unlocked snapshot BEFORE
 * a Run Directory is claimed. Sharing the admission keeps preflight from
 * admitting a start that registration would then refuse (or the reverse); the
 * locked call stays authoritative because the graph can move between the two
 * reads.
 *
 * Review authority retirement lives here too. Restart and orphan recovery
 * retire a run's review authority before a replacement registers, and an
 * install over an abandoned predecessor retires that predecessor's authority
 * inside the install itself — so no caller can forget, or mis-parameterise,
 * the supersession step.
 */

import type { ActiveWaveGateRegistration, TaskGraph } from "../types";
import { preserveAcceptedReviewRunFindings } from "./findings";
import { canonicalRecord } from "./orchestration-contract";
import { reconcileWaveBlock } from "./wave-gate-model";
import { waveGateAuthorityDigest } from "./wave-review-authority";

/** The registration identity the admission compares against protected state. */
export type WaveGateRegistrationCandidate = Readonly<{
  runId: string;
  wave: number;
  authorityDigest: string;
  runsRoot?: string | undefined;
}>;

/** What an admitted install replaces. */
export type WaveGateInstallPredecessor =
  | Readonly<{ kind: "none" }>
  /** An operator-abandoned run whose review authority the install retires. */
  | Readonly<{ kind: "abandoned"; runId: ActiveWaveGateRegistration["runId"] }>;

export type WaveGateRegistrationAdmission =
  | Readonly<{ kind: "install"; predecessor: WaveGateInstallPredecessor }>
  /** The exact candidate is already the live registration (idempotent replay). */
  | Readonly<{ kind: "replay"; existing: ActiveWaveGateRegistration }>
  | Readonly<{ kind: "refused"; message: string }>;

/** The fully formed locked install: the shell persists `state` and nothing else. */
export type WaveGateInstallDecision =
  | Readonly<{ kind: "installed"; state: TaskGraph; registration: ActiveWaveGateRegistration }>
  | Readonly<{ kind: "replayed"; registration: ActiveWaveGateRegistration }>
  | Readonly<{ kind: "refused"; message: string }>;

/** The live registration IS this candidate, untouched since its install. */
const isExactReplay = (existing: ActiveWaveGateRegistration, candidate: WaveGateRegistrationCandidate): boolean =>
  existing.runId === candidate.runId &&
  existing.wave === candidate.wave &&
  existing.authorityDigest === candidate.authorityDigest &&
  existing.runsRoot === candidate.runsRoot &&
  existing.revision === 0 &&
  existing.terminalOutcome === null;

/** The Run Directory published exactly the protected roster, in protected Task order. */
const sameRoster = (locked: readonly string[], published: readonly string[]): boolean =>
  locked.length === published.length && locked.every((taskId, index) => taskId === published[index]);

/**
 * Decide registration for one candidate whose Run Directory published
 * `publishedTaskIds` as its roster (in protected Task order).
 */
export function admitWaveGateRegistration(
  state: TaskGraph,
  candidate: WaveGateRegistrationCandidate,
  publishedTaskIds: readonly string[],
): WaveGateRegistrationAdmission {
  return canonicalRecord(admission(state, candidate, publishedTaskIds));
}

/** The ordered refusal ladder; the first refusal that applies wins. */
function admission(
  state: TaskGraph,
  candidate: WaveGateRegistrationCandidate,
  publishedTaskIds: readonly string[],
): WaveGateRegistrationAdmission {
  if (state.current_phase !== "execute") {
    return { kind: "refused", message: `Cannot register Wave Gate run outside execute Phase (current: ${state.current_phase})` };
  }
  if (state.current_wave !== candidate.wave) {
    return {
      kind: "refused",
      message: `Cannot register Wave Gate wave ${candidate.wave}; protected current_wave is ${state.current_wave ?? "missing"}`,
    };
  }
  const completed = state.wave_gate_history ?? [];
  if (completed.some((entry) => entry.runId === candidate.runId)) {
    return { kind: "refused", message: `Wave Gate run ${candidate.runId} is already terminal` };
  }
  if (completed.some((entry) => entry.wave >= candidate.wave)) {
    return { kind: "refused", message: `Wave ${candidate.wave} is already completed or older than terminal Wave history` };
  }
  const existing = state.active_wave_gate;
  let predecessor: WaveGateInstallPredecessor = { kind: "none" };
  if (existing !== undefined) {
    if (isExactReplay(existing, candidate)) return { kind: "replay", existing };
    if (existing.terminalOutcome === null) {
      return { kind: "refused", message: `Active Wave Gate run ${existing.runId} already owns wave ${existing.wave}` };
    }
    if (existing.terminalOutcome.kind !== "terminal-abandoned") {
      return {
        kind: "refused",
        message: `Legacy terminal Wave Gate run ${existing.runId} must be explicitly migrated to terminal history before registering another run`,
      };
    }
    if (existing.terminalOutcome.supersededBy !== null &&
        existing.terminalOutcome.supersededBy !== candidate.runId) {
      return {
        kind: "refused",
        message: `Abandoned Wave Gate run ${existing.runId} authorizes successor ${existing.terminalOutcome.supersededBy}, ` +
          `not ${candidate.runId}`,
      };
    }
    predecessor = { kind: "abandoned", runId: existing.runId };
  }
  const lockedTaskIds = state.tasks
    .filter((task) => task.wave === candidate.wave)
    .map(({ id }) => id);
  if (!sameRoster(lockedTaskIds, publishedTaskIds) ||
      waveGateAuthorityDigest(candidate.wave, lockedTaskIds, state) !== candidate.authorityDigest) {
    return { kind: "refused", message: "Protected Wave authority changed after Run Directory publication; active Wave Gate was not installed" };
  }
  return { kind: "install", predecessor: canonicalRecord(predecessor) };
}

/**
 * The locked install: admission, abandoned-predecessor supersession and the
 * new active registration, decided together as one pure transition.
 */
export function installWaveGateRegistration(
  state: TaskGraph,
  registration: ActiveWaveGateRegistration,
  publishedTaskIds: readonly string[],
): WaveGateInstallDecision {
  const admitted = admitWaveGateRegistration(state, registration, publishedTaskIds);
  switch (admitted.kind) {
    case "refused":
      return admitted;
    case "replay":
      return canonicalRecord({ kind: "replayed", registration: admitted.existing });
    case "install": {
      // An abandoned Run is not completion authority. Its review epoch and
      // packet-bound evidence retire with the successor install, and any review
      // it accepted reopens because that acceptance's run authority is gone;
      // accepted Findings and implementation proof survive. The tombstone is
      // not archived as a completed Wave.
      const successorBase = admitted.predecessor.kind === "abandoned"
        ? supersedeAbandonedWaveGateReview(state, admitted.predecessor.runId, publishedTaskIds)
        : state;
      return canonicalRecord({
        kind: "installed",
        state: { ...successorBase, active_wave_gate: registration },
        registration,
      });
    }
  }
}

/**
 * Retire one Wave review generation as a single aggregate transition.
 *
 * Every authority field invalidated by a replacement gate lives here so
 * restart, orphan recovery and abandoned-run supersession cannot drift through
 * shell-local object spreads. Accepted Findings survive; only packet-bound
 * review evidence is retired.
 *
 * Retiring the spec-check can remove a Wave's only block cause, and `blocked`
 * is derived, never asserted: it is re-derived here through the writers' own
 * `reconcileWaveBlock`, or the State File boundary refuses the causeless
 * block and no successor gate can install.
 */
export function resetWaveGateReviewAuthority(
  graph: TaskGraph,
  taskIds: readonly string[],
): TaskGraph {
  const tasks = Object.freeze(graph.tasks.map((task) => {
    if (!taskIds.includes(task.id) || task.review_run === undefined) return task;
    const preserved = preserveAcceptedReviewRunFindings(task);
    return canonicalRecord({
      ...preserved,
      review_status: "pending" as const,
      review_generation: task.review_generation,
      review_run: undefined,
      review_error: undefined,
      review_evidence_failures: undefined,
    });
  }));
  const affectedWaves = new Set([
    ...graph.tasks.filter(({ id }) => taskIds.includes(id)).map(({ wave }) => wave),
    ...(graph.spec_check === undefined ? [] : [graph.spec_check.wave]),
  ]);
  const waveGates = [...affectedWaves]
    .filter((wave) => graph.wave_gates[String(wave)] !== undefined)
    .reduce((gates, wave) => reconcileWaveBlock(gates, tasks, undefined, wave), graph.wave_gates);
  return canonicalRecord({
    ...graph,
    tasks,
    wave_gates: waveGates,
    spec_check: undefined,
    wave_review_epoch: undefined,
    active_wave_gate: undefined,
    active_wave_completion_suite: undefined,
  });
}

/**
 * A fresh Wave Gate run superseding an operator-abandoned one. Abandonment only
 * stamps a terminal tombstone; the abandoned run's review epoch, spec-check
 * record and packet-bound review state stay behind and contradict any
 * successor (an epoch must belong to the active run). This retires that review
 * authority exactly as restart and orphan recovery do — accepted findings and
 * Review Generations survive — and reopens any review the abandoned run
 * accepted, because that acceptance's authority died with it.
 */
function supersedeAbandonedWaveGateReview(
  graph: TaskGraph,
  abandonedRunId: string,
  taskIds: readonly string[],
): TaskGraph {
  const reset = resetWaveGateReviewAuthority(graph, taskIds);
  return {
    ...reset,
    tasks: reset.tasks.map((task) =>
      taskIds.includes(task.id) && task.accepted_review_authority?.run_id === abandonedRunId
        ? { ...task, review_status: "pending" as const, accepted_review_authority: undefined }
        : task),
  };
}
