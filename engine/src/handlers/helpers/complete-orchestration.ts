/**
 * Retire a finished orchestration.
 * Usage: bun cli.ts helper complete-orchestration
 *
 * Refuses unless every Task is completed and no Wave Gate run is active. Then,
 * under the TaskGraph lock, it archives the exact graph bytes beside the live
 * graph (`completed_task_graph-<issue>-<stamp>.json`) and removes the live one,
 * which lifts every Loom guard keyed on it. Use `cleanup-state` only to abort
 * an unfinished orchestration; it keeps no copy.
 */

import { basename, dirname, join } from "node:path";
import type { HookHandler, HookResult } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import {
  completedGraphArchiveLeaf,
  judgeOrchestrationCompletion,
  renderCompletionRefusal,
} from "../../core/orchestration-completion";

export async function completeOrchestration(graphPath: string, nowMs: number): Promise<HookResult> {
  const manager = StateManager.fromPath(graphPath);
  if (manager === null) return { kind: "error", message: "No active task graph found" };
  const archived = await manager.archiveAndRemove((graph) => {
    const completion = judgeOrchestrationCompletion(graph);
    return completion.kind === "complete"
      ? { ok: true, value: completedGraphArchiveLeaf(graph, nowMs) }
      : { ok: false, error: renderCompletionRefusal(basename(graphPath), completion.reasons) };
  });
  if (!archived.ok) return { kind: "error", message: archived.error };
  process.stderr.write(
    `Orchestration complete. Archived ${join(dirname(graphPath), archived.value)}; removed ${graphPath}.\n`,
  );
  return { kind: "allow" };
}

const handler: HookHandler = async () => {
  try {
    return await completeOrchestration(TASK_GRAPH_PATH, Date.now());
  } catch (error) {
    return {
      kind: "error",
      message: `complete-orchestration: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export default handler;
