/**
 * Remove the active task graph state file.
 * Usage: bun cli.ts helper cleanup-state
 *
 * Unlocks (chmod 644) and deletes the state file, deactivating all loom hooks.
 * Use after all tasks complete or to abort a loom run.
 */

import { existsSync, chmodSync, unlinkSync } from "node:fs";
import type { HookHandler } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";

const handler: HookHandler = async () => {
  if (!existsSync(TASK_GRAPH_PATH)) {
    return { kind: "error", message: "No active task graph found" };
  }

  try {
    chmodSync(TASK_GRAPH_PATH, 0o644);
    unlinkSync(TASK_GRAPH_PATH);
  } catch (e) {
    return { kind: "error", message: `cleanup-state: failed to remove state file: ${(e as Error).message}` };
  }

  process.stderr.write(`State file removed: ${TASK_GRAPH_PATH}\n`);
  return { kind: "allow" };
};

export default handler;
