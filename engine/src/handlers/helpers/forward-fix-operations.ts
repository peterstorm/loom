/**
 * The Forward Fix operations, `helper orchestration add-forward-fix` and
 * `withdraw-forward-fix`: thin shells over the pure `addForwardFix` and
 * `withdrawForwardFix`, sharing one transaction. Each command refuses while a
 * subagent is active, then decides and commits in one StateManager update that
 * re-checks quiescence under the lock.
 *
 * A refusal leaves the locked update as a `ForwardFixRefused`, which carries
 * the typed refusal, so only a refusal is reported as "refused without
 * changing state". Any other failure (a lock, read or write fault) is reported
 * as a failed operation whose effect on the State File is not known here.
 */

import { taskGraphPath } from "../../config";
import {
  addForwardFix,
  parseForwardFixArgs,
  parseForwardFixWithdrawalArgs,
  withdrawForwardFix,
  type ForwardFix,
  type ForwardFixRequest,
  type ForwardFixWithdrawalOutcome,
  type ForwardFixWithdrawalRequest,
  type Refusal,
} from "../../core/forward-fix";
import type { DomainResult } from "../../core/orchestration-contract";
import { anyActiveSubagent } from "../../machine/ledger";
import { StateManager } from "../../state-manager";
import type { HookResult, TaskGraph } from "../../types";
import { subagentActiveRefusal, type QuiescentOperation, type SubagentActivity } from "./subagent-quiescence";

/** A refusal decided under the lock: the update aborts and nothing is written. */
class ForwardFixRefused extends Error {
  constructor(readonly refusal: Refusal<string>) {
    super(refusal.message);
  }
}

/** One Forward Fix command: how it parses, decides, what it writes and what it reports. */
type ForwardFixCommand<Request, Outcome> = Readonly<{
  /** The helper name the operator typed, e.g. `add-forward-fix`. */
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
function forwardFixOperation<Request, Outcome>(
  spec: ForwardFixCommand<Request, Outcome>,
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
          throw new ForwardFixRefused({ kind: "subagent-active", message: `A subagent became active before the ${spec.operation} could commit` });
        }
        const decided = spec.decide(locked, request.value);
        if (!decided.ok) throw new ForwardFixRefused(decided.error);
        return { state: spec.written(decided.value) ?? locked, value: decided.value };
      });
      process.stdout.write(spec.report(outcome));
      return { kind: "allow" };
    } catch (error) {
      if (error instanceof ForwardFixRefused) {
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

const ADD_FORWARD_FIX: ForwardFixCommand<ForwardFixRequest, ForwardFix> = {
  command: "add-forward-fix",
  operation: "forward fix",
  parse: parseForwardFixArgs,
  decide: addForwardFix,
  written: (outcome) => outcome.kind === "added" ? outcome.graph : null,
  report: (outcome) => {
    const { wave, fixTaskId, heldTaskIds } = outcome.audit;
    const held = heldTaskIds.join(", ");
    const message = outcome.kind === "already-added"
      ? `Wave ${wave}: Forward Fix ${fixTaskId} for ${held} already added; nothing changed.\n`
      : `Wave ${wave}: Forward Fix ${fixTaskId} added; ${held} ${heldTaskIds.length === 1 ? "is" : "are"} held until it settles. ` +
        "Run helper orchestration status: it owes the fix's dispatch first, then the held Task's next attempt.\n";
    return `${JSON.stringify(outcome.audit, null, 2)}\n${message}`;
  },
};

const WITHDRAW_FORWARD_FIX: ForwardFixCommand<ForwardFixWithdrawalRequest, ForwardFixWithdrawalOutcome> = {
  command: "withdraw-forward-fix",
  operation: "forward fix withdrawal",
  parse: parseForwardFixWithdrawalArgs,
  decide: withdrawForwardFix,
  written: (outcome) => outcome.kind === "withdrawn" ? outcome.graph : null,
  report: (outcome) => {
    const { fixTaskId, heldTaskIds, wave } = outcome.withdrawal.audit;
    const message = outcome.kind === "already-withdrawn"
      ? `Wave ${wave}: Forward Fix ${fixTaskId} already withdrawn; nothing changed.\n`
      : `Wave ${wave}: Forward Fix ${fixTaskId} withdrawn; ${heldTaskIds.join(", ")} no longer held by it. ` +
        "Add a corrected Forward Fix with helper orchestration add-forward-fix if the judgement still needs one.\n";
    return `${JSON.stringify(outcome.withdrawal, null, 2)}\n${message}`;
  },
};

/** `add-forward-fix` over an injected subagent probe; production uses the evidence ledger. */
export const createAddForwardFixOperation = (subagentActive: SubagentActivity = anyActiveSubagent) =>
  forwardFixOperation(ADD_FORWARD_FIX, subagentActive);

/**
 * `withdraw-forward-fix` over an injected subagent probe: withdraw a Forward
 * Fix whose fix Task was never dispatched (for example, one whose text its
 * brief refuses), releasing its hold on the judges.
 */
export const createWithdrawForwardFixOperation = (subagentActive: SubagentActivity = anyActiveSubagent) =>
  forwardFixOperation(WITHDRAW_FORWARD_FIX, subagentActive);

export const addForwardFixOperation = createAddForwardFixOperation();
export const withdrawForwardFixOperation = createWithdrawForwardFixOperation();
