/**
 * ═══════════ LEGACY ARCHIVE — deprecation horizon ═══════════
 *
 * The run-directory orchestration façade (RunDirHandle + orchestration-contract)
 * is the ONE state authority for standalone reviews, panels, and wave gates.
 * Everything in this module is a COMPATIBILITY READER for bytes produced by
 * older generations of the system — the legacy state-manager model that the
 * façade replaced additively. These readers exist so historical runs remain
 * consumable and auditable; they are NOT domain logic.
 *
 * Deprecation horizon: freeze every legacy reader behind this single archive
 * module, out of the active core files. Delete a section and its compatibility
 * re-exports only when repository fixtures and supported persisted runs no
 * longer contain that section's documented historical format, or an explicit
 * migration has rewritten all such bytes. Each section names its own format
 * and callers below. (Sections A and B, the manual standalone-review helper's
 * aggregation and its unversioned result parser, retired with that helper by
 * decision rather than by horizon: ADR-0096.) Until those observable criteria
 * hold, the rule is:
 *   - Canonical publication never originates here. Compatibility entry points
 *     may call the archive only after detecting an historical on-disk format.
 *     (The architecture panel's journal is not historical: it is the live
 *     format `/loom --panel` writes, and its reader lives in `panel-program`.)
 *   - No legacy reader may be extended to accept new shapes; a new on-disk
 *     form is a new canonical parser, not a new compatibility branch here.
 *   - Historical callers should import this archive explicitly. Temporary
 *     compatibility façades still re-export these readers until the horizon
 *     closes; canonical code must not add new dependencies on those exports.
 *
 * Pure module: no I/O, no clock, no randomness. (The façade's shell supplies
 * all bytes; these parsers only interpret them.)
 */

import { createHash } from "node:crypto";
import { parseArtifactDigest, parseOrchestrationRunId, type ArtifactDigest, type DomainResult, type OrchestrationRunId } from "./orchestration-contract";
import type { CompletedWaveGateRegistration, TaskGraph } from "../types";

// ─────────────────────────────────────────────────────────────────────────
// Archive Section C — legacy wave-gate compatibility migration.
// Former home: state-manager.ts. Used by: complete-wave-gate (the migration
// path that registered a Wave Gate authority for a graph that predates
// active_wave_gate). Deprecation horizon: retire once no pre-registration
// graph can still be completed; the registered-wave-gate paths
// (ActiveWaveGateRegistration / findRegisteredWaveGateCompletionReplay) are
// canonical and stay in state-manager.
// ─────────────────────────────────────────────────────────────────────────

export type LegacyWaveGateCompatibilityAuthority = Readonly<{
  schemaVersion: 1;
  kind: "legacy-wave-gate-compatibility";
  runId: OrchestrationRunId;
  wave: number;
  authorityDigest: ArtifactDigest;
}>;

/** Format-detected legacy anti-corruption parser. It never defaults a Wave:
 * protected current_wave (and an explicit --wave when supplied) must agree. */
export function deriveLegacyWaveGateCompatibilityAuthority(
  graph: TaskGraph,
  requestedWave: number | null,
): DomainResult<LegacyWaveGateCompatibilityAuthority, Readonly<{ kind: "legacy-wave-gate-migration-rejected"; message: string }>> {
  const reject = (message: string): DomainResult<never, Readonly<{ kind: "legacy-wave-gate-migration-rejected"; message: string }>> =>
    Object.freeze({ ok: false, error: Object.freeze({ kind: "legacy-wave-gate-migration-rejected", message }) });
  if (graph.active_wave_gate !== undefined) return reject("active Wave Gate authority already exists");
  if (graph.current_phase !== "execute" || graph.current_wave === undefined) {
    return reject("legacy Wave Gate migration requires explicit protected execute/current_wave authority");
  }
  if (requestedWave !== null && requestedWave !== graph.current_wave) {
    return reject(`requested wave ${requestedWave} does not match protected current_wave ${graph.current_wave}`);
  }
  const wave = graph.current_wave;
  if (graph.tasks.every((task) => task.wave !== wave)) return reject(`legacy Wave ${wave} has no protected Tasks`);
  if (graph.wave_gates[String(wave)] === undefined) return reject(`legacy Wave ${wave} has no wave_gates registration`);
  const serialized = JSON.stringify({
    schemaVersion: 1,
    kind: "legacy-wave-gate-compatibility-source",
    wave,
    // Completion mutates the gate booleans and Task statuses. Compatibility
    // identity is therefore derived only from immutable Wave membership and
    // plan authority so final-Wave replay resolves the original run exactly.
    taskIds: graph.tasks.filter((task) => task.wave === wave).map(({ id }) => id),
    planFile: graph.plan_file ?? graph.phase_artifacts.architecture ?? null,
  });
  const rawDigest = createHash("sha256").update(serialized).digest("hex");
  const runId = parseOrchestrationRunId(`legacy-wave:${rawDigest.slice(0, 32)}`);
  const digest = parseArtifactDigest(rawDigest);
  if (!runId.ok || !digest.ok) return reject("derived legacy Wave Gate compatibility identity is invalid");
  return Object.freeze({ ok: true, value: Object.freeze({
    schemaVersion: 1,
    kind: "legacy-wave-gate-compatibility",
    runId: runId.value,
    wave,
    authorityDigest: digest.value,
  }) });
}

export type LegacyWaveGateCompletionReplayError = Readonly<{
  kind: "legacy-wave-gate-completion-replay-rejected";
  message: string;
}>;

/** Pure terminal-history lookup used before compatibility migration and again
 * after lock races. Only the exact deterministic run/wave/digest plus the
 * completed protected graph shape is an idempotent replay. */
export function findLegacyWaveGateCompletionReplay(
  graph: TaskGraph,
  authority: LegacyWaveGateCompatibilityAuthority,
): DomainResult<CompletedWaveGateRegistration | null, LegacyWaveGateCompletionReplayError> {
  const reject = (message: string): DomainResult<never, LegacyWaveGateCompletionReplayError> =>
    Object.freeze({
      ok: false,
      error: Object.freeze({ kind: "legacy-wave-gate-completion-replay-rejected", message }),
    });
  const history = graph.wave_gate_history ?? [];
  const sameWave = history.find((entry) => entry.wave === authority.wave);
  const sameRun = history.find((entry) => entry.runId === authority.runId);
  if (sameWave !== undefined) {
    if (sameWave.runId !== authority.runId || sameWave.authorityDigest !== authority.authorityDigest) {
      return reject(`Wave ${authority.wave} terminal history conflicts with compatibility replay ${authority.runId}`);
    }
    const gate = graph.wave_gates[String(authority.wave)];
    const waveTasks = graph.tasks.filter((task) => task.wave === authority.wave);
    const exactTerminalGraph = graph.current_phase === "execute" && graph.current_wave === authority.wave &&
      !graph.tasks.some((task) => task.wave > authority.wave) && waveTasks.length > 0 &&
      waveTasks.every((task) => task.status === "completed") && gate !== undefined &&
      gate.impl_complete && gate.tests_passed === true && gate.reviews_complete && !gate.blocked;
    if (!exactTerminalGraph) {
      return reject(`Wave ${authority.wave} history matches run identity but protected terminal graph outcome is contradictory`);
    }
    return Object.freeze({ ok: true, value: sameWave });
  }
  if (sameRun !== undefined) {
    return reject(`Compatibility run ${authority.runId} is terminal for conflicting Wave ${sameRun.wave}`);
  }
  const newer = history.find((entry) => entry.wave > authority.wave);
  if (newer !== undefined) {
    return reject(`Legacy Wave ${authority.wave} is older than completed terminal Wave ${newer.wave}`);
  }
  return Object.freeze({ ok: true, value: null });
}
