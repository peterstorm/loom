/**
 * `helper orchestration rescope-task` (loom#198, Cause 3): add files to, or
 * remove files from, one pending Task's `file_list`, audited as a
 * `WavePlanEdit`. A thin shell over the pure `rescopeTask`:
 *
 * 1. refuse while a subagent is active;
 * 2. read the added files at the Task's `start_sha` when its population
 *    baseline must be extended (`rescopeBaselineDuty`), outside the lock,
 *    because Git reads are slow;
 * 3. decide and commit in one StateManager update that re-checks quiescence
 *    under the lock. The decision refuses baselines read at any revision but
 *    the locked Task's `start_sha`, so a Task re-registered in between never
 *    takes bytes from the wrong commit.
 */

import { observeTaskGraphProjectBoundary, taskGraphPath } from "../../config";
import { anyActiveSubagent } from "../../machine/ledger";
import {
  parseTaskRescopeArgs,
  rescopeBaselineDuty,
  rescopeTask,
  type ObservedBaselines,
  type RescopeBaselineDuty,
  type TaskRescope,
} from "../../core/task-rescope";
import { StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { describeCause } from "../../utils/describe-cause";
import { captureDeclaredArtifactBaselineAtRevision } from "../../utils/declared-artifact-snapshot";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "task re-scope";

/** Reads `duty.paths` as Git held them at `duty.revision`, in the repository owning `statePath`. */
export type BaselineReader = (statePath: string, duty: RescopeBaselineDuty) => ObservedBaselines;

const readAtRevision: BaselineReader = (statePath, duty) => {
  const boundary = observeTaskGraphProjectBoundary(statePath);
  if (boundary.kind !== "git-repository") {
    throw new Error("the Task carries a population baseline, so its added files must be read from Git, and the TaskGraph is not in a Git repository");
  }
  return Object.freeze({
    revision: duty.revision,
    entries: captureDeclaredArtifactBaselineAtRevision(boundary.root, duty.revision, duty.paths),
  });
};

function outcomeMessage(outcome: TaskRescope): string {
  if (outcome.kind === "unchanged") return `${outcome.taskId}'s file_list already matches; nothing changed.\n`;
  const { taskId, added, removed, sealed = [] } = outcome.audit;
  const changes = [
    ...(added.length === 0 ? [] : [`added ${added.join(", ")}`]),
    ...(sealed.length === 0 ? [] : [`sealed by a completed Wave: ${sealed.join(", ")}`]),
    ...(removed.length === 0 ? [] : [`removed ${removed.join(", ")}`]),
  ].join("; ");
  return `${taskId} re-scoped: ${changes}. Dispatch it from helper orchestration brief --task ${taskId}.\n`;
}

/** The operation over an injected subagent probe and baseline reader; production uses the ledger and Git. */
export function createRescopeTaskOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
  readBaselines: BaselineReader = readAtRevision,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const request = parseTaskRescopeArgs(args);
    if (!request.ok) return { kind: "error", message: `rescope-task: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `rescope-task: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `rescope-task: ${refusal}` };
    try {
      const duty = rescopeBaselineDuty(manager.load(), request.value);
      const observed = duty === null ? null : readBaselines(manager.getPath(), duty);
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const decided = rescopeTask(locked, request.value, observed);
        if (!decided.ok) throw new Error(decided.error.message);
        return { state: decided.value.kind === "rescoped" ? decided.value.graph : locked, value: decided.value };
      });
      if (outcome.kind === "rescoped") process.stdout.write(`${JSON.stringify(outcome.audit, null, 2)}\n`);
      process.stdout.write(outcomeMessage(outcome));
      return { kind: "allow" };
    } catch (error) {
      return { kind: "error", message: `rescope-task refused without changing state: ${describeCause(error)}` };
    }
  };
}

export const rescopeTaskOperation = createRescopeTaskOperation();
