/**
 * Wave Gate registration admission — the ONE decision over whether a fresh
 * Wave Gate run may install itself as the protected active registration.
 *
 * Two callers ask it: the locked `StateManager.registerActiveWaveGate`
 * transition, which installs under the TaskGraph lock, and the `start
 * wave-gate` preflight, which asks the same question of an unlocked snapshot
 * BEFORE a Run Directory is claimed. Sharing the predicate keeps preflight
 * from admitting a start that registration would then refuse (or the
 * reverse); the locked call stays authoritative because the graph can move
 * between the two reads.
 */

import type { ActiveWaveGateRegistration, TaskGraph } from "../types";
import { canonicalRecord } from "./orchestration-contract";
import { waveGateAuthorityDigest } from "./wave-review-authority";

/** The registration identity the admission compares against protected state. */
export type WaveGateRegistrationCandidate = Readonly<{
  runId: string;
  wave: number;
  authorityDigest: string;
  runsRoot?: string | undefined;
}>;

export type WaveGateRegistrationAdmission =
  /** Install the candidate; `supersedesAbandoned` says the install retires an
   *  abandoned predecessor's review authority. */
  | Readonly<{ kind: "install"; supersedesAbandoned: boolean }>
  /** The exact candidate is already the live registration (idempotent replay). */
  | Readonly<{ kind: "replay"; existing: ActiveWaveGateRegistration }>
  | Readonly<{ kind: "refused"; message: string }>;

const refused = (message: string): WaveGateRegistrationAdmission =>
  canonicalRecord({ kind: "refused" as const, message });

/**
 * Decide registration for one candidate whose Run Directory published
 * `publishedTaskIds` as its roster (in protected Task order).
 */
export function admitWaveGateRegistration(
  state: TaskGraph,
  candidate: WaveGateRegistrationCandidate,
  publishedTaskIds: readonly string[],
): WaveGateRegistrationAdmission {
  if (state.current_phase !== "execute") {
    return refused(`Cannot register Wave Gate run outside execute Phase (current: ${state.current_phase})`);
  }
  if (state.current_wave !== candidate.wave) {
    return refused(`Cannot register Wave Gate wave ${candidate.wave}; protected current_wave is ${state.current_wave ?? "missing"}`);
  }
  const completed = state.wave_gate_history ?? [];
  if (completed.some((entry) => entry.runId === candidate.runId)) {
    return refused(`Wave Gate run ${candidate.runId} is already terminal`);
  }
  if (completed.some((entry) => entry.wave >= candidate.wave)) {
    return refused(`Wave ${candidate.wave} is already completed or older than terminal Wave history`);
  }
  const existing = state.active_wave_gate;
  if (existing !== undefined) {
    const exactReplay = existing.runId === candidate.runId &&
      existing.wave === candidate.wave &&
      existing.authorityDigest === candidate.authorityDigest && existing.runsRoot === candidate.runsRoot &&
      existing.revision === 0 && existing.terminalOutcome === null;
    if (exactReplay) return canonicalRecord({ kind: "replay" as const, existing });
    if (existing.terminalOutcome === null) {
      return refused(`Active Wave Gate run ${existing.runId} already owns wave ${existing.wave}`);
    }
    if (existing.terminalOutcome.kind !== "terminal-abandoned") {
      return refused(
        `Legacy terminal Wave Gate run ${existing.runId} must be explicitly migrated to terminal history before registering another run`,
      );
    }
    if (existing.terminalOutcome.supersededBy !== null &&
        existing.terminalOutcome.supersededBy !== candidate.runId) {
      return refused(
        `Abandoned Wave Gate run ${existing.runId} authorizes successor ${existing.terminalOutcome.supersededBy}, ` +
        `not ${candidate.runId}`,
      );
    }
  }
  const lockedTaskIds = state.tasks
    .filter((task) => task.wave === candidate.wave)
    .map(({ id }) => id);
  const rosterMatches = lockedTaskIds.length === publishedTaskIds.length &&
    lockedTaskIds.every((taskId, index) => taskId === publishedTaskIds[index]);
  if (!rosterMatches || waveGateAuthorityDigest(candidate.wave, lockedTaskIds, state) !== candidate.authorityDigest) {
    return refused("Protected Wave authority changed after Run Directory publication; active Wave Gate was not installed");
  }
  return canonicalRecord({
    kind: "install" as const,
    supersedesAbandoned: existing?.terminalOutcome?.kind === "terminal-abandoned",
  });
}
