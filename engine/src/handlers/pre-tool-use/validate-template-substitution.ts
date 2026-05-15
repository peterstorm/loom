/**
 * Validate that Task tool prompts have no unsubstituted template variables.
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { validateTemplateSubstitution } from "../../core/validate-template-substitution";

const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);
  if (input.tool_name !== "Task" && input.tool_name !== "subagent") return { kind: "allow" };

  const prompt = (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "";
  return validateTemplateSubstitution(prompt);
};

export default handler;
