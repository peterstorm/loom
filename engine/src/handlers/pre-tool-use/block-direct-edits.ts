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
 * repository (the canonical root of the repository owning each TaskGraph that
 * armed the session, plus Loom's canonical protected directories) so core can
 * let writes outside all of them through. Pi reuses the same resolvers,
 * supplying its session TaskGraph pointer through `SessionGraphPointerSource`.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import {
  shouldBlockDirectEdit,
  UNRESOLVED,
  unresolvedTargets,
  type ActiveRosterProbe,
  type ArtifactWriteRequest,
  type EditSite,
  type EditTargets,
  type ImplementationBindingProbe,
  type OrchestratedRepository,
} from "../../core/block-direct-edits";
import { nonEmpty } from "../../core/acceptance-contract/kernel";
import { observeTaskGraphProjectBoundary, protectedDirs, subagentDir, taskGraphPath, pathExistsFailClosed } from "../../config";
import { readActiveAgentRoles, type ActiveAgent } from "../../machine/ledger";
import { parseCanonicalTaskGraphPointer } from "../../machine/task-graph-pointer";
import {
  parseReportedAgentId,
  parseSessionId,
  TASK_GRAPH_POINTER_SUFFIX,
  type SessionId,
} from "../../machine/evidence";
import { failClosedInput } from "./pre-tool-use-input";
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

/**
 * What a session's `<session>.task_graph` pointer says: no pointer, the
 * canonical TaskGraph it names, or `unreadable` — present but not provably
 * one canonical path, which leaves the repository unresolved.
 */
export type SessionGraphPointer =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "names"; graphPath: string }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/**
 * Port: the TaskGraph pointer of one session. Pi arms a session through its
 * pointer too, so it supplies `sessionGraphPointerFile`; Claude Code arms only
 * on the cwd-resolved graph and supplies `noSessionGraphPointer`.
 */
export type SessionGraphPointerSource = (sessionId: SessionId) => SessionGraphPointer;

const NO_POINTER: SessionGraphPointer = Object.freeze({ kind: "absent" });

/** The pointer source of a harness that arms on no session pointer. */
export const noSessionGraphPointer: SessionGraphPointerSource = () => NO_POINTER;

/**
 * The pointer file under the subagent dir. Only a proven ENOENT is absent;
 * any other read failure, or bytes that are not one exact canonical absolute
 * path, are `unreadable`.
 */
export const sessionGraphPointerFile: SessionGraphPointerSource = (sessionId) => {
  const pointerPath = `${subagentDir()}/${sessionId}${TASK_GRAPH_POINTER_SUFFIX}`;
  let raw: string;
  try {
    raw = readFileSync(pointerPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return NO_POINTER;
    return Object.freeze({ kind: "unreadable", reason: `cannot read ${pointerPath}: ${e instanceof Error ? e.message : String(e)}` });
  }
  const pointer = parseCanonicalTaskGraphPointer(raw);
  return pointer.ok
    ? Object.freeze({ kind: "names", graphPath: pointer.value })
    : Object.freeze({ kind: "unreadable", reason: `${pointerPath}: ${pointer.error}` });
};

/** What differs between harnesses when observing the graphs that armed a session. */
export type SessionGraphHarness = Readonly<{
  /** Fail-closed existence probe: only ENOENT answers false. */
  graphExists: (path: string) => boolean;
  sessionPointer: SessionGraphPointerSource;
  /** The harness's operator sink for a refusal that has a cause. */
  announce: (line: string) => void;
}>;

/** How a harness observes the TaskGraphs that armed one session. */
export type SessionGraphPorts = SessionGraphHarness & Readonly<{
  /** The cwd-resolved TaskGraph path (`taskGraphPath()`). */
  taskGraph: string;
  protectedDirectories: readonly [string, ...string[]];
}>;

/**
 * The ONE rule both harnesses use for which graphs armed this session: the
 * cwd-resolved TaskGraph when it exists, plus the graph the session's pointer
 * names. Their repository roots and Loom's protected directories then resolve
 * through `orchestratedRepositoryOf`. An unreadable pointer answers
 * `unresolved`, announced through the harness's sink: the guard stays on for
 * every target.
 */
export function sessionOrchestratedRepository(
  sessionId: SessionId | null,
  ports: SessionGraphPorts,
): OrchestratedRepository {
  const pointer = sessionId === null ? NO_POINTER : ports.sessionPointer(sessionId);
  if (pointer.kind === "unreadable") {
    ports.announce(`cannot read the session TaskGraph pointer: ${pointer.reason} — guarding every target`);
    return UNRESOLVED;
  }
  const graphPaths = [
    ...(ports.graphExists(ports.taskGraph) ? [ports.taskGraph] : []),
    ...(pointer.kind === "names" ? [pointer.graphPath] : []),
  ];
  return orchestratedRepositoryOf(graphPaths, ports.protectedDirectories);
}

/**
 * `sessionOrchestratedRepository` over the live configuration — the
 * cwd-resolved `taskGraphPath()` and `protectedDirs()` — so each harness
 * names only what differs (`SessionGraphHarness`).
 */
export const liveSessionRepository = (sessionId: SessionId | null, harness: SessionGraphHarness): OrchestratedRepository =>
  sessionOrchestratedRepository(sessionId, { ...harness, taskGraph: taskGraphPath(), protectedDirectories: protectedDirs() });

/** Claude Code arms only on the cwd-resolved graph, the path `graphActiveProbe` checks. */
const CLAUDE_SESSION_GRAPHS: SessionGraphHarness = Object.freeze({
  graphExists: pathExistsFailClosed,
  sessionPointer: noSessionGraphPointer,
  announce: (line: string) => { process.stderr.write(`block-direct-edits: ${line}\n`); },
});

/** Canonical write targets resolved against `cwd`; one failure leaves all unresolved. */
export function canonicalEditTargets(paths: readonly string[], cwd: string): EditTargets {
  const canonical: string[] = [];
  for (const path of paths) {
    const target = canonicalWritePath(resolve(cwd, path));
    if (target === null) return unresolvedTargets(`cannot canonicalize write target ${path}`);
    canonical.push(target);
  }
  const resolved = nonEmpty(canonical);
  return resolved === null ? unresolvedTargets("the call names no write target") : Object.freeze({ kind: "resolved", paths: resolved });
}

/** The raw `file_path` a Claude Code file tool names, or `null`. */
const claudeFilePath = (input: PreToolUseInput): string | null => {
  const filePath = input.tool_input["file_path"];
  return FILE_PATH_TOOLS.has(input.tool_name) && typeof filePath === "string" && filePath !== "" ? filePath : null;
};

/**
 * Lazy site of one Claude Code write: the target, and the repository owning
 * the graph this hook armed on (`taskGraphPath()`, the same path
 * `graphActiveProbe` probed) with Loom's protected directories.
 */
const claudeEditSite = (input: PreToolUseInput, sessionId: SessionId | null) => (): EditSite => {
  const filePath = claudeFilePath(input);
  return {
    repository: liveSessionRepository(sessionId, CLAUDE_SESSION_GRAPHS),
    targets: filePath === null
      ? unresolvedTargets("the call names no file_path")
      : canonicalEditTargets([filePath], input.cwd ?? process.cwd()),
  };
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
  // Malformed hook input on a guard route fails CLOSED: a crash would exit 1 —
  // NON-blocking for PreToolUse — silently waving the edit past the guard.
  const read = failClosedInput("block-direct-edits", stdin);
  if (!read.ok) return read.block;
  const parsed = read.input;
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
      locateEdit: claudeEditSite(parsed, sessionId),
    },
  );
};

export default handler;
