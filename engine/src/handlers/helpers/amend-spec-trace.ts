/**
 * Atomically amend one populated v2 TaskGraph's Requirement trace in place.
 * Reads exact ownership JSON from stdin, observes the Spec Index named by the
 * protected spec_file, and writes only through StateManager.
 */

import type { HookHandler } from "../../types";
import { taskGraphPath } from "../../config";
import { StateManager } from "../../state-manager";
import { anyActiveSubagent } from "../../machine/ledger";
import { amendSpecTrace, type SpecTraceAmendmentOutcome } from "../../core/spec-trace-amendment";
import { observeSpecIndex } from "../../orchestration/spec-index-observation";
import { assertQuiescentUnderLock, subagentActiveRefusal, type SubagentActivity } from "./subagent-quiescence";

function outcomeMessage(outcome: SpecTraceAmendmentOutcome): string {
  if (outcome.kind === "unchanged") return "Spec trace already matches the requested ownership; nothing written\n";
  const { wave, retiredRunId, changes } = outcome.amendment;
  const retired = retiredRunId === null ? "" : ` and abandoned run ${retiredRunId}`;
  return `Spec trace amended for ${changes.map(({ taskId }) => taskId).join(", ")}; ` +
    `Wave ${wave} review authority${retired} retired. Start the Wave Gate to review the amended scope.\n`;
}

const OPERATION = "spec trace amendment";

export function createAmendSpecTraceHandler(subagentActive: SubagentActivity = anyActiveSubagent): HookHandler {
  return async (stdin, args) => {
    if (args.length > 0) return { kind: "error", message: "Usage: helper amend-spec-trace < amendment.json" };

    let input: unknown;
    try {
      input = JSON.parse(stdin);
    } catch (error) {
      return {
        kind: "error",
        message: `Invalid spec trace amendment JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const statePath = taskGraphPath();
    const manager = StateManager.fromPath(statePath);
    if (manager === null) return { kind: "error", message: `No task graph at ${statePath}` };
    const refusal = subagentActiveRefusal(subagentActive, statePath, OPERATION);
    if (refusal !== null) return { kind: "error", message: refusal };

    try {
      // Observed before the lock, like population: the locked transform reads no
      // mutable source bytes, and the core refuses if spec_file moved meanwhile.
      const specIndex = observeSpecIndex(manager.load().spec_file);
      const outcome = await manager.updateAndReturn((locked) => {
        assertQuiescentUnderLock(subagentActive, statePath, OPERATION);
        const amended = amendSpecTrace(locked, input, specIndex);
        if (!amended.ok) throw new Error(amended.error.message);
        return { state: amended.value.graph, value: amended.value };
      });
      process.stderr.write(outcomeMessage(outcome));
      return { kind: "passthrough" };
    } catch (error) {
      return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
  };
}

export default createAmendSpecTraceHandler();
