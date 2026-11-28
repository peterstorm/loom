/**
 * `helper orchestration amend-export-binding` (ADR-0105): drop or rename one
 * export of a pending Task's Export Binding in the live TaskGraph, audited as
 * a `WavePlanEdit`. A thin shell over the pure `amendExportBinding`: refuse
 * while a subagent is active, then decide and commit in one StateManager
 * update that re-checks quiescence under the lock.
 */

import { taskGraphPath } from "../../config";
import {
  amendExportBinding,
  parseExportBindingAmendmentArgs,
  type ExportBindingAmendmentOutcome,
} from "../../core/export-binding-amendment";
import { anyActiveSubagent } from "../../machine/ledger";
import { StateManager } from "../../state-manager";
import type { ExportBindingChange } from "../../core/skeleton/types";
import type { HookResult } from "../../types";
import { describeCause } from "../../utils/describe-cause";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "export binding amendment";

const describeChange = (change: ExportBindingChange): string =>
  change.kind === "dropped" ? `dropped '${change.name}'` : `renamed '${change.name}' to '${change.to}'`;

function outcomeMessage(outcome: ExportBindingAmendmentOutcome): string {
  if (outcome.kind === "unchanged") {
    return `${outcome.taskId}'s binding of ${outcome.path} is already amended (${describeChange(outcome.change)}); nothing changed.\n`;
  }
  const { taskId, path, contract, change, after } = outcome.audit;
  const left = after.length === 0
    ? `${path} is no longer bound; the skeleton the engine wrote there is ${taskId}'s own code to replace`
    : `${path} now binds ${after.map(({ name, alias }) => `${name}: ${alias}`).join(", ")} to ${contract}`;
  return `${taskId}: ${describeChange(change)}. ${left}. Dispatch it from helper orchestration brief --task ${taskId}.\n`;
}

/** The operation over an injected subagent probe; production uses the ledger. */
export function createAmendExportBindingOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const request = parseExportBindingAmendmentArgs(args);
    if (!request.ok) return { kind: "error", message: `amend-export-binding: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `amend-export-binding: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `amend-export-binding: ${refusal}` };
    try {
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const decided = amendExportBinding(locked, request.value);
        if (!decided.ok) throw new Error(decided.error.message);
        return { state: decided.value.kind === "amended" ? decided.value.graph : locked, value: decided.value };
      });
      if (outcome.kind === "amended") process.stdout.write(`${JSON.stringify(outcome.audit, null, 2)}\n`);
      process.stdout.write(outcomeMessage(outcome));
      return { kind: "allow" };
    } catch (error) {
      return { kind: "error", message: `amend-export-binding refused without changing state: ${describeCause(error)}` };
    }
  };
}

export const amendExportBindingOperation = createAmendExportBindingOperation();
