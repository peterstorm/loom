/**
 * Block Edit/Write from the MAIN agent during loom orchestration.
 * Subagent Edit/Write is allowed — detected via /tmp/claude-subagents/ flag.
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { shouldBlockDirectEdit } from "../../core/block-direct-edits";

const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);
  return shouldBlockDirectEdit(input.tool_name, input.session_id);
};

export default handler;
