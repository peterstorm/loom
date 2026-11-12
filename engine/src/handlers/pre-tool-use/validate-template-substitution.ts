/**
 * Validate that subagent-spawn prompts have no unsubstituted template variables.
 *
 * Claude Code wrapper — delegates to core/. A brief marker is judged as the
 * brief it expands to.
 */

import type { HookHandler } from "../../types";
import { failClosedInput } from "./pre-tool-use-input";
import { validateTemplateSubstitution } from "../../core/validate-template-substitution";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { pathExistsFailClosed, taskGraphPath } from "../../config";
import { withBriefMarkerExpanded } from "./implementation-brief-marker";

const handler: HookHandler = async (stdin) => {
  // Malformed hook input on a spawn-gate route: fail CLOSED. An uncaught
  // parse crash exits 1 (NON-blocking for PreToolUse), letting a Task with
  // unsubstituted template variables spawn.
  const parsed = failClosedInput("validate-template-substitution", stdin);
  if (!parsed.ok) return parsed.block;
  const { input } = parsed;
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  const prompt = (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "";
  return validateTemplateSubstitution(prompt, pathExistsFailClosed(taskGraphPath()));
};

export default withBriefMarkerExpanded("validate-template-substitution", handler);
