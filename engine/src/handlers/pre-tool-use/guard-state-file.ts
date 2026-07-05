/**
 * Guard state files from direct modification via Bash tool.
 *
 * Claude Code wrapper — delegates to core/ for the guard decision, then
 * stamps the call-start time for this tool call (the report-freshness
 * ordering check in record-evidence consumes it: a disk artifact may vouch
 * for a test run only when its mtime is at/after the call start).
 *
 * The stamp is written AFTER the guard decision is computed and is
 * best-effort fail-open WITH a stderr line — a thrown stamp write can never
 * turn the guard's block into a pass or vice versa, and a missing stamp
 * only ever makes the recorder REJECT artifacts (fail closed downstream).
 */

import type { HookHandler, HookResult, PreToolUseInput } from "../../types";
import { guardStateFile } from "../../core/guard-state-file";
import { fsSessionRegistry, parseSessionId, type SessionRegistry } from "../../machine";

/**
 * Best-effort call-start stamp: only when the session id parses and the
 * harness supplied a tool_use_id. toolUseId is untrusted text — it is
 * stored as a JSON map key only, never used in a filesystem path.
 */
export async function stampCallStart(
  input: PreToolUseInput,
  registry: SessionRegistry,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    const toolUseId = input.tool_use_id;
    if (typeof toolUseId !== "string" || toolUseId === "") return;
    if (typeof input.session_id !== "string") return;
    const sessionId = parseSessionId(input.session_id);
    if (sessionId === null) {
      process.stderr.write(
        `guard-state-file: invalid session id ${JSON.stringify(input.session_id)} — call-start not stamped\n`,
      );
      return;
    }
    await registry.recordCallStart(sessionId, toolUseId, nowMs);
  } catch (e) {
    // Fail-open, loudly: an unstamped call degrades to "disk artifacts
    // cannot vouch" downstream — never to a changed guard decision.
    process.stderr.write(
      `guard-state-file: call-start stamp failed (guard decision unaffected): ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

export const runGuardStateFile = async (
  stdin: string,
  registry: SessionRegistry = fsSessionRegistry,
  guard: (command: string) => HookResult = guardStateFile,
): Promise<HookResult> => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a guard route: fail CLOSED. A parse crash
    // would exit 1 — NON-blocking for PreToolUse — silently waving the
    // Bash call past the state-file guard.
    return {
      kind: "block",
      message: `guard-state-file: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const command = (input.tool_input?.command as string) ?? "";
  // Decide FIRST, stamp AFTER: the stamp is side-band bookkeeping and must
  // not sit between the input and the block/allow decision.
  const result = guard(command);
  await stampCallStart(input, registry);
  return result;
};

const handler: HookHandler = async (stdin) => runGuardStateFile(stdin);

export default handler;
