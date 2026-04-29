/**
 * Block Edit/Write from the MAIN agent during loom orchestration.
 * Subagent Edit/Write is allowed — detected via /tmp/claude-subagents/ flag.
 */

import { existsSync, statSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import { TASK_GRAPH_PATH, SUBAGENT_DIR } from "../../config";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

const handler: HookHandler = async (stdin) => {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  const input: PreToolUseInput = JSON.parse(stdin);

  if (!FILE_TOOLS.has(input.tool_name)) return { kind: "allow" };

  // Allow if a subagent is active.
  // Use "permit" (active grant) instead of "allow" (passive passthrough) so
  // Claude Code's permission layer is bypassed entirely — required for
  // background subagents that have no interactive prompt path and would
  // otherwise be auto-denied even though loom intends to allow them.
  const activeFile = `${SUBAGENT_DIR}/${input.session_id}.active`;
  try {
    if (existsSync(activeFile) && statSync(activeFile).size > 0) {
      return {
        kind: "permit",
        reason: "Subagent active under loom orchestration",
      };
    }
  } catch {}

  return {
    kind: "block",
    message: [
      "BLOCKED: Direct edits not allowed during loom orchestration.",
      "",
      "Use Task tool with appropriate agent for implementation:",
      "  - code-implementer-agent for production code",
      "  - ts-test-agent for tests",
      "  - frontend-agent for UI components",
      "",
      "This ensures proper phase sequencing and review gates.",
    ].join("\n"),
  };
};

export default handler;
