/**
 * `helper orchestration reopen-task`: reopen implemented Tasks of the active
 * Wave for re-implementation, so a Wave Gate advisory or surviving critical
 * on them can be fixed after the run is abandoned. A thin shell over the pure
 * `reopenImplementedTasks`: refuse while a subagent is active, then decide and
 * commit in one StateManager update that re-checks quiescence under the lock.
 */

import { taskGraphPath } from "../../config";
import { anyActiveSubagent } from "../../machine/ledger";
import { parseTaskReopeningArgs, reopenImplementedTasks, type TaskReopening } from "../../core/task-reopening";
import { StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "task reopening";

function outcomeMessage(outcome: TaskReopening): string {
  const { wave, reopenedTaskIds } = outcome.audit;
  const tasks = reopenedTaskIds.join(", ");
  return outcome.kind === "already-reopened"
    ? `Wave ${wave}: ${tasks} already reopened; nothing changed.\n`
    : `Wave ${wave}: ${tasks} reopened for re-implementation. Run helper orchestration brief --task <id> ` +
      "(with --note for the Finding to fix) to dispatch each, then start a fresh Wave Gate once they settle.\n";
}

/** The operation over an injected subagent probe; production uses the evidence ledger. */
export function createReopenTaskOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const request = parseTaskReopeningArgs(args);
    if (!request.ok) return { kind: "error", message: `reopen-task: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `reopen-task: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `reopen-task: ${refusal}` };
    try {
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const decided = reopenImplementedTasks(locked, request.value);
        if (!decided.ok) throw new Error(decided.error.message);
        return { state: decided.value.kind === "reopened" ? decided.value.graph : locked, value: decided.value };
      });
      process.stdout.write(`${JSON.stringify(outcome.audit, null, 2)}\n`);
      process.stdout.write(outcomeMessage(outcome));
      return { kind: "allow" };
    } catch (error) {
      return {
        kind: "error",
        message: `reopen-task refused without changing state: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export const reopenTaskOperation = createReopenTaskOperation();
