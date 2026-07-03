/**
 * Core: Block Edit/Write from the MAIN agent during loom orchestration.
 * Harness-agnostic — no stdin parsing. Not pure: reads the filesystem
 * (existsSync/statSync) and writes to stderr.
 */

import { existsSync, statSync } from "node:fs";
import type { HookResult } from "../types";
import { TASK_GRAPH_PATH, SUBAGENT_DIR } from "../config";
import { parseSessionId } from "../machine/evidence";

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "edit", "write"]);

export function shouldBlockDirectEdit(
  toolName: string,
  sessionId: string,
  taskGraphExists: () => boolean = () => existsSync(TASK_GRAPH_PATH),
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

  // Allow if a subagent is active. The interpolation below uses the BRANDED
  // SessionId (path-safe by construction — same guarantee ledger.ts's
  // sessionScopedPath provides; the fs shell is not imported here to keep
  // the core light for the pi bridge).
  const activeFile = `${SUBAGENT_DIR}/${parsed}.active`;
  try {
    if (existsSync(activeFile) && statSync(activeFile).size > 0) {
      return { kind: "allow" };
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
