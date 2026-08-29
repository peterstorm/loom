/**
 * Store spec-check findings manually — the documented operator override.
 * Usage: bun cli.ts helper store-spec-check <<< "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\n..."
 * Reads SPEC_CHECK_* markers and CRITICAL:/HIGH:/MEDIUM: lines from stdin.
 *
 * This route carries no capture-correlated request authority, so
 * `decideSpecCheckManualOverride` decides whether it may write protected state
 * at all: never while a registered Wave Gate owns the Wave, and only with an
 * explicit `SPEC_CHECK_OVERRIDE:` reason for a modern graph.
 */

import type { HookHandler } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { decideSpecCheckManualOverride, parseSpecCheckOutput, reconcileSpecCheck } from "../../core/spec-check";
import { reconcileWaveBlock } from "../../core/wave-gate-model";
import { StateManager } from "../../state-manager";

const handler: HookHandler = async (stdin) => {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const parsed = parseSpecCheckOutput(stdin);
  if (parsed.criticalCount === null) {
    return { kind: "error", message: "SPEC_CHECK_CRITICAL_COUNT marker required" };
  }
  if (parsed.verdict === null) {
    return { kind: "error", message: "SPEC_CHECK_VERDICT marker required" };
  }

  const state = mgr.load();
  const override = decideSpecCheckManualOverride(state, parsed.overrideReason);
  if (override.kind === "refused-active") {
    return {
      kind: "error",
      message: "store-spec-check: a registered Wave Gate owns this Wave, so only its captured " +
        `spec-check evidence may write (${override.problem}) — persist the corrected findings and resume that ` +
        "Run Directory with `helper orchestration resume`, or start a fresh /wave-gate run. spec_check NOT updated",
    };
  }
  if (override.kind === "requires-reason") {
    return {
      kind: "error",
      message: "store-spec-check: a modern TaskGraph makes a manual spec-check write an operator " +
        "override, which must be attributable — add a 'SPEC_CHECK_OVERRIDE: <reason>' line " +
        `(${override.problem}). spec_check NOT updated`,
    };
  }

  const wave = parsed.wave ?? state.current_wave ?? 1;
  const resolution = reconcileSpecCheck(parsed, wave, new Date().toISOString());
  if (resolution.kind === "evidence-failed") {
    return { kind: "error", message: resolution.specCheck.error };
  }

  await mgr.update((state) => ({
    ...state,
    spec_check: resolution.specCheck,
    wave_gates: reconcileWaveBlock(state.wave_gates, state.tasks, resolution.specCheck, wave),
  }));
  process.stderr.write(
    `Spec-check stored: wave=${wave} critical=${resolution.specCheck.critical_count} ` +
      `verdict=${resolution.specCheck.verdict}` +
      `${override.reason === null ? "" : ` (manual operator override: ${override.reason})`}\n`,
  );
  return { kind: "passthrough" };
};

export default handler;
