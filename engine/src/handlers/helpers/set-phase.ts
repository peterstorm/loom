/**
 * Set the current phase in the task graph state (the loop-back).
 * Usage: bun cli.ts helper set-phase --phase architecture [--clear-artifact plan-alignment]
 *
 * `core/set-phase.ts` parses and applies the request. It refuses `execute`,
 * since only populate-task-graph may enter that Phase (issue #50).
 * Optional --clear-artifact removes a key from phase_artifacts (for loop-back cleanup).
 */

import type { HookHandler } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import { applySetPhase, parseSetPhaseArgs } from "../../core/set-phase";

const handler: HookHandler = async (_stdin, args) => {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: "No active task graph found" };

  const request = parseSetPhaseArgs(args);
  if (!request.ok) return { kind: "error", message: request.error };
  const { phase } = request.value;

  try {
    await mgr.update((s) => applySetPhase(s, request.value, new Date().toISOString()));
  } catch (e) {
    const msg = `set-phase: failed to write state (phase=${phase}): ${(e as Error).message}`;
    process.stderr.write(msg + "\n");
    return { kind: "error", message: msg };
  }

  process.stderr.write(`Phase set to: ${phase}\n`);
  return { kind: "allow" };
};

export default handler;
