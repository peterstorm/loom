/**
 * Enforce phase ordering: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute
 *
 * Claude Code wrapper — delegates to core/.
 */

import { existsSync } from "node:fs";
import type { HookHandler, PreToolUseInput, TaskGraph } from "../../types";
import { validatePhaseOrder, type PhaseOrderDeps } from "../../core/validate-phase-order";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";

/**
 * The real protected-state read. It lives HERE rather than in the gate core
 * because `StateManager` is the sole writer of the task graph: keeping the
 * import in the shell means the gate cannot, even accidentally, write the
 * state it exists to judge.
 */
export const realPhaseOrderDeps: PhaseOrderDeps = {
  loadState: (): TaskGraph | null => {
    const statePath = taskGraphPath();
    if (!existsSync(statePath)) return null;
    const manager = StateManager.fromPath(statePath);
    return manager === null ? null : manager.load();
  },
};

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a spawn-gate route: fail CLOSED. Returning
    // allow here would exit 0 and let a Task spawn out of phase order.
    return {
      kind: "block",
      message: `validate-phase-order: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  return validatePhaseOrder({
    agentType: stripNamespace((input.tool_input?.subagent_type as string) ?? (input.tool_input?.agent as string) ?? ""),
    prompt: (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "",
  }, realPhaseOrderDeps);
};

export default handler;

// Re-export for tests that import from handler path
export { detectPhase, checkArtifacts, isPanelAgent, canRunPanelAgent } from "../../core/validate-phase-order";
export type { ArtifactState } from "../../core/validate-phase-order";
