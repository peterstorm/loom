/**
 * Remove agent from active subagent list when it completes.
 * Locked to prevent race with parallel completions.
 */

import type { HookHandler, SubagentStopInput } from "../../types";
import { stripNamespace } from "../../utils/strip-namespace";
import { resolveAgentType } from "../../utils/agent-transcript-path";
import {
  fsSessionRegistry,
  parseAgentId,
  parseAgentType,
  parseReportedAgentId,
  parseSessionId,
  reportedRosterAgentId,
  type SessionRegistry,
} from "../../machine";
import { removeImplementationAttemptSidecar } from "../../implementation-attempt-sidecar";

export const runCleanupSubagentFlag = async (
  stdin: string,
  registry: SessionRegistry = fsSessionRegistry,
  removeSidecar: typeof removeImplementationAttemptSidecar = removeImplementationAttemptSidecar,
) => {
  // Guard the standalone CLI route: dispatch parses stdin before calling
  // handlers, but this handler is also registered directly (KNOWN_HANDLERS),
  // where a bare JSON.parse throw would surface as an uncontextualized
  // "Hook error". Malformed input means the roster entry and any binding
  // cannot be released — say so; the liveness TTL eventually reaps them.
  let input: SubagentStopInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    return {
      kind: "error" as const,
      message: `cleanup-subagent-flag: malformed SubagentStop input — roster entry and machine binding NOT released (liveness TTL will reap them): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const { agent_id } = input;
  // Parse the session id once. An unparseable id can address no session file,
  // so nothing can be released here — the liveness TTL reaps it.
  const sessionId = input.session_id ? parseSessionId(input.session_id) : null;
  if (!sessionId) {
    process.stderr.write(
      `cleanup-subagent-flag: missing/invalid session id — roster entry and binding NOT released (liveness TTL will reap them)\n`,
    );
    return { kind: "passthrough" as const };
  }

  // Release guarded-machine binding. unbind locks internally (same lock file)
  // and logs its own failures — do NOT nest it inside another withLock here,
  // the mkdir lock is not reentrant. Parse the identity to the SAME branded
  // types bind used: unbind only compares against already-parsed bindings, so
  // an unparseable id could never have been bound — skipping the call is the
  // exact harmless no-op the old raw-string path produced, and branding both
  // params removes the adjacent-string argument-swap hazard.
  const failures: string[] = [];
  let boundAgentType = agent_id ? parseAgentType(stripNamespace(resolveAgentType(input))) : null;
  const boundAgentId = agent_id ? parseAgentId(agent_id) : null;
  if (boundAgentType === null && boundAgentId !== null) {
    try {
      const matchingBindings = registry.readBindings(sessionId)
        .filter((binding) => binding.agentId === boundAgentId);
      if (matchingBindings.length === 1) boundAgentType = matchingBindings[0]!.agentType;
      else if (matchingBindings.length > 1) {
        failures.push(`machine unbind identity is ambiguous for ${agent_id}/${sessionId}`);
      }
    } catch (error) {
      failures.push(`machine binding lookup failed for ${agent_id}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (boundAgentType && boundAgentId) {
    try {
      await registry.unbind(sessionId, boundAgentType, boundAgentId);
    } catch (error) {
      failures.push(`machine unbind failed for ${agent_id}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!agent_id) return { kind: "passthrough" as const };

  if (parseReportedAgentId(agent_id) !== null) {
    try {
      removeSidecar(sessionId, agent_id);
    } catch (error) {
      failures.push(`implementation sidecar cleanup failed for ${agent_id}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Each cleanup capability is independent. Attempt roster removal even when
  // unbind or sidecar deletion failed, then return the complete failure set.
  // reportedRosterAgentId mirrors SubagentStart: an id that constructor
  // refused — unparseable, or inside the reserved write-grant namespace — was
  // tracked under its sanitized placeholder, so remove that same placeholder.
  try {
    await registry.removeActive(sessionId, reportedRosterAgentId(agent_id));
  } catch (error) {
    failures.push(`roster cleanup failed for ${agent_id}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  return failures.length === 0
    ? { kind: "passthrough" as const }
    : { kind: "error" as const, message: `cleanup-subagent-flag: ${failures.join("; ")}` };
};

const handler: HookHandler = (stdin) => runCleanupSubagentFlag(stdin);

export default handler;
