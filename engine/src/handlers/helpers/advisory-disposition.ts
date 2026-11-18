/**
 * `helper orchestration disposition` (ADR-0090): record the operator's
 * decision on advisories of the active Wave on the TaskGraph. A thin shell
 * over the pure `recordAdvisoryDispositions`: parse stdin, refuse while a
 * subagent is active, observe each named Task's reviewed workspace with the
 * observer Wave review issuance uses (the anchor bytes), then decide and
 * commit in one StateManager update that re-checks quiescence under the lock.
 */

import { taskGraphPath } from "../../config";
import { anyActiveSubagent } from "../../machine/ledger";
import { advisoryDecisionTasks } from "../../core/advisory-disposition";
import {
  parseDispositionInput,
  recordAdvisoryDispositions,
  type DispositionOutcome,
} from "../../core/advisory-disposition-record";
import type { ReviewedWorkspaceObservation } from "../../core/reviewed-workspace";
import { StateManager } from "../../state-manager";
import type { HookResult, Task } from "../../types";
import { describeCause } from "../../utils/describe-cause";
import { observeReviewedWorkspace } from "./reviewed-workspace";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "advisory disposition";

/** Reads the reviewed workspace of each Task it is given; production reads the repository. */
export type ReviewedWorkspaceObserver = (tasks: readonly Task[]) => readonly ReviewedWorkspaceObservation[];

/** The operation over an injected subagent probe and workspace observer; production uses the ledger and the repository. */
export function createAdvisoryDispositionOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
  observe: ReviewedWorkspaceObserver = (tasks) => observeReviewedWorkspace(tasks),
): (stdin: string) => Promise<HookResult> {
  return async (stdin) => {
    const request = parseDispositionInput(stdin);
    if (!request.ok) return { kind: "error", message: `disposition: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `disposition: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `disposition: ${refusal}` };
    let outcome: DispositionOutcome;
    try {
      const graph = manager.load();
      const named = graph.current_wave === undefined
        ? []
        : advisoryDecisionTasks(graph, graph.current_wave).filter((task) => request.value.some(({ taskId }) => taskId === task.id));
      const workspaces = observe(named);
      outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const decided = recordAdvisoryDispositions(locked, request.value, workspaces);
        if (!decided.ok) throw new Error(decided.error.message);
        return { state: decided.value.graph, value: decided.value };
      });
    } catch (error) {
      return { kind: "error", message: `disposition refused without changing state: ${describeCause(error)}` };
    }
    // Reported only once committed: a failed write here can never read as a refusal.
    process.stdout.write(`${JSON.stringify({
      kind: "advisory-dispositions-recorded",
      recorded: outcome.recorded,
      unchanged: outcome.unchanged,
    }, null, 2)}\n`);
    return { kind: "allow" };
  };
}

export const advisoryDispositionOperation = createAdvisoryDispositionOperation();
