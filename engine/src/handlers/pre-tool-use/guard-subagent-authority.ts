/**
 * PreToolUse `Bash` guard: subagents may not change audit or orchestration
 * authority (ADR-0067 D6).
 *
 * Claude Code wrapper around `core/subagent-authority`. The signal is the
 * harness's own: Claude Code sets `agent_id` on PreToolUse ONLY for a call
 * that originates inside a subagent (`types.ts`), so a call without it is the
 * parent session's and passes through untouched — the parent runs every
 * authority write. For a subagent call this shell observes what the pure
 * decision needs — the registered audit runs (`security-audit-run-registry`),
 * the canonical cwd, the home directory and Loom's protected directories — and
 * maps a refusal to a block naming the rule.
 *
 * Fail closed: malformed hook input, a non-string command, or an unreadable
 * run registry never wave a subagent call through. (An unreadable registry
 * still decides — with every authority-shaped path refused.)
 */

import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { HookHandler, HookResult } from "../../types";
import { blockResult, passthroughResult } from "../../types";
import { protectedDirs } from "../../config";
import {
  decideSubagentAuthority,
  renderSubagentAuthorityRefusal,
  type RegisteredRuns,
  type ScriptRead,
  type SubagentFilesystemView,
  type SubagentAuthorityContext,
} from "../../core/subagent-authority";
import { registeredSecurityAuditRuns } from "../../orchestration/security-audit-run-registry";
import { AUTHORITY_HELPER_OPERATIONS, HARNESS_HOOK_ROUTES } from "./subagent-authority-operations";
import { readRunBytesNoFollow } from "../../utils/no-follow-fs";
import { describeCause } from "../../utils/describe-cause";
import { failClosedGuard } from "./pre-tool-use-input";


/** A path and its realpath, when the two differ and the path exists. */
const spellings = (path: string): readonly string[] => {
  try {
    const real = realpathSync.native(path);
    return real === path ? [path] : [path, real];
  } catch {
    return [path];
  }
};

/** The registry's answer as the core reads it: a throw is `unreadable`. Every
 *  registered spelling is expanded with its realpath, so a run registered
 *  under `/tmp/…` is also known as `/private/tmp/…` (and the reverse). */
function observeRegisteredRuns(read: () => readonly string[] = registeredSecurityAuditRuns): RegisteredRuns {
  try {
    return { kind: "known", directories: [...new Set(read().flatMap(spellings))] };
  } catch (error) {
    return { kind: "unreadable", reason: describeCause(error) };
  }
}

/**
 * The canonical spelling of an absolute path: the realpath of its deepest
 * EXISTING ancestor, with the rest appended. A path that does not exist yet
 * (`<link>/ledger.json` before the write) is still judged as the directory its
 * existing prefix reaches.
 */
export function canonicalizeDeepestAncestor(absolutePath: string): string {
  const missing: string[] = [];
  let current = absolutePath;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length === 0 ? real : join(real, ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolutePath;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Scripts larger than this are not read: the guard treats them as unreadable. */
const MAXIMUM_SCRIPT_BYTES = 256 * 1024;

/** Read a script a command would execute: canonical path, a regular file only
 *  (never a FIFO or device that could block the guard), bounded, no-follow. */
export function readScriptForGuard(absolutePath: string): ScriptRead {
  const canonical = canonicalizeDeepestAncestor(absolutePath);
  try {
    const stat = lstatSync(canonical);
    if (!stat.isFile()) return { kind: "unreadable", reason: "not a regular file" };
    if (stat.size > MAXIMUM_SCRIPT_BYTES) return { kind: "unreadable", reason: `larger than ${MAXIMUM_SCRIPT_BYTES} bytes` };
    return { kind: "text", text: readRunBytesNoFollow(canonical, MAXIMUM_SCRIPT_BYTES).toString("utf8") };
  } catch (error) {
    return { kind: "unreadable", reason: describeCause(error) };
  }
}

/** The filesystem as the guard observes it at decision time. */
export const GUARD_FILESYSTEM: SubagentFilesystemView = Object.freeze({
  canonicalize: canonicalizeDeepestAncestor,
  readScript: readScriptForGuard,
});

/** The canonical cwd the harness reported, or null when it gave none usable. */
const canonicalCwd = (cwd: unknown): string | null => {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  const forms = spellings(cwd);
  return forms[forms.length - 1];
};

/**
 * Everything the pure decision needs about the calling agent's world, observed
 * now. Shared by both harness adapters so they judge one command identically.
 */
export function observeSubagentAuthorityContext(
  cwd: unknown,
  readRuns: () => readonly string[] = registeredSecurityAuditRuns,
): SubagentAuthorityContext {
  return {
    cwd: canonicalCwd(cwd),
    home: homedir(),
    runs: observeRegisteredRuns(readRuns),
    protectedDirectories: protectedDirs().flatMap(spellings),
    helperOperations: AUTHORITY_HELPER_OPERATIONS,
    hookRoutes: HARNESS_HOOK_ROUTES,
    filesystem: GUARD_FILESYSTEM,
  };
}

/** The block for one subagent Bash command, or null when it may run. */
export function subagentAuthorityBlock(command: string, context: SubagentAuthorityContext): string | null {
  const decision = decideSubagentAuthority(command, context);
  return decision.kind === "allow" ? null : renderSubagentAuthorityRefusal(decision.refusal, context);
}

export function runGuardSubagentAuthority(
  stdin: string,
  readRuns: () => readonly string[] = registeredSecurityAuditRuns,
): Promise<HookResult> {
  return failClosedGuard("guard-subagent-authority", (input) => {
    // Only Claude Code's own marker identifies a subagent; any value it carries
    // (even a malformed one) means the call did not come from the parent.
    if (input.agent_id === undefined) return passthroughResult();
    if (input.tool_name !== "Bash") return passthroughResult();
    const command = input.tool_input.command;
    if (typeof command !== "string") {
      return blockResult(`guard-subagent-authority: non-string Bash command (${typeof command}) — failing closed`);
    }
    const block = subagentAuthorityBlock(command, observeSubagentAuthorityContext(input.cwd, readRuns));
    return block === null ? passthroughResult() : blockResult(block);
  })(stdin);
}

const handler: HookHandler = async (stdin) => runGuardSubagentAuthority(stdin);

export default handler;
