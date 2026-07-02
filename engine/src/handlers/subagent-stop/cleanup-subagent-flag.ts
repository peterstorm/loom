/**
 * Remove agent from active subagent list when it completes.
 * Locked to prevent race with parallel completions.
 */

import type { HookHandler, SubagentStopInput } from "../../types";
import { stripNamespace } from "../../utils/strip-namespace";
import { removeActiveAgent, rosterAgentId, unbindMachineAgent } from "../../machine";

const handler: HookHandler = async (stdin) => {
  const input: SubagentStopInput = JSON.parse(stdin);
  const { session_id, agent_id } = input;

  // Release guarded-machine binding. unbindMachineAgent locks internally
  // (same lock file) and logs its own failures — do NOT nest it inside
  // another withLock here, the mkdir lock is not reentrant.
  const agentType = stripNamespace(input.agent_type ?? "");
  if (agentType && agent_id) {
    try {
      await unbindMachineAgent(session_id, agentType, agent_id);
    } catch (e) {
      process.stderr.write(`cleanup-subagent-flag: unbind failed for ${agent_id}/${session_id}: ${e}\n`);
    }
  }

  if (!agent_id) return { kind: "passthrough" };

  // removeActiveAgent locks internally (same per-session lock) and logs its
  // own rewrite failures; a lock-acquisition failure propagates to the
  // dispatcher's safeRun, which reports it without aborting the pipeline.
  // rosterAgentId mirrors SubagentStart: an unparseable id was tracked
  // under its sanitized placeholder, so remove that same placeholder.
  await removeActiveAgent(session_id, rosterAgentId(agent_id));

  return { kind: "passthrough" };
};

export default handler;
