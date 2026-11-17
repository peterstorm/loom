/**
 * `helper orchestration add-dependency` (ADR-0081): add `depends_on` edges to
 * a pending Task of the active Wave, audited as a `WavePlanEdit`. A thin shell
 * over the pure `addDependency`: refuse while a subagent is active, then
 * decide and commit in one StateManager update that re-checks quiescence
 * under the lock.
 */

import { taskGraphPath } from "../../config";
import { anyActiveSubagent } from "../../machine/ledger";
import { addDependency, parseAddDependencyArgs, type AddDependency } from "../../core/task-dependency-edit";
import { StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { describeCause } from "../../utils/describe-cause";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "dependency edit";

function outcomeMessage(outcome: AddDependency): string {
  if (outcome.kind === "unchanged") return `${outcome.taskId} already depends on every named Task; nothing changed.\n`;
  const { taskId, dependsOn } = outcome.audit;
  return `${taskId} now depends on ${dependsOn.join(", ")}; status withholds it until ${dependsOn.length === 1 ? "that Task settles" : "they settle"}.\n`;
}

/** The operation over an injected subagent probe; production uses the ledger. */
export function createAddDependencyOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const request = parseAddDependencyArgs(args);
    if (!request.ok) return { kind: "error", message: `add-dependency: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `add-dependency: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `add-dependency: ${refusal}` };
    try {
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const decided = addDependency(locked, request.value);
        if (!decided.ok) throw new Error(decided.error.message);
        return { state: decided.value.kind === "added" ? decided.value.graph : locked, value: decided.value };
      });
      if (outcome.kind === "added") process.stdout.write(`${JSON.stringify(outcome.audit, null, 2)}\n`);
      process.stdout.write(outcomeMessage(outcome));
      return { kind: "allow" };
    } catch (error) {
      return { kind: "error", message: `add-dependency refused without changing state: ${describeCause(error)}` };
    }
  };
}

export const addDependencyOperation = createAddDependencyOperation();
