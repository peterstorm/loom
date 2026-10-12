/**
 * PreToolUse handler: enforce-phase-tools
 *
 * The live half of the guarded skill machine: deny-by-default tool gating
 * within the machine's declared jurisdiction. In a phase, an enforced tool
 * that the phase doesn't list is structurally unavailable — the bad
 * transition doesn't exist.
 *
 * Failure policy: once ANY binding exists for the session, unexpected
 * errors fail CLOSED — a gate that crashes open is no gate.
 *
 * Attribution is the recorder's (`attributeEvidence` → `phaseGateTarget`): a
 * call reporting its caller's `agent_id` is judged against that caller's own
 * machine, so parallel subagents stay gated. Only a call with no `agent_id`
 * (the main agent, or an older harness) falls back to the session-wide
 * sole-active rule, and stands down with a stderr note when the session is
 * contended. A reported caller that runs no machine is never judged by a
 * sibling's.
 */

import { existsSync, readdirSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import { allowResult, blockResult, passthroughResult } from "../../types";
import { machinesDir, SUBAGENT_DIR } from "../../config";
import {
  attributeEvidence,
  blockExplanation,
  eventsForEpoch,
  foldEvidence,
  fsSessionRegistry,
  isToolAllowed,
  loadMachine,
  machineBindingPath,
  MACHINE_SUFFIX,
  parseCallerIdentity,
  parseSessionId,
  phaseGateTarget,
  type SessionRegistry,
} from "../../machine";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";

function anyBindingExists(): boolean {
  try {
    // `readdirSync` is the probe: `existsSync` never throws, so an EACCES /
    // ELOOP / ENOTDIR / EIO on the directory itself would have returned `false`
    // right past the fail-closed fallback this catch exists to reach. ENOENT
    // stays the one genuinely-absent answer.
    return readdirSync(SUBAGENT_DIR).some((f) => f.endsWith(MACHINE_SUFFIX));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Can't scan the dir (EACCES, ELOOP, ENOTDIR, EIO) → assume a binding
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

    const target = phaseGateTarget(attributeEvidence(
      parseCallerIdentity(input.agent_id),
      registry.readBindingAuthority(sessionId),
      registry.readActiveRoster(sessionId),
    ));
    if (target.kind === "pass") return passthroughResult();
    if (target.kind === "stand-down") {
      // No sound attribution: stand down loudly rather than gate one agent
      // on another's evidence.
      return passthroughDiagnostic(`[loom machine] gate standing down for ${sessionId}: ${target.reason}\n`);
    }
    if (target.kind === "fail-closed") {
      return blockResult(`[loom machine] gate evaluation failed — failing closed: ${target.reason}`);
    }
    const { binding } = target;

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
