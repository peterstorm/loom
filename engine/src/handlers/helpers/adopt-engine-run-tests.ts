/**
 * `helper orchestration adopt-engine-run-tests --reason <text>` (loom#198):
 * freeze engine-run test evidence on a TaskGraph populated before it existed,
 * so from then on only `helper run-tests` runs prove I6 and test verdicts.
 *
 * A thin shell over the pure `adoptEngineRunTestEvidence`: refuse while a
 * subagent is active, then decide and commit in one StateManager update that
 * re-checks quiescence under the lock. The reason is recorded on the field.
 * Idempotent: a graph already in the mode is left as it is.
 */

import { taskGraphPath } from "../../config";
import { anyActiveSubagent } from "../../machine/ledger";
import { adoptEngineRunTestEvidence, type EngineRunAdoption } from "../../core/test-evidence-authority";
import { StateManager } from "../../state-manager";
import type { HookResult } from "../../types";
import { argumentValue, unconsumedValueArguments } from "./cli-args";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

const OPERATION = "engine-run test evidence adoption";
const FLAGS: ReadonlySet<string> = new Set(["--reason"]);

function outcomeMessage(outcome: EngineRunAdoption): string {
  const adopted = outcome.testEvidence.adoptedBy === "population" ? "at population" : "by the operator";
  return outcome.kind === "already-adopted"
    ? `The TaskGraph already admits only engine runs (adopted ${adopted}); nothing changed.\n`
    : "The TaskGraph now admits only engine runs as test evidence: implementation agents run their tests with " +
      "`helper run-tests --files <test file>...`, which their briefs print. Re-render each owed brief before dispatching.\n";
}

/** The operation over an injected subagent probe; production uses the evidence ledger. */
export function createAdoptEngineRunTestsOperation(
  subagentActive: SubagentActivity = anyActiveSubagent,
): (args: readonly string[]) => Promise<HookResult> {
  return async (args) => {
    const unconsumed = unconsumedValueArguments(args, FLAGS);
    if (unconsumed.length > 0) return { kind: "error", message: `adopt-engine-run-tests: unknown or unconsumed argument(s): ${unconsumed.join(" ")}` };
    const reason = argumentValue(args, "--reason");
    if (reason === null) return { kind: "error", message: "adopt-engine-run-tests requires --reason <text>" };
    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `adopt-engine-run-tests: No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: `adopt-engine-run-tests: ${refusal}` };
    try {
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const decided = adoptEngineRunTestEvidence(locked, reason);
        if (!decided.ok) throw new Error(decided.error);
        return { state: decided.value.kind === "adopted" ? decided.value.graph : locked, value: decided.value };
      });
      process.stdout.write(`${JSON.stringify(outcome.testEvidence, null, 2)}\n`);
      process.stdout.write(outcomeMessage(outcome));
      return { kind: "allow" };
    } catch (error) {
      return {
        kind: "error",
        message: `adopt-engine-run-tests refused without changing state: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

export const adoptEngineRunTestsOperation = createAdoptEngineRunTestsOperation();
