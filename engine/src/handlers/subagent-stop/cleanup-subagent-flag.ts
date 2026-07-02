/**
 * Remove agent from active subagent list when it completes.
 * Locked to prevent race with parallel completions.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { HookHandler, SubagentStopInput } from "../../types";
import { SUBAGENT_DIR } from "../../config";
import { withLock } from "../../utils/lock";
import { stripNamespace } from "../../utils/strip-namespace";
import { unbindMachineAgent } from "../../machine";

const handler: HookHandler = async (stdin) => {
  const input: SubagentStopInput = JSON.parse(stdin);
  const { session_id, agent_id } = input;

  const lockFile = `${SUBAGENT_DIR}/${session_id}.cleanup`;

  // Release guarded-machine binding. unbindMachineAgent locks internally
  // (same lock file) and logs its own failures — do NOT nest it inside
  // withLock here, the mkdir lock is not reentrant.
  const agentType = stripNamespace(input.agent_type ?? "");
  if (agentType && agent_id) {
    try {
      await unbindMachineAgent(session_id, agentType, agent_id);
    } catch (e) {
      process.stderr.write(`cleanup-subagent-flag: unbind failed for ${agent_id}/${session_id}: ${e}\n`);
    }
  }

  if (!agent_id) return { kind: "passthrough" };

  const activeFile = `${SUBAGENT_DIR}/${session_id}.active`;

  if (!existsSync(activeFile)) return { kind: "passthrough" };

  await withLock(lockFile, () => {
    try {
      const content = readFileSync(activeFile, "utf-8");
      const remaining = content
        .split("\n")
        .filter((line) => line.trim() !== "" && line.trim() !== agent_id)
        .join("\n");

      if (remaining.trim() === "") {
        unlinkSync(activeFile);
      } else {
        writeFileSync(activeFile, remaining + "\n");
      }
    } catch (e) {
      process.stderr.write(`cleanup-subagent-flag: .active update failed for ${session_id}: ${e}\n`);
    }
  });

  return { kind: "passthrough" };
};

export default handler;
