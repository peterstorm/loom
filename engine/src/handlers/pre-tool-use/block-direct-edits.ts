/**
 * Block Edit/Write/MultiEdit from the MAIN agent during loom orchestration.
 * IMPLEMENTATION subagent Edit/Write is allowed — detected via the configured
 * subagent directory (`LOOM_SUBAGENT_DIR`, default `/tmp/claude-subagents`).
 * Being on the active roster is NOT itself a write grant: `shouldBlockDirectEdit`
 * admits only implementation-role agents and holders of a minted write grant, so
 * review agents and refutation verifiers stay read-only even while active.
 *
 * Claude Code wrapper — delegates the DECISION to core/ and owns the I/O the
 * decision needs, which is why the roster read lives here rather than there.
 */

import { existsSync, statSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import { shouldBlockDirectEdit, type ActiveRosterProbe } from "../../core/block-direct-edits";
import { subagentDir } from "../../config";
import { readActiveAgentRoles } from "../../machine/ledger";

/**
 * Adapter for core's `ActiveRosterProbe`: the session's `.active` roster, or
 * `null` when no active subagent can be proven.
 *
 * `null` covers BOTH an absent flag and an unstatable one — neither proves a
 * subagent is running, and the gate fails closed on that answer. The failure is
 * announced rather than swallowed: silence here would make a permissions or
 * race problem indistinguishable from "no subagent active".
 *
 * `sessionId` is already the BRANDED SessionId — core parses it before calling
 * the port — so the interpolation below is path-safe by construction, the same
 * guarantee `ledger.ts`'s `sessionScopedPath` provides.
 */
export const activeRosterProbe: ActiveRosterProbe = (sessionId) => {
  const activeFile = `${subagentDir()}/${sessionId}.active`;
  try {
    if (!existsSync(activeFile) || statSync(activeFile).size === 0) return null;
    return readActiveAgentRoles(sessionId);
  } catch (e) {
    process.stderr.write(
      `block-direct-edits: cannot check ${activeFile}: ${e instanceof Error ? e.message : String(e)} — falling through to block\n`,
    );
    return null;
  }
};

const handler: HookHandler = async (stdin) => {
  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a guard route: fail CLOSED. A parse crash
    // would exit 1 — NON-blocking for PreToolUse — silently waving the
    // edit past the direct-edit guard.
    return {
      kind: "block",
      message: `block-direct-edits: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return shouldBlockDirectEdit(input.tool_name, input.session_id, undefined, activeRosterProbe);
};

export default handler;
