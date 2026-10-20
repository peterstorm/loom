/**
 * PostToolUse on the orchestrator's Task/Agent calls: hand the model every
 * stop-check note its session's agents left (#121). A SubagentStop
 * `systemMessage` reaches only the operator's terminal, so without this the
 * orchestrating session could not tell that an I7 run timed out or never
 * launched. The notes reach the model as `additionalContext` and the operator
 * as a `systemMessage`.
 *
 * Fail-open: this is context, never a gate. A sidecar it cannot read is named
 * to both, and the tool result stands.
 */

import { CLAUDE_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { renderStopCheckNotes } from "../../core/stop-check-note";
import { drainStopCheckNotes } from "../../stop-check-note-sidecar";
import { passthroughResult, postToolUseContextResult, type HookHandler, type HookResult } from "../../types";

/** The notes for one PostToolUse input, drained from `directory`. Total. */
export function surfaceStopCheckNotes(raw: unknown, directory?: string): HookResult {
  if (typeof raw !== "object" || raw === null) return passthroughResult();
  const { session_id: sessionId, tool_name: toolName } = raw as Readonly<Record<string, unknown>>;
  if (typeof sessionId !== "string" || sessionId === "" || typeof toolName !== "string" || !CLAUDE_SPAWN_TOOLS.has(toolName)) {
    return passthroughResult();
  }
  const { notes, faults } = drainStopCheckNotes(sessionId, directory);
  const unread = faults.length === 0 ? null : `Loom could not read ${faults.length} stop-check note(s): ${faults.join("; ")}`;
  const [first, ...rest] = notes;
  if (first === undefined) return unread === null ? passthroughResult() : postToolUseContextResult(unread, unread);
  const rendered = [renderStopCheckNotes([first, ...rest]), ...(unread === null ? [] : [unread])].join("\n");
  return postToolUseContextResult(rendered, rendered);
}

const handler: HookHandler = async (stdin) => {
  try {
    return surfaceStopCheckNotes(JSON.parse(stdin) as unknown);
  } catch (error) {
    return passthroughResult(`Loom stop-check notes were not surfaced: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export default handler;
