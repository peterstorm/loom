/**
 * PreToolUse handler: enforce-phase-tools
 *
 * The live half of the guarded skill machine: deny-by-default tool gating
 * within the machine's declared jurisdiction. In a phase, an enforced tool
 * that the phase doesn't list is structurally unavailable — the bad
 * transition doesn't exist.
 *
 * Known relaxation (documented in the v2 plan): subagents share session_id
 * with the orchestrator, so when MULTIPLE machine-gated agents run in
 * parallel their evidence can't be attributed per agent. In that contended
 * case the gate stands down (passthrough) rather than emit false blocks —
 * SubagentStop auditing still applies per task.
 */

import type { HookHandler, PreToolUseInput } from "../../types";
import { allowResult, blockResult, passthroughResult } from "../../types";
import { MACHINES_DIR } from "../../config";
import {
  activeMachineAgents,
  blockExplanation,
  foldEvidence,
  isToolAllowed,
  loadMachine,
  readEvidence,
} from "../../machine";

const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);
  const { session_id, tool_name } = input;
  if (!session_id || !tool_name) return passthroughResult();

  const bound = activeMachineAgents(session_id);
  if (bound.length === 0) return passthroughResult();

  const distinct = [...new Set(bound)];
  if (distinct.length > 1) return passthroughResult(); // contended: no per-agent attribution

  const loaded = loadMachine(MACHINES_DIR, distinct[0]);
  if (loaded.kind === "none") return passthroughResult(); // stale binding
  if (loaded.kind === "invalid") {
    // Fail closed: an invalid machine must not silently disable its guarantees.
    return blockResult(`[loom machine] invalid machine definition — ${loaded.error}`);
  }

  const state = foldEvidence(loaded.machine, readEvidence(session_id));
  if (isToolAllowed(loaded.machine, state, tool_name)) return allowResult();

  return blockResult(blockExplanation(loaded.machine, state, tool_name));
};

export default handler;
