/**
 * PreToolUse handler: enforce-phase-tools
 *
 * The live half of the guarded skill machine: deny-by-default tool gating
 * within the machine's declared jurisdiction. In a phase, an enforced tool
 * that the phase doesn't list is structurally unavailable — the bad
 * transition doesn't exist.
 *
 * Failure policy: once ANY binding exists for the session, unexpected
 * errors fail CLOSED — a gate that crashes open is no gate. When attribution is impossible (multiple bindings, or any second
 * subagent active in the session — the harness gives tool calls no agent
 * identity), the gate stands down with a stderr note; SubagentStop's
 * per-epoch resolution still applies.
 */

import { existsSync, readdirSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import { allowResult, blockResult, passthroughResult } from "../../types";
import { machinesDir, SUBAGENT_DIR } from "../../config";
import {
  blockExplanation,
  eventsForEpoch,
  foldEvidence,
  fsSessionRegistry,
  isToolAllowed,
  loadMachine,
  machineBindingPath,
  MACHINE_SUFFIX,
  parseSessionId,
  type SessionRegistry,
} from "../../machine";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";

function anyBindingExists(): boolean {
  try {
    if (!existsSync(SUBAGENT_DIR)) return false;
    return readdirSync(SUBAGENT_DIR).some((f) => f.endsWith(MACHINE_SUFFIX));
  } catch (e) {
    // Can't scan the dir (e.g. EACCES/ENOENT on readdir) → assume a binding
    // exists → fail closed below. Log it so the generic downstream
    // "missing/invalid session_id — failing closed" message isn't misleading.
    process.stderr.write(
      `enforce-phase-tools: cannot scan SUBAGENT_DIR (${e instanceof Error ? e.message : String(e)}) — assuming a binding exists, failing closed\n`,
    );
    return true;
  }
}

export const runEnforcePhaseTools = async (
  stdin: string,
  registry: SessionRegistry = fsSessionRegistry,
) => {
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
  // Parse the session id once at this boundary. Missing OR unparseable (raw
  // hook input that fails the SessionId format) is unattributable — same
  // fail-closed policy while any gate is armed, passthrough otherwise.
  const sessionId = session_id ? parseSessionId(session_id) : null;
  if (!sessionId || !tool_name) {
    return anyBindingExists()
      ? blockResult("[loom machine] gate input missing or invalid session_id/tool_name — failing closed")
      : passthroughResult();
  }

  try {
    // The gate acting for this session IS binding activity: reap bindings
    // whose subagent died silently (TTL exceeded) and refresh the activity
    // anchor of live ones — a fully-stale binding file is deleted here, so
    // the fail-closed "file exists but no bindings" check below never fires
    // for a merely-expired binding.
    await registry.refreshBindingActivity(sessionId);

    const bindings = registry.readBindings(sessionId);
    if (bindings.length === 0) {
      // Distinguish "no binding file" (ungated session → passthrough) from
      // "binding file present but zero bindings parsed" (a corrupt binding
      // file must not silently open the gate).
      return existsSync(machineBindingPath(sessionId))
        ? blockResult(`[loom machine] binding file for ${sessionId} exists but contains no parseable bindings — failing closed`)
        : passthroughResult();
    }

    const binding = registry.soleActiveBinding(sessionId);
    if (binding === null) {
      // Contended session: no per-agent attribution possible. Stand down
      // loudly rather than gate one agent on another's evidence.
      return passthroughDiagnostic(`[loom machine] gate standing down for ${sessionId}: contended session\n`);
    }

    const loaded = loadMachine(machinesDir(), binding.agentType);
    if (loaded.kind === "none") {
      // A binding can only exist because a machine existed at bind time
      // (mark-subagent-active binds through the same machinesDir()), so
      // "none" here means the definition vanished — deleted machine file or
      // a re-pointed machines dir. Fail closed: a gate whose machine
      // disappears must not silently disarm.
      return blockResult(
        `[loom machine] machine definition for bound agent "${binding.agentType}" vanished from ${machinesDir()} — failing closed`,
      );
    }
    if (loaded.kind === "invalid") {
      // Fail closed: an invalid machine must not silently disable its guarantees.
      return blockResult(`[loom machine] invalid machine definition — ${loaded.error}`);
    }

    const events = eventsForEpoch(registry.readEvidence(sessionId), binding.epoch);
    const state = foldEvidence(loaded.machine, events);
    if (isToolAllowed(loaded.machine, state, tool_name)) return allowResult();

    return blockResult(blockExplanation(loaded.machine, state, tool_name));
  } catch (e) {
    // A binding exists for this session — an evaluation crash must not open the gate.
    return blockResult(`[loom machine] gate evaluation failed — failing closed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const handler: HookHandler = (stdin) => runEnforcePhaseTools(stdin);

export default handler;
