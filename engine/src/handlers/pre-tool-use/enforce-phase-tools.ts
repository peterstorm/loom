/**
 * PreToolUse handler: enforce-phase-tools
 *
 * The live half of the guarded skill machine: deny-by-default tool gating
 * within the machine's declared jurisdiction. In a phase, an enforced tool
 * that the phase doesn't list is structurally unavailable — the bad
 * transition doesn't exist.
 *
 * Failure policy (deliberate, per review): once ANY binding exists for the
 * session, unexpected errors fail CLOSED — a gate that crashes open is no
 * gate. When attribution is impossible (multiple bindings, or any second
 * subagent active in the session — the harness gives tool calls no agent
 * identity), the gate stands down with a stderr note; SubagentStop's
 * per-epoch resolution still applies.
 */

import { existsSync, readdirSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import { allowResult, blockResult, passthroughResult } from "../../types";
import { MACHINES_DIR, SUBAGENT_DIR } from "../../config";
import {
  blockExplanation,
  eventsForEpoch,
  foldEvidence,
  isToolAllowed,
  loadMachine,
  readBindings,
  readEvidence,
  soleActiveBinding,
} from "../../machine";

function anyBindingExists(): boolean {
  try {
    if (!existsSync(SUBAGENT_DIR)) return false;
    return readdirSync(SUBAGENT_DIR).some((f) => f.endsWith(".machine"));
  } catch {
    return true; // can't verify → assume a binding exists → fail closed below
  }
}

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch {
    // Malformed stdin: fail closed only if some session is actually gated —
    // otherwise a harness format change would brick every ungated session.
    return anyBindingExists()
      ? blockResult("[loom machine] gate received malformed hook input — failing closed")
      : passthroughResult();
  }

  const { session_id, tool_name } = input;
  if (!session_id || !tool_name) return passthroughResult();

  try {
    const bindings = readBindings(session_id);
    if (bindings.length === 0) return passthroughResult();

    const binding = soleActiveBinding(session_id);
    if (binding === null) {
      // Contended session: no per-agent attribution possible. Stand down
      // loudly rather than gate one agent on another's evidence.
      process.stderr.write(`[loom machine] gate standing down for ${session_id}: contended session\n`);
      return passthroughResult();
    }

    const loaded = loadMachine(MACHINES_DIR, binding.agentType);
    if (loaded.kind === "none") return passthroughResult(); // stale binding
    if (loaded.kind === "invalid") {
      // Fail closed: an invalid machine must not silently disable its guarantees.
      return blockResult(`[loom machine] invalid machine definition — ${loaded.error}`);
    }

    const events = eventsForEpoch(readEvidence(session_id), binding.epoch);
    const state = foldEvidence(loaded.machine, events);
    if (isToolAllowed(loaded.machine, state, tool_name)) return allowResult();

    return blockResult(blockExplanation(loaded.machine, state, tool_name));
  } catch (e) {
    // A binding exists for this session — an evaluation crash must not open the gate.
    return blockResult(`[loom machine] gate evaluation failed — failing closed: ${(e as Error).message}`);
  }
};

export default handler;
