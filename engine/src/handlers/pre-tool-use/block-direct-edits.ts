/**
 * Block Edit/Write from the MAIN agent during loom orchestration.
 * Subagent Edit/Write is allowed — detected via /tmp/claude-subagents/ flag.
 *
 * Claude Code wrapper — delegates to core/.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { shouldBlockDirectEdit } from "../../core/block-direct-edits";

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a guard route: fail CLOSED. A parse crash
    // would exit 1 — NON-blocking for PreToolUse — silently waving the
    // edit past the direct-edit guard.
    return {
      kind: "block",
      message: `block-direct-edits: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return shouldBlockDirectEdit(input.tool_name, input.session_id);
};

export default handler;
