/**
 * Guard state files from direct modification via Bash tool.
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { guardStateFile } from "../../core/guard-state-file";

const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);
  const command = (input.tool_input?.command as string) ?? "";
  return guardStateFile(command);
};

export default handler;
