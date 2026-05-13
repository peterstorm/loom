/**
 * Core: Block Edit/Write from the MAIN agent during loom orchestration.
 * Pure function — no stdin parsing.
 */

import { existsSync, statSync } from "node:fs";
import type { HookResult } from "../types";
import { TASK_GRAPH_PATH, SUBAGENT_DIR } from "../config";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "edit", "write"]);

export function shouldBlockDirectEdit(toolName: string, sessionId: string): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  if (!FILE_TOOLS.has(toolName)) return { kind: "allow" };

  // Allow if a subagent is active
  const activeFile = `${SUBAGENT_DIR}/${sessionId}.active`;
  try {
    if (existsSync(activeFile) && statSync(activeFile).size > 0) {
      return { kind: "allow" };
    }
  } catch {}

  return {
    kind: "block",
    message: [
      "BLOCKED: Direct edits not allowed during loom orchestration.",
      "",
      "Use the subagent tool with appropriate agent for implementation:",
      "  - code-implementer-agent for production code",
      "  - ts-test-agent for tests",
      "  - frontend-agent for UI components",
      "",
      "This ensures proper phase sequencing and review gates.",
    ].join("\n"),
  };
}
