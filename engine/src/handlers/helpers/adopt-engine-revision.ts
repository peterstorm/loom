/**
 * `helper orchestration adopt-engine-revision --reason <text>` (loom#198,
 * Cause 4): continue a TaskGraph on the engine revision running now. The
 * State File's write boundary refuses every write while the graph is pinned
 * to another revision; this is the one audited way to move the pin. It also
 * gives a graph populated before pins existed its first pin.
 *
 * A thin shell over the pure `adoptEngineRevision`: refuse while a subagent
 * is active, then decide and commit in one StateManager update that re-checks
 * quiescence under the lock. The write itself carries the new pin, so the
 * write boundary admits it. Idempotent: a graph already pinned to the running
 * revision is left as it is.
 */

import { taskGraphPath } from "../../config";
import { adoptEngineRevision, type EngineRevisionAdoptionOutcome } from "../../core/engine-revision-pin";
import { anyActiveSubagent } from "../../machine/ledger";
import { runningEngineIdentity, StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { argumentValue, unconsumedValueArguments } from "./cli-args";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "engine revision adoption";
const FLAGS: ReadonlySet<string> = new Set(["--reason"]);

function outcomeMessage(outcome: EngineRevisionAdoptionOutcome): string {
  if (outcome.kind === "already-pinned") return `The TaskGraph is already pinned to the running engine ${outcome.revision}; nothing changed.\n`;
  const from = outcome.adoption.from === null ? "no pin" : outcome.adoption.from;
  return `The TaskGraph moved from ${from} to the running engine ${outcome.adoption.to}. ` +
    "Hooks and helpers on this engine may write it again; re-read `helper orchestration status` before the next dispatch.\n";
}

/** The operation over an injected subagent probe and running revision; production uses the ledger and the installed package. */
export function createAdoptEngineRevisionOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
  runningRevision: () => string = () => runningEngineIdentity().revision,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const unconsumed = unconsumedValueArguments(args, FLAGS);
    if (unconsumed.length > 0) return { kind: "error", message: `adopt-engine-revision: unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
    const reason = argumentValue(args, "--reason");
    if (reason === null) return { kind: "error", message: "adopt-engine-revision requires --reason <text>" };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `adopt-engine-revision: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `adopt-engine-revision: ${refusal}` };
    try {
      const revision = runningRevision();
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const decided = adoptEngineRevision(locked, revision, reason);
        if (!decided.ok) throw new Error(decided.error);
        return { state: decided.value.kind === "adopted" ? decided.value.graph : locked, value: decided.value };
      });
      if (outcome.kind === "adopted") process.stdout.write(`${JSON.stringify(outcome.adoption, null, 2)}\n`);
      process.stdout.write(outcomeMessage(outcome));
      return { kind: "allow" };
    } catch (error) {
      return {
        kind: "error",
        message: `adopt-engine-revision refused without changing state: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export const adoptEngineRevisionOperation = createAdoptEngineRevisionOperation();
