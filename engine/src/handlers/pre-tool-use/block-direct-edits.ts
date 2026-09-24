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

import { statSync } from "node:fs";
import { resolve as pathResolve, relative as pathRelative, sep as pathSep } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import { shouldBlockDirectEdit, type ActiveRosterProbe } from "../../core/block-direct-edits";
import { gitRepositoryRoot, subagentDir, taskGraphPath, pathExistsFailClosed } from "../../config";
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
  return shouldBlockDirectEdit(
    input.tool_name,
    input.session_id,
    graphActiveProbe,
    activeRosterProbe,
    panelWriteTargetPaths(input.tool_input),
  );
};

/**
 * Repo-relative write targets for the panel-artifact admission. The raw
 * file_path arrives from hook input; this shell resolves it against the
 * harness cwd and makes it repo-relative, so the guard's admission sees one
 * canonical form and a `..` escape or an outside-the-repo target cannot be
 * proven in-scope. An unobservable repository root cannot prove the
 * target's scope either: fail closed to the role admission, which blocks
 * panel writers.
 */
function panelWriteTargetPaths(toolInput: Record<string, unknown>): readonly string[] {
  const filePath = toolInput["file_path"];
  if (typeof filePath !== "string" || filePath === "") return [];
  try {
    const repoRoot = gitRepositoryRoot();
    if (repoRoot === null) return [];
    const absolute = pathResolve(process.cwd(), filePath);
    const relative = pathRelative(repoRoot, absolute).split(pathSep).join("/");
    return Object.freeze([relative]);
  } catch (e) {
    // The proven answers above (no string target, no repository) return
    // silently; an UNEXPECTED probe failure is different, and it is announced
    // here — the activeRosterProbe convention — so a permissions or transport
    // problem is never indistinguishable from "this edit names no write
    // target". The list still fails closed to the role admission.
    process.stderr.write(
      `block-direct-edits: cannot resolve ${filePath} against the repository root: ` +
        `${e instanceof Error ? e.message : String(e)} — failing closed to the role admission\n`,
    );
    return [];
  }
}

export default handler;
