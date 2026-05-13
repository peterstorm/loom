/**
 * Validate wave order, dependencies, and review gates before task execution.
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { validateTaskExecution } from "../../core/validate-task-execution";

const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);
  if (input.tool_name !== "Task") return { kind: "allow" };

  return validateTaskExecution({
    prompt: (input.tool_input?.prompt as string) ?? "",
    description: (input.tool_input?.description as string) ?? "",
  });
};

export default handler;
