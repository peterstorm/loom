/**
 * Release every completed Agent capability: guarded-machine binding,
 * Implementation Attempt sidecar, session TaskGraph pointer lease, and active
 * roster entry. Each owner performs its own lock-protected release so parallel
 * completions cannot nest the non-reentrant session lock.
 */

import type { HookHandler } from "../../types";
import { stripNamespace } from "../../utils/strip-namespace";
import { resolveAgentType } from "../../utils/agent-transcript-path";
import {
  fsSessionRegistry,
  machineBindingPath,
  parseAgentId,
  parseAgentType,
  parseReportedAgentId,
  parseSessionId,
  releasePersistedSessionTaskGraphPointerBinding,
  reportedRosterAgentId,
  type SessionRegistry,
} from "../../machine";
import { removeImplementationAttemptSidecar } from "../../implementation-attempt-sidecar";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const runCleanupSubagentFlag = async (
  stdin: string,
  registry: SessionRegistry = fsSessionRegistry,
  removeSidecar: typeof removeImplementationAttemptSidecar = removeImplementationAttemptSidecar,
  releasePointer: typeof releasePersistedSessionTaskGraphPointerBinding = releasePersistedSessionTaskGraphPointerBinding,
  resolveType: typeof resolveAgentType = resolveAgentType,
) => {
  // Guard the standalone CLI route: dispatch parses stdin before calling
  // handlers, but this handler is also registered directly (KNOWN_HANDLERS),
  // where a bare JSON.parse throw would surface as an uncontextualized
  // "Hook error". Malformed input means the roster entry and any binding
  // cannot be released — say so; the liveness TTL eventually reaps them.
  const parsedInput = parseSubagentStopStdin(stdin);
  if (!parsedInput.ok) {
    return {
      kind: "error" as const,
      message: `cleanup-subagent-flag: invalid SubagentStop input — roster, sidecar, task-graph pointer, and machine binding NOT released (liveness TTL will reap them): ${parsedInput.error}`,
    };
  }
  const input = parsedInput.value;
  const { agent_id } = input;
  // Parse the session id once. An unparseable id can address no session file,
  // so nothing can be released here — the liveness TTL reaps it.
  const sessionId = input.session_id ? parseSessionId(input.session_id) : null;
  if (!sessionId) {
    return {
      kind: "error" as const,
      message: "cleanup-subagent-flag: missing/invalid session id — roster, sidecar, task-graph pointer, and machine binding NOT released (liveness TTL will reap them)",
    };
  }
  if (!agent_id) {
    return {
      kind: "error" as const,
      message: `cleanup-subagent-flag: missing agent_id for ${sessionId} — roster, sidecar, task-graph pointer, and machine-binding cleanup NOT attempted`,
    };
  }

  // Release guarded-machine binding. unbind locks internally (same lock file)
  // and throws failures for this handler to aggregate — do NOT nest it inside another withLock here,
  // the mkdir lock is not reentrant. Parse the identity to the SAME branded
  // types bind used: unbind only compares against already-parsed bindings, so
  // an unparseable id could never have been bound — skipping the call is the
  // exact harmless no-op the old raw-string path produced, and branding both
  // params removes the adjacent-string argument-swap hazard.
  const failures: string[] = [];
  let reportedAgentType: ReturnType<typeof parseAgentType> = null;
  try {
    reportedAgentType = parseAgentType(stripNamespace(resolveType(input)));
  } catch (error) {
    failures.push(`reported agent type observation failed for ${agent_id}/${sessionId}: ${errorMessage(error)}`);
  }
  const boundAgentId = parseAgentId(agent_id);
  let boundAgentType: ReturnType<typeof parseAgentType> = null;
  if (boundAgentId !== null) {
    try {
      const authority = registry.readBindingAuthority(sessionId);
      if (authority.kind === "corrupt") {
        failures.push(
          `machine binding authority ${machineBindingPath(sessionId)} is corrupt; binding NOT released for ${agent_id}/${sessionId} — repair or remove the corrupt file`,
        );
      } else {
        const matchingBindings = authority.bindings
          .filter((binding) => binding.agentId === boundAgentId);
        if (matchingBindings.length === 1) {
          boundAgentType = matchingBindings[0]!.agentType;
          if (reportedAgentType !== null && reportedAgentType !== boundAgentType) {
            failures.push(
              `reported agent_type ${reportedAgentType} disagrees with persisted binding ${boundAgentType} for ${agent_id}/${sessionId}`,
            );
          }
        } else if (matchingBindings.length > 1) {
          failures.push(`machine unbind identity is ambiguous for ${agent_id}/${sessionId}`);
        }
      }
    } catch (error) {
      failures.push(`machine binding lookup failed for ${agent_id}/${sessionId}: ${errorMessage(error)}`);
    }
  }
  if (boundAgentType !== null && boundAgentId !== null) {
    try {
      const release = await registry.unbind(sessionId, boundAgentType, boundAgentId);
      if (release === "not-owned") {
        failures.push(`machine unbind lost exact ownership for ${agent_id}/${sessionId}`);
      }
    } catch (error) {
      failures.push(`machine unbind failed for ${agent_id}/${sessionId}: ${errorMessage(error)}`);
    }
  }

  if (parseReportedAgentId(agent_id) !== null) {
    try {
      removeSidecar(sessionId, agent_id);
    } catch (error) {
      failures.push(`implementation sidecar cleanup failed for ${agent_id}/${sessionId}: ${errorMessage(error)}`);
    }
  }

  try {
    const released = await releasePointer(sessionId, reportedRosterAgentId(agent_id));
    if (released === "ownership-lost") {
      failures.push(`task-graph pointer cleanup lost exact ownership for ${agent_id}/${sessionId}`);
    }
  } catch (error) {
    failures.push(`task-graph pointer cleanup failed for ${agent_id}/${sessionId}: ${errorMessage(error)}`);
  }

  // Each cleanup capability is independent. Attempt roster removal even when
  // unbind or sidecar deletion failed, then return the complete failure set.
  // reportedRosterAgentId mirrors SubagentStart: an id that constructor
  // refused — unparseable, or inside the reserved write-grant namespace — was
  // tracked under its sanitized placeholder, so remove that same placeholder.
  try {
    await registry.removeActive(sessionId, reportedRosterAgentId(agent_id));
  } catch (error) {
    failures.push(`roster cleanup failed for ${agent_id}/${sessionId}: ${errorMessage(error)}`);
  }

  return failures.length === 0
    ? { kind: "passthrough" as const }
    : { kind: "error" as const, message: `cleanup-subagent-flag: ${failures.join("; ")}` };
};

const handler: HookHandler = (stdin) => runCleanupSubagentFlag(stdin);

export default handler;
