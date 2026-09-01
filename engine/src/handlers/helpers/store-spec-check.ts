/**
 * Store spec-check findings manually — the documented operator override.
 * Usage: bun cli.ts helper store-spec-check <<< "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\n..."
 * Reads SPEC_CHECK_* markers and CRITICAL:/HIGH:/MEDIUM: lines from stdin.
 *
 * This route carries no capture-correlated request authority, so
 * `decideSpecCheckManualOverride` decides whether it may write protected state
 * at all: never while a registered Wave Gate owns the Wave, and only with an
 * explicit `SPEC_CHECK_OVERRIDE:` reason inside the machine footer, before its
 * terminal verdict, for a modern graph.
 */

import type { HookHandler, HookResult } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import {
  decideSpecCheckManualOverride,
  parseSpecCheckOutput,
  reconcileSpecCheck,
  type SpecCheckManualOverride,
} from "../../core/spec-check";
import { reconcileWaveBlock } from "../../core/wave-gate-model";
import { StateManager } from "../../state-manager";

type SpecCheckStore = Pick<StateManager, "updateAndReturn">;

type ManualStoreOutcome =
  | Readonly<{ kind: "refused"; override: Exclude<SpecCheckManualOverride, { kind: "allowed" }> }>
  | Readonly<{ kind: "invalid-evidence"; message: string }>
  | Readonly<{
      kind: "stored";
      wave: number;
      criticalCount: number;
      verdict: string;
      overrideReason: string | null;
    }>;

const overrideError = (override: Exclude<SpecCheckManualOverride, { kind: "allowed" }>): string =>
  override.kind === "refused-active"
    ? "store-spec-check: a registered Wave Gate owns this Wave, so only its captured " +
      `spec-check evidence may write (${override.problem}) — persist the corrected findings and resume that ` +
      "Run Directory with `helper orchestration resume`, or start a fresh /wave-gate run. spec_check NOT updated"
    : "store-spec-check: a modern TaskGraph makes a manual spec-check write an operator " +
      "override, which must be attributable — add a 'SPEC_CHECK_OVERRIDE: <reason>' line before the terminal verdict " +
      `(${override.problem}). spec_check NOT updated`;

/** Decide manual authority and commit its evidence under one StateManager lock. */
export async function runStoreSpecCheck(
  stdin: string,
  manager: SpecCheckStore,
  runAt: string = new Date().toISOString(),
): Promise<HookResult> {
  const parsed = parseSpecCheckOutput(stdin);
  if (parsed.criticalCount === null) {
    return { kind: "error", message: "SPEC_CHECK_CRITICAL_COUNT marker required" };
  }
  if (parsed.verdict === null) {
    return { kind: "error", message: "SPEC_CHECK_VERDICT marker required" };
  }

  const outcome = await manager.updateAndReturn<ManualStoreOutcome>((state) => {
    const override = decideSpecCheckManualOverride(state, parsed.overrideReason);
    if (override.kind !== "allowed") {
      return { state, value: Object.freeze({ kind: "refused", override }) };
    }

    const wave = parsed.wave ?? state.current_wave ?? 1;
    const resolution = reconcileSpecCheck(parsed, wave, runAt);
    if (resolution.kind === "evidence-failed") {
      return {
        state,
        value: Object.freeze({ kind: "invalid-evidence", message: resolution.specCheck.error }),
      };
    }
    return {
      state: {
        ...state,
        spec_check: resolution.specCheck,
        wave_gates: reconcileWaveBlock(state.wave_gates, state.tasks, resolution.specCheck, wave),
      },
      value: Object.freeze({
        kind: "stored",
        wave,
        criticalCount: resolution.specCheck.critical_count,
        verdict: resolution.specCheck.verdict,
        overrideReason: override.reason,
      }),
    };
  });

  if (outcome.kind === "refused") return { kind: "error", message: overrideError(outcome.override) };
  if (outcome.kind === "invalid-evidence") return { kind: "error", message: outcome.message };
  process.stderr.write(
    `Spec-check stored: wave=${outcome.wave} critical=${outcome.criticalCount} verdict=${outcome.verdict}` +
      `${outcome.overrideReason === null ? "" : ` (manual operator override: ${outcome.overrideReason})`}\n`,
  );
  return { kind: "passthrough" };
}

const handler: HookHandler = async (stdin) => {
  const manager = StateManager.fromPath(TASK_GRAPH_PATH);
  return manager === null
    ? { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` }
    : runStoreSpecCheck(stdin, manager);
};

export default handler;
