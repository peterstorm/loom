/**
 * Validate wave order, dependencies, and review gates before task execution.
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { validateTaskExecution } from "../../core/validate-task-execution";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a spawn-gate route: fail CLOSED. An uncaught
    // parse crash exits 1 (NON-blocking for PreToolUse), waving the Task
    // spawn past wave-order/dependency/review-gate enforcement.
    return {
      kind: "block",
      message: `validate-task-execution: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  return validateTaskExecution({
    prompt: (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "",
    description: (input.tool_input?.description as string) ?? "",
  });
};

export default handler;
