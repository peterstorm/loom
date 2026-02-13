/**
 * Mark subagent as active so PreToolUse can allow Edit/Write from subagents.
 * Also stores task_graph absolute path for cross-repo access.
 */

import { existsSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { HookHandler, SubagentStartInput } from "../../types";
import { TASK_GRAPH_PATH, SUBAGENT_DIR } from "../../config";

const handler: HookHandler = async (stdin) => {
  const input: SubagentStartInput = JSON.parse(stdin);
  const { session_id, agent_id } = input;

  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });

  // Track active agent for cleanup
  if (agent_id) {
    appendFileSync(`${SUBAGENT_DIR}/${session_id}.active`, `${agent_id}\n`);
  }

  // Store task graph absolute path for cross-repo access
  // SubagentStart runs in orchestrator's cwd where task graph exists
  // SubagentStop may run in different repo, needs this path
  const taskGraphFile = `${SUBAGENT_DIR}/${session_id}.task_graph`;
  if (existsSync(TASK_GRAPH_PATH) && !existsSync(taskGraphFile)) {
    writeFileSync(taskGraphFile, resolve(TASK_GRAPH_PATH));
  }

  return { kind: "passthrough" };
};

export default handler;
