/**
 * Block Edit/Write/MultiEdit from the MAIN agent during loom orchestration.
 * IMPLEMENTATION subagent Edit/Write is allowed — detected via the configured
 * subagent directory (`LOOM_SUBAGENT_DIR`, default `/tmp/claude-subagents`).
 * Being on the active roster is NOT itself a write grant: `shouldBlockDirectEdit`
 * admits only implementation-role agents, holders of a minted write grant, and
 * — for the calling subagent only — phase agents and panel writers writing
 * inside their role's artifact roots (`artifactWriteRoots`: spec and plan dirs,
 * plus the lint-rule dirs for architecture). Review
 * agents, judges, verifiers and decompose stay read-only even while active.
 *
 * Claude Code wrapper — delegates the DECISION to core/ and owns the I/O the
 * decision needs: the roster read, the calling implementation Agent's exact
 * attempt binding (an implementation role writes only once BOUND), and
 * canonicalizing the target path and project root (realpath) so the core
 * compares symlink-free absolute paths.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import {
  shouldBlockDirectEdit,
  type ActiveRosterProbe,
  type ArtifactWriteRequest,
  type ImplementationBindingProbe,
} from "../../core/block-direct-edits";
import { subagentDir, taskGraphPath, pathExistsFailClosed } from "../../config";
import { readActiveAgentRoles, type ActiveAgent } from "../../machine/ledger";
import { parseReportedAgentId, parseSessionId, type SessionId } from "../../machine/evidence";
import { parsePreToolUseInput } from "./pre-tool-use-input";
import {
  ensureRosteredImplementationBinding,
  observeImplementationBinding,
} from "../implementation-binding";

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
 * Graph activity, observed LAZILY at decision time through the shared
 * `taskGraphPath()` resolver rather than the import-frozen `TASK_GRAPH_PATH`
 * default. For a real hook process the two are identical (the environment is
 * fixed before this module loads), but the lazy resolver is what the Pi
 * adapter already probes, and it is what lets a test arm the guard by
 * re-pointing `LOOM_STATE_PATH` at decision time without reloading the module
 * graph — the re-pointing doctrine every other config path here follows. The
 * probe itself stays fail-closed (`pathExistsFailClosed`): only a proven
 * ENOENT disarms the gate.
 */
const graphActiveProbe = (): boolean => pathExistsFailClosed(taskGraphPath());

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
 * That failure is announced: a writer blocked for an unresolvable root would
 * otherwise see only the generic direct-edit message.
 */
export function artifactWriteRequest(
  input: PreToolUseInput,
  projectDir: string | undefined = process.env["CLAUDE_PROJECT_DIR"],
): ArtifactWriteRequest | undefined {
  const cwd = input.cwd ?? process.cwd();
  const rawRoot = resolve(projectDir ?? cwd);
  const projectRoot = canonicalWritePath(rawRoot);
  if (projectRoot === null) {
    process.stderr.write(
      `block-direct-edits: cannot canonicalize project root ${rawRoot} — no artifact-writer admission for this call\n`,
    );
    return undefined;
  }
  const filePath = input.tool_input["file_path"];
  const targetPath = FILE_PATH_TOOLS.has(input.tool_name) && typeof filePath === "string" && filePath !== ""
    ? canonicalWritePath(resolve(cwd, filePath))
    : null;
  return { callerAgentId: input.agent_id ?? null, targetPath, projectRoot };
}

/** Malformed hook input on a guard route fails CLOSED: a crash would exit 1 —
 *  NON-blocking for PreToolUse — silently waving the edit past the guard. */
const malformed = (detail: string) =>
  ({ kind: "block", message: `block-direct-edits: malformed hook input — failing closed: ${detail}` }) as const;

/**
 * Adapter for core's `ImplementationBindingProbe`. The CALLER's binding is
 * attempted HERE, before the decision, inside the same handler that decides —
 * Claude runs separate PreToolUse hooks in parallel, so no other hook's work
 * can be relied on to have landed first. Every other rostered implementation
 * Agent answers its observed (never published) state.
 */
function callerBindingProbe(
  input: PreToolUseInput,
  sessionId: SessionId,
  roster: readonly ActiveAgent[] | null,
): ImplementationBindingProbe {
  const callerId = parseReportedAgentId(input.agent_id ?? "");
  const callerBinding = callerId === null
    ? null
    : ensureRosteredImplementationBinding({ sessionId, agentId: callerId, roster });
  return (agentId) => agentId === callerId && callerBinding !== null
    ? callerBinding
    : observeImplementationBinding(sessionId, agentId);
}

const handler: HookHandler = async (stdin) => {
  const parsed = parsePreToolUseInput(stdin);
  if (parsed instanceof Error) return malformed(parsed.message);
  // One roster read feeds both the binding attempt and the decision. An
  // unparseable session id reaches core unchanged, which blocks on it.
  const sessionId = parseSessionId(parsed.session_id);
  const roster = sessionId === null ? null : activeRosterProbe(sessionId);
  return shouldBlockDirectEdit(
    parsed.tool_name,
    parsed.session_id,
    graphActiveProbe,
    () => roster,
    artifactWriteRequest(parsed),
    sessionId === null ? undefined : callerBindingProbe(parsed, sessionId, roster),
  );
};

export default handler;
