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

function outcomeMessage(outcome: SpecTraceAmendmentOutcome): string {
  if (outcome.kind === "unchanged") return "Spec trace already matches the requested ownership; nothing written\n";
  const { wave, retiredRunId, changes } = outcome.amendment;
  const retired = retiredRunId === null ? "" : ` and abandoned run ${retiredRunId}`;
  return `Spec trace amended for ${changes.map(({ taskId }) => taskId).join(", ")}; ` +
    `Wave ${wave} review authority${retired} retired. Start the Wave Gate to review the amended scope.\n`;
}

const handler: HookHandler = async (stdin, args) => {
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
  if (anyActiveSubagent(statePath)) {
    return {
      kind: "error",
      message: "Spec trace amendment refused while a subagent is active for this TaskGraph; wait for it to settle and retry",
    };
  }

  try {
    // Observed before the lock, like population: the locked transform reads no
    // mutable source bytes, and the core refuses if spec_file moved meanwhile.
    const specIndex = observeSpecIndex(manager.load().spec_file);
    const outcome = await manager.updateAndReturn((locked) => {
      if (anyActiveSubagent(statePath)) {
        throw new Error("A subagent became active before the spec trace amendment could commit");
      }
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

export default handler;
