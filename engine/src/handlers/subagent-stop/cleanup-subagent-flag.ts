/**
 * Remove agent from active subagent list when it completes.
 * Locked to prevent race with parallel completions.
 */

import type { HookHandler, SubagentStopInput } from "../../types";
import { stripNamespace } from "../../utils/strip-namespace";
import { fsSessionRegistry, parseSessionId, rosterAgentId, type SessionRegistry } from "../../machine";

export const runCleanupSubagentFlag = async (
  stdin: string,
  registry: SessionRegistry = fsSessionRegistry,
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
  // the mkdir lock is not reentrant.
  const agentType = stripNamespace(input.agent_type ?? "");
  if (agentType && agent_id) {
    try {
      await registry.unbind(sessionId, agentType, agent_id);
    } catch (e) {
      process.stderr.write(`cleanup-subagent-flag: unbind failed for ${agent_id}/${sessionId}: ${e}\n`);
    }
  }

  if (!agent_id) return { kind: "passthrough" as const };

  // removeActive locks internally (same per-session lock) and logs its own
  // rewrite failures; a lock-acquisition failure propagates to the
  // dispatcher's safeRun, which reports it without aborting the pipeline.
  // rosterAgentId mirrors SubagentStart: an unparseable id was tracked
  // under its sanitized placeholder, so remove that same placeholder.
  await registry.removeActive(sessionId, rosterAgentId(agent_id));

  return { kind: "passthrough" as const };
};

const handler: HookHandler = (stdin) => runCleanupSubagentFlag(stdin);

export default handler;
