/**
 * Block Edit/Write/MultiEdit from the MAIN agent during loom orchestration.
 * IMPLEMENTATION subagent Edit/Write is allowed — detected via the configured
 * subagent directory (`LOOM_SUBAGENT_DIR`, default `/tmp/claude-subagents`).
 * Being on the active roster is NOT itself a write grant: `shouldBlockDirectEdit`
 * admits only implementation-role agents, holders of a minted write grant, and
 * — for the calling subagent only — phase agents and panel writers writing
 * inside their role's artifact roots (`.claude/specs` / `.claude/plans`). Review
 * agents, judges, verifiers and decompose stay read-only even while active.
 *
 * Claude Code wrapper — delegates the DECISION to core/ and owns the I/O the
 * decision needs: the roster read, and canonicalizing the target path and
 * project root (realpath) so the core compares symlink-free absolute paths.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import {
  shouldBlockDirectEdit,
  type ActiveRosterProbe,
  type ArtifactWriteRequest,
} from "../../core/block-direct-edits";
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
    if (statSync(activeFile).size === 0) return null;
    return readActiveAgentRoles(sessionId);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    process.stderr.write(
      `block-direct-edits: cannot check ${activeFile}: ${e instanceof Error ? e.message : String(e)} — falling through to block\n`,
    );
    return null;
  }
};

/**
 * Symlink-safe canonical form of an absolute path that may not exist yet: the
 * realpath of its nearest existing ancestor with the missing remainder
 * re-appended. `null` when it cannot be proven — a dangling symlink (a write
 * would follow it wherever it points), or any error other than ENOENT.
 */
export function canonicalWritePath(absolute: string): string | null {
  try {
    return realpathSync(absolute);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
    if (isDanglingSymlink(absolute)) return null;
    const parent = dirname(absolute);
    if (parent === absolute) return null;
    const canonicalParent = canonicalWritePath(parent);
    return canonicalParent === null ? null : join(canonicalParent, basename(absolute));
  }
}

const isDanglingSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const FILE_PATH_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * The artifact-writer request for core, or `undefined` when the project root
 * itself cannot be canonicalized (the request then never admits anything).
 */
export function artifactWriteRequest(
  input: PreToolUseInput,
  projectDir: string | undefined = process.env["CLAUDE_PROJECT_DIR"],
): ArtifactWriteRequest | undefined {
  const cwd = input.cwd ?? process.cwd();
  const projectRoot = canonicalWritePath(resolve(projectDir ?? cwd));
  if (projectRoot === null) return undefined;
  const filePath = input.tool_input["file_path"];
  const targetPath = FILE_PATH_TOOLS.has(input.tool_name) && typeof filePath === "string" && filePath !== ""
    ? canonicalWritePath(resolve(cwd, filePath))
    : null;
  return { callerAgentId: input.agent_id ?? null, targetPath, projectRoot };
}

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
  return shouldBlockDirectEdit(input.tool_name, input.session_id, undefined, activeRosterProbe, artifactWriteRequest(input));
};

export default handler;
