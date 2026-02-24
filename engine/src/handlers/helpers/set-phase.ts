/**
 * Set the current phase in the task graph state.
 * Usage: bun cli.ts helper set-phase --phase architecture [--clear-artifact plan-alignment]
 *
 * Validates target is a valid Phase, uses StateManager to update current_phase.
 * Optional --clear-artifact removes a key from phase_artifacts (for loop-back cleanup).
 */

import type { HookHandler, Phase } from "../../types";
import { PHASE_ORDER, TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";

function parseArgs(args: string[]): { phase: Phase; clearArtifact: Phase | null } {
  let phase: string | null = null;
  let clearArtifact: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--phase" && args[i + 1]) phase = args[++i];
    else if (args[i] === "--clear-artifact" && args[i + 1]) clearArtifact = args[++i];
  }
  if (!phase || !PHASE_ORDER.includes(phase as Phase)) {
    throw new Error(`Invalid or missing --phase. Valid: ${PHASE_ORDER.join(", ")}`);
  }
  if (clearArtifact && !PHASE_ORDER.includes(clearArtifact as Phase)) {
    throw new Error(`Invalid --clear-artifact. Valid: ${PHASE_ORDER.join(", ")}`);
  }
  return { phase: phase as Phase, clearArtifact: clearArtifact as Phase | null };
}

const handler: HookHandler = async (_stdin, args) => {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: "No active task graph found" };

  let phase: Phase;
  let clearArtifact: Phase | null;
  try {
    ({ phase, clearArtifact } = parseArgs(args));
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }

  try {
    await mgr.update((s) => {
      const newArtifacts = clearArtifact && s.phase_artifacts[clearArtifact]
        ? (({ [clearArtifact]: _, ...rest }) => rest)(s.phase_artifacts)
        : s.phase_artifacts;
      return { ...s, current_phase: phase, phase_artifacts: newArtifacts, updated_at: new Date().toISOString() };
    });
  } catch (e) {
    const msg = `set-phase: failed to write state (phase=${phase}): ${(e as Error).message}`;
    process.stderr.write(msg + "\n");
    return { kind: "error", message: msg };
  }

  process.stderr.write(`Phase set to: ${phase}\n`);
  return { kind: "allow" };
};

export default handler;
