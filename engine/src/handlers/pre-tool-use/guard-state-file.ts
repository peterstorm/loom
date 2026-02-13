/**
 * Guard state files from direct modification via Bash tool.
 * Allows reads (jq, cat) but blocks writes (>, mv, cp, tee, sed -i, etc.)
 */

import { existsSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import { TASK_GRAPH_PATH, WHITELISTED_HELPERS, STATE_FILE_PATTERNS, WRITE_PATTERNS } from "../../config";

const handler: HookHandler = async (stdin) => {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  const input: PreToolUseInput = JSON.parse(stdin);
  const command = (input.tool_input?.command as string) ?? "";
  if (!command) return { kind: "allow" };

  // Allow whitelisted helper scripts (old .sh and new CLI format)
  if (WHITELISTED_HELPERS.some((h) => command.includes(h))) {
    return { kind: "allow" };
  }

  // Only inspect commands that reference state files
  if (!STATE_FILE_PATTERNS.test(command)) return { kind: "allow" };

  // Block write patterns
  if (WRITE_PATTERNS.test(command)) {
    return {
      kind: "block",
      message: [
        "BLOCKED: Write to state file not allowed during loom workflow.",
        "State is managed by SubagentStop hooks and helper scripts only.",
        "Read access (jq, cat) is allowed.",
      ].join("\n"),
    };
  }

  return { kind: "allow" };
};

export default handler;
