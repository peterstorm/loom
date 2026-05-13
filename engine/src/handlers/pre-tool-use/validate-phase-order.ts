/**
 * Enforce phase ordering: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { validatePhaseOrder } from "../../core/validate-phase-order";
import { stripNamespace } from "../../utils/strip-namespace";

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    process.stderr.write(`validate-phase-order: failed to parse stdin: ${(e as Error).message}\n`);
    return { kind: "allow" };
  }
  if (input.tool_name !== "Task") return { kind: "allow" };

  return validatePhaseOrder({
    agentType: stripNamespace((input.tool_input?.subagent_type as string) ?? ""),
    prompt: (input.tool_input?.prompt as string) ?? "",
  });
};

export default handler;

// Re-export for tests that import from handler path
export { detectPhase, checkArtifacts } from "../../core/validate-phase-order";
export type { ArtifactState } from "../../core/validate-phase-order";
