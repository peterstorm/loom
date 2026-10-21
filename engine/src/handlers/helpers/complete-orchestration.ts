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
import type { HookHandler } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";
import { completedGraphArchiveLeaf, judgeOrchestrationCompletion } from "../../core/orchestration-completion";

export async function completeOrchestration(graphPath: string, nowMs: number) {
  const manager = StateManager.fromPath(graphPath);
  if (manager === null) return { kind: "error" as const, message: "No active task graph found" };
  const archived = await manager.archiveAndRemove((graph) => {
    const completion = judgeOrchestrationCompletion(graph);
    return completion.kind === "complete"
      ? { ok: true, value: completedGraphArchiveLeaf(graph, nowMs) }
      : {
          ok: false,
          error: [
            `complete-orchestration: refusing — the orchestration is not finished (${basename(graphPath)} left in place):`,
            ...completion.reasons.map((reason) => `  - ${reason}`),
            "Finish the remaining Waves, or abort deliberately with `helper cleanup-state`.",
          ].join("\n"),
        };
  });
  if (!archived.ok) return { kind: "error" as const, message: archived.error };
  process.stderr.write(
    `Orchestration complete. Archived ${join(dirname(graphPath), archived.value)}; removed ${graphPath}.\n`,
  );
  return { kind: "allow" as const };
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
