/**
 * Enforce phase ordering: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { validatePhaseOrder } from "../../core/validate-phase-order";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { stripNamespace } from "../../utils/strip-namespace";

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
  });
};

export default handler;

// Re-export for tests that import from handler path
export { detectPhase, checkArtifacts, isPanelAgent, canRunPanelAgent } from "../../core/validate-phase-order";
export type { ArtifactState } from "../../core/validate-phase-order";
