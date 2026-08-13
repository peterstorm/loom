/**
 * Core: Block Edit/Write from the MAIN agent during loom orchestration.
 * Harness-agnostic — no stdin parsing. Not pure: reads the filesystem
 * (existsSync/statSync) and writes to stderr.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import type { HookResult } from "../types";
import { IMPL_AGENTS, TASK_GRAPH_PATH, subagentDir, pathExistsFailClosed } from "../config";
import { parseSessionId } from "../machine/evidence";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "edit", "write", "multi_edit"]);

/** Write-grant agent IDs are minted by the Pi write-grant system and carry
 *  cryptographic proof of authorization. They bypass the IMPL_AGENTS check
 *  because the grant itself is the capability — not the agent's declared role. */
const PI_WRITE_GRANT_PREFIX = "pi-grant-";

function isWriteAuthorizedAgent(agentId: string): boolean {
  return IMPL_AGENTS.has(agentId) || agentId.startsWith(PI_WRITE_GRANT_PREFIX);
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
      const roster = readFileSync(activeFile, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const hasImplAgent = roster.some((agentId) => isWriteAuthorizedAgent(agentId));
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
