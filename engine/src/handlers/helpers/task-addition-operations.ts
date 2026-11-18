/**
 * `helper orchestration add-task` and `withdraw-task` (ADR-0086): thin shells
 * over the pure `addTask` and `withdrawTask`, sharing one transaction. Each
 * command refuses while a subagent is active, then decides and commits in one
 * StateManager update that re-checks quiescence under the lock.
 *
 * A refusal leaves the locked update as a `PlanChangeRefused`, which carries
 * the typed refusal, so only a refusal is reported as "refused without
 * changing state". Any other failure (a lock, read or write fault) is reported
 * as a failed operation whose effect on the State File is not known here.
 */

import { taskGraphPath } from "../../config";
import {
  addTask,
  parseAddTaskArgs,
  parseWithdrawTaskArgs,
  withdrawTask,
  type AddTask,
  type AddTaskRequest,
  type Refusal,
  type WithdrawTask,
  type WithdrawTaskRequest,
} from "../../core/task-addition";
import type { DomainResult } from "../../core/orchestration-contract";
import { anyActiveSubagent } from "../../machine/ledger";
import { StateManager } from "../../state-manager";
import type { HookResult, TaskGraph } from "../../types";
import { subagentActiveRefusal, type QuiescentOperation, type SubagentActivity } from "./subagent-quiescence";

/** A refusal decided under the lock: the update aborts and nothing is written. */
class PlanChangeRefused extends Error {
  constructor(readonly refusal: Refusal<string>) {
    super(refusal.message);
  }
}

/** One roster command: how it parses, decides, what it writes and what it reports. */
type RosterCommand<Request, Outcome> = Readonly<{
  /** The helper name the operator typed, e.g. `add-task`. */
  command: string;
  /** The operation as quiescence refusals name it. */
  operation: QuiescentOperation;
  parse: (args: readonly string[]) => DomainResult<Request, string>;
  decide: (graph: TaskGraph, request: Request) => DomainResult<Outcome, Refusal<string>>;
  /** The graph to persist, or null when the outcome is a replay with nothing to write. */
  written: (outcome: Outcome) => TaskGraph | null;
  /** What stdout says about a committed or replayed outcome. */
  report: (outcome: Outcome) => string;
}>;

/** The shared transaction: parse, quiescence before and under the lock, decide, commit, report. */
function rosterOperation<Request, Outcome>(
  spec: RosterCommand<Request, Outcome>,
  subagentActive: SubagentActivity,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const request = spec.parse(args);
    if (!request.ok) return { kind: "error", message: `${spec.command}: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `${spec.command}: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, spec.operation);
    if (refusal !== null) return { kind: "error", message: `${spec.command}: ${refusal}` };
    try {
      const outcome = await manager.updateAndReturn((locked) => {
        // An observed active subagent is a refusal; a probe that cannot answer
        // propagates as a failure, not as a refusal.
        if (subagentActive(statePath)) {
          throw new PlanChangeRefused({ kind: "subagent-active", message: `A subagent became active before ${spec.operation} could commit` });
        }
        const decided = spec.decide(locked, request.value);
        if (!decided.ok) throw new PlanChangeRefused(decided.error);
        return { state: spec.written(decided.value) ?? locked, value: decided.value };
      });
      process.stdout.write(spec.report(outcome));
      return { kind: "allow" };
    } catch (error) {
      if (error instanceof PlanChangeRefused) {
        return { kind: "error", message: `${spec.command} refused without changing state (${error.refusal.kind}): ${error.refusal.message}` };
      }
      return {
        kind: "error",
        message: `${spec.command} failed; the State File may or may not have been written, so read it with helper orchestration status ` +
          `before retrying: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

const ADD_TASK: RosterCommand<AddTaskRequest, AddTask> = {
  command: "add-task",
  operation: "adding a Task",
  parse: parseAddTaskArgs,
  decide: addTask,
  written: (outcome) => (outcome.kind === "added" ? outcome.graph : null),
  report: (outcome) => {
    const { wave, taskId, dependents } = outcome.edit;
    if (outcome.kind === "already-added") return `Wave ${wave}: ${taskId} already added; nothing changed.\n`;
    const waiting = dependents.length === 0 ? "" : ` ${dependents.join(", ")} now wait${dependents.length === 1 ? "s" : ""} for it.`;
    return `Wave ${wave}: ${taskId} added.${waiting} Dispatch it from helper orchestration brief.\n`;
  },
};

const WITHDRAW_TASK: RosterCommand<WithdrawTaskRequest, WithdrawTask> = {
  command: "withdraw-task",
  operation: "withdrawing a Task",
  parse: parseWithdrawTaskArgs,
  decide: withdrawTask,
  written: (outcome) => (outcome.kind === "withdrawn" ? outcome.graph : null),
  report: (outcome) => {
    const { wave, taskId } = outcome;
    if (outcome.kind === "already-withdrawn") return `Wave ${wave}: ${taskId} already withdrawn; nothing changed.\n`;
    const released = outcome.released.length === 0
      ? "no Task waited for it."
      : `${outcome.released.join(", ")} no longer wait${outcome.released.length === 1 ? "s" : ""} for it.`;
    return `Wave ${wave}: ${taskId} withdrawn; ${released}\n`;
  },
};

/** `add-task` over an injected subagent probe; production uses the evidence ledger. */
export const createAddTaskOperation = (subagentActive: SubagentActivity = anyActiveSubagent) =>
  rosterOperation(ADD_TASK, subagentActive);

/** `withdraw-task` over an injected subagent probe: withdraw an added Task that was never dispatched. */
export const createWithdrawTaskOperation = (subagentActive: SubagentActivity = anyActiveSubagent) =>
  rosterOperation(WITHDRAW_TASK, subagentActive);

export const addTaskOperation = createAddTaskOperation();
export const withdrawTaskOperation = createWithdrawTaskOperation();
