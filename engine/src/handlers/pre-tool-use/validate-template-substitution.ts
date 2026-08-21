/**
 * Validate that subagent-spawn prompts have no unsubstituted template variables.
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { validateTemplateSubstitution } from "../../core/validate-template-substitution";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { pathExistsFailClosed, taskGraphPath } from "../../config";

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a spawn-gate route: fail CLOSED. An uncaught
    // parse crash exits 1 (NON-blocking for PreToolUse), letting a Task with
    // unsubstituted template variables spawn.
    return {
      kind: "block",
      message: `validate-template-substitution: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  const prompt = (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "";
  return validateTemplateSubstitution(prompt, pathExistsFailClosed(taskGraphPath()));
};

export default handler;
