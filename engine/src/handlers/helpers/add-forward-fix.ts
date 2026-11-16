/**
 * `helper orchestration add-forward-fix`: append a Forward Fix Task to the
 * active Wave, so a judgement that failed on code a completed Wave sealed can
 * be fixed without reopening completed history. A thin shell over the pure
 * `addForwardFix`: refuse while a subagent is active, then decide and commit
 * in one StateManager update that re-checks quiescence under the lock.
 *
 * A refusal leaves the locked update as a `ForwardFixRefused`, which carries
 * the typed refusal, so only a refusal is reported as "refused without
 * changing state". Any other failure (a lock, read or write fault) is reported
 * as a failed operation whose effect on the State File is not known here.
 */

import { taskGraphPath } from "../../config";
import { addForwardFix, parseForwardFixArgs, type ForwardFix, type ForwardFixRefusal } from "../../core/forward-fix";
import { anyActiveSubagent } from "../../machine/ledger";
import { StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "forward fix";

/** A refusal decided under the lock: the update aborts and nothing is written. */
class ForwardFixRefused extends Error {
  constructor(readonly refusal: ForwardFixRefusal | Readonly<{ kind: "subagent-active"; message: string }>) {
    super(refusal.message);
  }
}

function outcomeMessage(outcome: ForwardFix): string {
  const { wave, fixTaskId, heldTaskIds } = outcome.audit;
  const held = heldTaskIds.join(", ");
  if (outcome.kind === "already-added") return `Wave ${wave}: Forward Fix ${fixTaskId} for ${held} already added; nothing changed.\n`;
  return `Wave ${wave}: Forward Fix ${fixTaskId} added; ${held} ${heldTaskIds.length === 1 ? "is" : "are"} held until it settles. ` +
    "Run helper orchestration status: it owes the fix's dispatch first, then the held Task's next attempt.\n";
}

/** The operation over an injected subagent probe; production uses the evidence ledger. */
export function createAddForwardFixOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const request = parseForwardFixArgs(args);
    if (!request.ok) return { kind: "error", message: `add-forward-fix: ${request.error}` };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `add-forward-fix: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `add-forward-fix: ${refusal}` };
    try {
      const outcome = await manager.updateAndReturn((locked) => {
        // An observed active subagent is a refusal; a probe that cannot answer
        // propagates as a failure, not as a refusal.
        if (subagentActive(statePath)) {
          throw new ForwardFixRefused({ kind: "subagent-active", message: `A subagent became active before the ${OPERATION} could commit` });
        }
        const decided = addForwardFix(locked, request.value);
        if (!decided.ok) throw new ForwardFixRefused(decided.error);
        return { state: decided.value.kind === "added" ? decided.value.graph : locked, value: decided.value };
      });
      process.stdout.write(`${JSON.stringify(outcome.audit, null, 2)}\n`);
      process.stdout.write(outcomeMessage(outcome));
      return { kind: "allow" };
    } catch (error) {
      if (error instanceof ForwardFixRefused) {
        return { kind: "error", message: `add-forward-fix refused without changing state (${error.refusal.kind}): ${error.refusal.message}` };
      }
      return {
        kind: "error",
        message: `add-forward-fix failed; the State File may or may not have been written, so read it with helper orchestration status ` +
          `before retrying: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export const addForwardFixOperation = createAddForwardFixOperation();
