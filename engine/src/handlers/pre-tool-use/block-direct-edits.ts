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
 * compares symlink-free absolute paths, and resolving the orchestrated
 * repository (the canonical root of the repository owning the live TaskGraph,
 * plus Loom's canonical protected directories) so core can let writes outside
 * all of them through. Pi reuses the same resolvers.
 */

import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import {
  editPlacement,
  shouldBlockDirectEdit,
  UNRESOLVED,
  type ActiveRosterProbe,
  type ArtifactWriteRequest,
  type EditPlacement,
  type EditTargets,
  type ImplementationBindingProbe,
  type OrchestratedRepository,
} from "../../core/block-direct-edits";
import { nonEmpty } from "../../core/acceptance-contract/kernel";
import { observeTaskGraphProjectBoundary, protectedDirs, subagentDir, taskGraphPath, pathExistsFailClosed } from "../../config";
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
 * The orchestrated repository for core's `editPlacement`: the canonical root of
 * the repository owning each armed TaskGraph, by the engine's ONE boundary rule
 * (`observeTaskGraphProjectBoundary` — the Git working tree holding the State
 * File, else its documented `.claude/state` / `.pi/state` layout), so a
 * `LOOM_STATE_PATH` override is judged exactly like a discovered graph.
 *
 * It carries the canonical `protectedDirectories` too (the caller passes
 * config's `protectedDirs()`): each is canonicalised like a write target, through its
 * nearest existing ancestor, so a symlinked or not-yet-created subagent dir is
 * still compared by its real location.
 *
 * No armed graph answers `unresolved` silently — nothing failed. Every failure
 * that has a cause — a Git probe that cannot answer, a non-canonical layout, an
 * uncanonicalisable repository root or protected directory — answers
 * `unresolved` and is announced. Either way the guard stays on for every
 * target.
 */
export function orchestratedRepositoryOf(
  graphPaths: readonly string[],
  protectedDirectories: readonly [string, ...string[]],
): OrchestratedRepository {
  const roots: string[] = [];
  for (const graphPath of graphPaths) {
    let boundaryRoot: string;
    try {
      boundaryRoot = observeTaskGraphProjectBoundary(graphPath).root;
    } catch (e) {
      process.stderr.write(
        `block-direct-edits: cannot resolve the repository owning ${graphPath}: ${e instanceof Error ? e.message : String(e)} — guarding every target\n`,
      );
      return UNRESOLVED;
    }
    const root = canonicalWritePath(boundaryRoot);
    if (root === null) {
      process.stderr.write(`block-direct-edits: cannot canonicalize repository root ${boundaryRoot} — guarding every target\n`);
      return UNRESOLVED;
    }
    if (!roots.includes(root)) roots.push(root);
  }
  const resolved = nonEmpty(roots);
  if (resolved === null) return UNRESOLVED;
  const protectedRoots = canonicalProtectedRoots(protectedDirectories);
  return protectedRoots === null ? UNRESOLVED : Object.freeze({ kind: "resolved", roots: resolved, protectedRoots });
}

/** The canonical protected directories, or `null` (announced) when any cannot be canonicalised. */
function canonicalProtectedRoots(dirs: readonly [string, ...string[]]): readonly [string, ...string[]] | null {
  const canonical: string[] = [];
  for (const dir of dirs) {
    const root = canonicalWritePath(resolve(dir));
    if (root === null) {
      process.stderr.write(`block-direct-edits: cannot canonicalize protected directory ${dir} — guarding every target\n`);
      return null;
    }
    if (!canonical.includes(root)) canonical.push(root);
  }
  return nonEmpty(canonical);
}

/** Canonical write targets resolved against `cwd`; one failure leaves all unresolved. */
export function canonicalEditTargets(paths: readonly string[], cwd: string): EditTargets {
  const canonical: string[] = [];
  for (const path of paths) {
    const target = canonicalWritePath(resolve(cwd, path));
    if (target === null) return UNRESOLVED;
    canonical.push(target);
  }
  const resolved = nonEmpty(canonical);
  return resolved === null ? UNRESOLVED : Object.freeze({ kind: "resolved", paths: resolved });
}

/** The raw `file_path` a Claude Code file tool names, or `null`. */
const claudeFilePath = (input: PreToolUseInput): string | null => {
  const filePath = input.tool_input["file_path"];
  return FILE_PATH_TOOLS.has(input.tool_name) && typeof filePath === "string" && filePath !== "" ? filePath : null;
};

/**
 * Lazy placement of one Claude Code write: the target against the repository
 * owning the graph this hook armed on (`taskGraphPath()`, the same path
 * `graphActiveProbe` probed) and Loom's protected directories.
 */
const claudeEditPlacement = (input: PreToolUseInput) => (): EditPlacement => {
  const filePath = claudeFilePath(input);
  return editPlacement(
    orchestratedRepositoryOf([taskGraphPath()], protectedDirs()),
    filePath === null ? UNRESOLVED : canonicalEditTargets([filePath], input.cwd ?? process.cwd()),
  );
};

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
  const filePath = claudeFilePath(input);
  const targetPath = filePath === null ? null : canonicalWritePath(resolve(cwd, filePath));
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
    {
      artifactWrite: artifactWriteRequest(parsed),
      implementationBinding: sessionId === null ? undefined : callerBindingProbe(parsed, sessionId, roster),
      placeEdit: claudeEditPlacement(parsed),
    },
  );
};

export default handler;
