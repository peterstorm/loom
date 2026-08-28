/**
 * Store spec-check findings manually.
 * Usage: bun cli.ts helper store-spec-check <<< "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\n..."
 * Reads SPEC_CHECK_* markers and CRITICAL:/HIGH:/MEDIUM: lines from stdin.
 */

import type { HookHandler } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../../core/spec-check";
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
    `Spec-check stored: wave=${wave} critical=${resolution.specCheck.critical_count} verdict=${resolution.specCheck.verdict}\n`,
  );
  return { kind: "passthrough" };
};

export default handler;
