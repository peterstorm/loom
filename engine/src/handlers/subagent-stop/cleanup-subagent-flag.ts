/**
 * Remove agent from active subagent list when it completes.
 * Locked to prevent race with parallel completions.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { HookHandler, SubagentStopInput } from "../../types";
import { SUBAGENT_DIR } from "../../config";
import { withLock } from "../../utils/lock";

const handler: HookHandler = async (stdin) => {
  const input: SubagentStopInput = JSON.parse(stdin);
  const { session_id, agent_id } = input;

  if (!agent_id) return { kind: "passthrough" };

  const activeFile = `${SUBAGENT_DIR}/${session_id}.active`;
  const lockFile = `${SUBAGENT_DIR}/${session_id}.cleanup`;

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
    } catch {}
  });

  return { kind: "passthrough" };
};

export default handler;
