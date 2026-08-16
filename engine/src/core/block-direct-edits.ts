/**
 * Core: Block Edit/Write from the MAIN agent during loom orchestration.
 * Harness-agnostic — no stdin parsing. Not pure: reads the filesystem
 * (existsSync/statSync) and writes to stderr.
 */

import { existsSync, statSync } from "node:fs";
import type { HookResult } from "../types";
import { IMPL_AGENTS, TASK_GRAPH_PATH, subagentDir, pathExistsFailClosed } from "../config";
import { parseGrantedAgentId, parseSessionId } from "../machine/evidence";
import { readActiveAgentRoles } from "../machine/ledger";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "edit", "write", "multi_edit"]);

/**
 * Write-grant agent IDs are minted by the Pi write-grant system, which verifies
 * the grant's token digest, binding MAC, expiry, agent identity, Task ID, and
 * cwd before minting — then BURNS the record, so nothing downstream can re-run
 * that verification. The identity is therefore recognised by namespace, and the
 * namespace is what has to be exclusive: `parseGrantedAgentId` is the only
 * constructor that admits it, and `parseReportedAgentId` — the only constructor
 * applied to harness-reported ids on their way onto the `.active` roster this
 * function reads — refuses it. A self-reported id shaped like a grant identity
 * therefore never reaches here. The prefix test that used to stand in for this
 * had no such boundary: it accepted whatever the roster's identity column held.
 */
function isWriteAuthorizedAgent(agentId: string): boolean {
  return IMPL_AGENTS.has(agentId) || parseGrantedAgentId(agentId) !== null;
}

/**
 * Default task-graph existence probe, FAIL-CLOSED. The historical default was
 * bare `existsSync(TASK_GRAPH_PATH)`, which returns `false` for ANY error —
 * EACCES, ELOOP, ENOTDIR, EIO all read as "no graph" and the gate silently
 * returned allow while the operator believed it was blocked. ENOENT is the
 * only absent answer; anything unreadable stays armed (`pathExistsFailClosed`
 * reports the cause and assumes present). Pi passes its own override built on
 * the same semantics; this default covers every other caller.
 */
const defaultTaskGraphExists = (): boolean => pathExistsFailClosed(TASK_GRAPH_PATH);

export function shouldBlockDirectEdit(
  toolName: string,
  sessionId: string,
  taskGraphExists: () => boolean = defaultTaskGraphExists,
): HookResult {
  if (!taskGraphExists()) return { kind: "allow" };
  if (!FILE_TOOLS.has(toolName)) return { kind: "allow" };

  // Session ids come from hook input and name files under SUBAGENT_DIR —
  // parse before constructing any path. An unparseable id means the
  // subagent-active check cannot be made safely: fail closed (block),
  // since allowing would open direct edits on malformed input.
  const parsed = parseSessionId(sessionId);
  if (parsed === null) {
    return {
      kind: "block",
      message: `BLOCKED: invalid session id ${JSON.stringify(sessionId)} — cannot verify an active subagent; direct edits stay blocked during loom orchestration.`,
    };
  }

  // Allow if an IMPLEMENTATION subagent is active. Review agents and verifiers
  // are read-only and must never receive write capability, even when active.
  // The interpolation below uses the BRANDED SessionId (path-safe by
  // construction — same guarantee ledger.ts's sessionScopedPath provides).
  const activeFile = `${subagentDir()}/${parsed}.active`;
  try {
    if (existsSync(activeFile) && statSync(activeFile).size > 0) {
      // Authorize by ROLE first. On Claude Code `agent_id` is an opaque
      // handle (`a339f6fd51d78b179`), so testing it against IMPL_AGENTS —
      // which holds agent-type NAMES — could never match, and every
      // implementation subagent was blocked by the guard that exists to let
      // it through. The roster's type column is the role it is serving.
      const roster = readActiveAgentRoles(parsed);
      const hasImplAgent = roster.some(({ agentId, agentType }) =>
        // agentType covers Claude Code; the id fallback covers Pi's
        // `pi-grant-` capability tokens and any roster written before the
        // type column existed.
        (agentType !== null && IMPL_AGENTS.has(agentType)) || isWriteAuthorizedAgent(agentId));
      if (hasImplAgent) {
        return { kind: "allow" };
      }
      // Only review/verifier agents active — fall through to block.
    }
  } catch (e) {
    // An unstatable .active flag cannot prove a subagent is running — fall
    // through to block (fail closed), but say why: silence here makes a
    // permissions/race problem indistinguishable from "no subagent active".
    process.stderr.write(
      `block-direct-edits: cannot check ${activeFile}: ${e instanceof Error ? e.message : String(e)} — falling through to block\n`,
    );
  }

  return {
    kind: "block",
    message: [
      "BLOCKED: Direct edits not allowed during loom orchestration.",
      "",
      "Use the subagent tool with appropriate agent for implementation:",
      "  - code-implementer-agent for production code",
      "  - ts-test-agent for tests",
      "  - frontend-agent for UI components",
      "",
      "This ensures proper phase sequencing and review gates.",
    ].join("\n"),
  };
}
