/**
 * Mark subagent as active so PreToolUse can allow Edit/Write from subagents.
 * Also stores task_graph absolute path for cross-repo access.
 */

import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { HookHandler, SubagentStartInput } from "../../types";
import { TASK_GRAPH_PATH, SUBAGENT_DIR, MACHINES_DIR } from "../../config";
import { stripNamespace } from "../../utils/strip-namespace";
import { bindMachineAgent, loadMachine, markAgentActive } from "../../machine";

const handler: HookHandler = async (stdin) => {
  let input: SubagentStartInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input: nothing can be tracked or bound. Say so loudly —
    // an untracked agent means its SubagentStop cleanup is skipped and any
    // machine binding it should have had never arms.
    process.stderr.write(
      `mark-subagent-active: malformed SubagentStart input — agent not tracked, cleanup skipped, bindings may leak: ${(e as Error).message}\n`,
    );
    return { kind: "passthrough" };
  }
  const { session_id, agent_id } = input;

  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });

  // Track active agent for cleanup — appended under the same per-session
  // lock cleanup uses to rewrite the roster (append-vs-cleanup race).
  if (agent_id) {
    await markAgentActive(session_id, agent_id);
  }

  // Bind guarded skill machine when this agent type ships one (opt-in per
  // agent). An INVALID machine binds too: the PreToolUse gate then fails
  // closed with the parse error, instead of a corrupt machine file silently
  // switching enforcement off. Binding requires agent_id (the epoch key).
  const agentType = stripNamespace(input.agent_type ?? "");
  if (agentType) {
    const loaded = loadMachine(MACHINES_DIR, agentType);
    if (loaded.kind !== "none") {
      if (agent_id) {
        try {
          await bindMachineAgent(session_id, agentType, agent_id);
        } catch (e) {
          // A failed bind must not abort the handler (the .task_graph path
          // below still needs writing) — but it disables gating, so shout.
          process.stderr.write(
            `mark-subagent-active: bindMachineAgent failed — ${agentType} (${agent_id}) will run UNGATED: ${(e as Error).message}\n`,
          );
        }
      } else {
        process.stderr.write(`mark-subagent-active: cannot bind machine for ${agentType} — no agent_id in hook input\n`);
      }
      if (loaded.kind === "invalid") {
        process.stderr.write(`mark-subagent-active: machine invalid (gate will fail closed) — ${loaded.error}\n`);
      }
    }
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
