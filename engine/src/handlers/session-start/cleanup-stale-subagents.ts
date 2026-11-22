/**
 * Clean up stale subagent tracking files from previous sessions.
 *
 * Staleness is judged per SESSION GROUP, not per file: only the `.machine`
 * binding file has its mtime refreshed by refreshBindingActivity, so a
 * long-lived session's `.active` roster or `.evidence.jsonl` ledger would
 * look stale on its own mtime while the session is demonstrably live. A
 * session's files are deleted only when the MAX mtime across ALL of its
 * files (every SESSION_SUFFIXES entry — the single source of truth in
 * machine/evidence.ts — plus the per-agent sidecars, all classified to one
 * SessionGroupKey by sessionGroupOfTrackingFile) exceeds
 * STALE_SUBAGENT_TTL_MS (shared with the machine-binding liveness TTL). Files
 * that match no known session suffix fall back to their own mtime.
 *
 * Idle time is not death. A session can sit idle past the TTL and still be
 * alive (an overnight pause, or an orchestrator waiting on its operator), and
 * its ledger is the I6 evidence of any attempt it has in flight. So two kinds
 * of session are never swept, whatever their age:
 *   - the session that is starting (SessionStart fires on resume too, and the
 *     resumed session is alive by definition);
 *   - a session bound to a TaskGraph file that still exists, through its
 *     `<session>.task_graph` pointer. Once the graph is cleaned up, the
 *     session's files age out normally.
 * A third kind is kept for a bounded time: a session whose Session Run
 * Binding registry (`<session>.orchestration-runs.json`) names a run that is
 * still open (`core/run-liveness.ts`). Its subagents' hooks resolve their
 * issuing run through that registry, and the run's `done` records its result
 * into it, so sweeping it mid-run refuses every later capture and completion
 * ("cannot bind completed result for unregistered run"). The protection lasts
 * `OPEN_RUN_GRACE_MS` past the idle TTL, because a run that never proves its
 * end in a file (a panel, a blocked run nobody resumes) must not keep its
 * session forever.
 * When any of these facts cannot be read (SessionStart input without a usable
 * `session_id`, a malformed pointer or registry, an unreadable Run Directory)
 * the sweep says so in its diagnostics: a silent miss would bring back the
 * deleted-ledger failure with no trace.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import { passthroughResult, type HookHandler } from "../../types";
import { OPEN_RUN_GRACE_MS, PERSISTENT_SUBAGENT_DIR_ENTRIES, STALE_SUBAGENT_TTL_MS, SUBAGENT_DIR } from "../../config";
import { observeBoundRun, type BoundRunObservation } from "../../orchestration/bound-run-liveness";
import {
  ORCHESTRATION_RUNS_SUFFIX,
  parsePublishedSessionRunBindingRegistry,
  type SessionRunBinding,
} from "../../orchestration/session-run-bindings";
import {
  parseCanonicalTaskGraphPointer,
  parseSessionId,
  sessionGroupKey,
  sessionGroupOfTrackingFile,
  TASK_GRAPH_POINTER_SUFFIX,
  type SessionGroupKey,
  type SessionId,
} from "../../machine";

/**
 * Pure: which entries are stale, judged per session group. `mtimes` maps
 * each entry to its mtime (ms); entries in the same session group share the
 * group's max mtime, ungrouped entries stand alone. A session in
 * `protectedSessions` (alive, or not observable) is never stale, and neither
 * is a PERSISTENT_SUBAGENT_DIR_ENTRIES entry: every store declared in
 * `config.PERSISTENT_SUBAGENT_STORES` (the run registry, the capture
 * attestation store) outlives every session.
 */
export function staleEntries(
  mtimes: ReadonlyMap<string, number>,
  cutoffMs: number,
  protectedSessions: ReadonlySet<SessionGroupKey> = new Set(),
): string[] {
  const groupMax = new Map<SessionGroupKey, number>();
  for (const [entry, mtime] of mtimes) {
    const session = sessionGroupOfTrackingFile(entry);
    if (session === null) continue;
    groupMax.set(session, Math.max(groupMax.get(session) ?? -Infinity, mtime));
  }
  return [...mtimes.entries()]
    .filter(([entry, mtime]) => {
      if (PERSISTENT_SUBAGENT_DIR_ENTRIES.has(entry)) return false;
      const session = sessionGroupOfTrackingFile(entry);
      if (session !== null && protectedSessions.has(session)) return false;
      const anchor = session === null ? mtime : (groupMax.get(session) ?? mtime);
      return anchor < cutoffMs;
    })
    .map(([entry]) => entry);
}

declare const SWEEP_CUTOFFS: unique symbol;

/**
 * The two cutoffs one sweep judges idle time by: a session idle past `idleMs`
 * is swept unless it is protected, and one whose run binding names an open run
 * is kept until it is idle past `openRunMs`. Only `sweepCutoffs` mints one, so
 * `openRunMs <= idleMs` always holds and the two cannot be passed swapped.
 */
export type SweepCutoffs = Readonly<{ idleMs: number; openRunMs: number }> & { readonly [SWEEP_CUTOFFS]: true };

/**
 * The cutoffs for a sweep whose idle cutoff is `idleCutoffMs`, keeping an open
 * run's session `openRunGraceMs` longer. Constructor invariant: the grace is a
 * finite, non-negative duration, so the open-run cutoff never passes the idle
 * cutoff.
 */
export function sweepCutoffs(idleCutoffMs: number, openRunGraceMs: number = OPEN_RUN_GRACE_MS): SweepCutoffs {
  if (!Number.isFinite(openRunGraceMs) || openRunGraceMs < 0) {
    throw new RangeError(`open-run grace must be a finite, non-negative duration, got ${openRunGraceMs}`);
  }
  return Object.freeze({ idleMs: idleCutoffMs, openRunMs: idleCutoffMs - openRunGraceMs }) as SweepCutoffs;
}

/**
 * Pure: the entries the idle cutoff would sweep but the open-run grace still
 * covers. Only their sessions' run bindings are worth reading: every other
 * entry is kept or swept whatever its runs say.
 */
export function entriesWithinOpenRunGrace(
  mtimes: ReadonlyMap<string, number>,
  cutoffs: SweepCutoffs,
  protectedSessions: ReadonlySet<SessionGroupKey> = new Set(),
): string[] {
  const pastGrace = new Set(staleEntries(mtimes, cutoffs.openRunMs, protectedSessions));
  return staleEntries(mtimes, cutoffs.idleMs, protectedSessions).filter((entry) => !pastGrace.has(entry));
}

/**
 * The session SessionStart names. `absent` is empty input (nothing to protect,
 * nothing to report); `unusable` is input that should have named a session and
 * did not, which the sweep reports because the starting session then goes
 * unprotected.
 */
export type StartingSession =
  | Readonly<{ kind: "named"; sessionId: SessionId }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unusable"; cause: string }>;

const NO_STARTING_SESSION: StartingSession = Object.freeze({ kind: "absent" });

const unusable = (cause: string): StartingSession => Object.freeze({ kind: "unusable", cause });

/** Pure: parse the starting session from SessionStart hook input. */
export function startingSessionOf(stdin: string): StartingSession {
  if (stdin.trim() === "") return NO_STARTING_SESSION;
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch (error) {
    return unusable(`input is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof input !== "object" || input === null) return unusable("input is not a JSON object");
  const raw = (input as Readonly<Record<string, unknown>>)["session_id"];
  if (typeof raw !== "string") return unusable("input carries no string session_id");
  const sessionId = parseSessionId(raw);
  return sessionId === null
    ? unusable(`session_id ${JSON.stringify(raw)} cannot name session files`)
    : Object.freeze({ kind: "named", sessionId });
}

/** Shell: sweep one tracking dir. Dir is a parameter so tests can run the
 *  sweep hermetically against a temp dir (SUBAGENT_DIR freezes at first
 *  config import, which a shared-process test run cannot re-point). */
export type StaleCleanupDiagnostic = Readonly<{
  operation: "read-directory" | "stat" | "read" | "parse" | "remove";
  path: string;
  cause: string;
}>;

export type DirectoryProbe =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present"; entries: readonly string[] }>
  | Readonly<{ kind: "unavailable"; cause: string }>;

export type StaleSessionOperations = Readonly<{
  probeDirectory: (path: string) => DirectoryProbe;
  mtime: (path: string) => number;
  /** A file's text, or null when it does not exist; any other failure throws. */
  readText: (path: string) => string | null;
  exists: (path: string) => boolean;
  /** Observes the run a Session Run Binding names: absent, observed (open or finished), or unreadable; never throws. */
  observeBoundRun: (binding: SessionRunBinding) => BoundRunObservation;
  remove: (path: string) => void;
}>;

function probeDirectory(path: string): DirectoryProbe {
  try {
    return Object.freeze({ kind: "present", entries: Object.freeze(readdirSync(path)) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ kind: "absent" });
    }
    return Object.freeze({
      kind: "unavailable",
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function readOptionalText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const REAL_STALE_SESSION_OPERATIONS: StaleSessionOperations = Object.freeze({
  probeDirectory,
  mtime: (path) => statSync(path).mtimeMs,
  readText: readOptionalText,
  exists: existsSync,
  observeBoundRun,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
});

function diagnostic(
  operation: StaleCleanupDiagnostic["operation"],
  path: string,
  error: unknown,
): StaleCleanupDiagnostic {
  return Object.freeze({
    operation,
    path,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function renderDiagnostic(failure: StaleCleanupDiagnostic): string {
  return `cleanup-stale-subagents: ${failure.operation} failed for ${failure.path}: ${failure.cause}`;
}

/** Stat failures that prove the entry can never resolve to a tracking file:
 *  a symlink loop (ELOOP) or a dangling link (ENOENT/ENOTDIR). The machine
 *  code only ever creates regular files here, so such an entry is garbage
 *  regardless of age — the sweep removes it instead of re-reporting the same
 *  diagnostic at every session start. Every other failure (EACCES/EPERM/
 *  EIO/...) may be transient and keeps the conservative protect + loud
 *  report behavior. */
const DEAD_ENTRY_STAT_CODES: ReadonlySet<string> = new Set(["ELOOP", "ENOENT", "ENOTDIR"]);

/** Pure: does this stat failure prove the entry is dead, not merely unreadable? */
export function isDeadStatFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && DEAD_ENTRY_STAT_CODES.has(code);
}

/** The session a tracking entry belongs to when it ends with `suffix`, else null. */
function sessionNamedBy(entry: string, suffix: string): string | null {
  const session = entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : "";
  return session === "" ? null : session;
}

/** One tracking entry's text; `absent` when it is gone; `unreadable` once its read failure is reported. */
type TrackingEntryRead =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable" }>;

const ABSENT_ENTRY: TrackingEntryRead = Object.freeze({ kind: "absent" });
const UNREADABLE_ENTRY: TrackingEntryRead = Object.freeze({ kind: "unreadable" });

function readTrackingEntry(
  path: string,
  operations: StaleSessionOperations,
  diagnostics: StaleCleanupDiagnostic[],
): TrackingEntryRead {
  let text: string | null;
  try {
    text = operations.readText(path);
  } catch (error) {
    diagnostics.push(diagnostic("read", path, error));
    return UNREADABLE_ENTRY;
  }
  return text === null ? ABSENT_ENTRY : Object.freeze({ kind: "text", text });
}

/**
 * Shell: the session groups bound to a TaskGraph that still exists. A
 * malformed pointer binds nothing (it ages out like any stale file) and is
 * reported; an unreadable one may be live, so it protects its session and is
 * reported.
 */
function graphBoundSessions(
  dir: string,
  entries: readonly string[],
  operations: StaleSessionOperations,
  diagnostics: StaleCleanupDiagnostic[],
): readonly SessionGroupKey[] {
  return entries.flatMap((entry) => {
    const session = sessionNamedBy(entry, TASK_GRAPH_POINTER_SUFFIX);
    if (session === null) return [];
    const path = join(dir, entry);
    const read = readTrackingEntry(path, operations, diagnostics);
    if (read.kind === "unreadable") return [sessionGroupKey(session)];
    if (read.kind === "absent") return [];
    const pointer = parseCanonicalTaskGraphPointer(read.text);
    if (!pointer.ok) {
      diagnostics.push(diagnostic("parse", path, pointer.error));
      return [];
    }
    return operations.exists(pointer.value) ? [sessionGroupKey(session)] : [];
  });
}

/** Shell: whether one binding keeps its session. An unreadable run may be open, so it keeps it and is reported. */
function bindingKeepsSession(
  binding: SessionRunBinding,
  operations: StaleSessionOperations,
  diagnostics: StaleCleanupDiagnostic[],
): boolean {
  return match(operations.observeBoundRun(binding))
    .with({ kind: "absent" }, () => false)
    .with({ kind: "observed" }, ({ liveness }) => liveness.kind === "open")
    .with({ kind: "unreadable" }, ({ cause }) => {
      diagnostics.push(diagnostic("read", binding.runDirectory, cause));
      return true;
    })
    .exhaustive();
}

/** The registry's JSON, or null after reporting why it is not JSON. */
function registryJson(path: string, raw: string, diagnostics: StaleCleanupDiagnostic[]): Readonly<{ json: unknown }> | null {
  try {
    return { json: JSON.parse(raw) as unknown };
  } catch (error) {
    diagnostics.push(diagnostic("parse", path, error));
    return null;
  }
}

/**
 * Shell: the session groups among `entries` whose run binding registry names
 * an open run. Mirrors the pointer rules: a malformed registry binds nothing
 * (it ages out) and is reported; an unreadable one may be live, so it protects
 * its session and is reported. Every binding is observed, so each unreadable
 * run is reported even when an earlier one already kept the session.
 */
function sessionsWithOpenRuns(
  dir: string,
  entries: readonly string[],
  operations: StaleSessionOperations,
  diagnostics: StaleCleanupDiagnostic[],
): readonly SessionGroupKey[] {
  return entries.flatMap((entry) => {
    const session = sessionNamedBy(entry, ORCHESTRATION_RUNS_SUFFIX);
    if (session === null) return [];
    const path = join(dir, entry);
    const read = readTrackingEntry(path, operations, diagnostics);
    if (read.kind === "unreadable") return [sessionGroupKey(session)];
    if (read.kind === "absent") return [];
    const parsed = registryJson(path, read.text, diagnostics);
    if (parsed === null) return [];
    const registry = parsePublishedSessionRunBindingRegistry(parsed.json, session);
    if (!registry.ok) {
      diagnostics.push(diagnostic("parse", path, registry.message));
      return [];
    }
    const kept = registry.value.bindings.map((binding) => bindingKeepsSession(binding, operations, diagnostics));
    return kept.includes(true) ? [sessionGroupKey(session)] : [];
  });
}

/**
 * Shell: the sessions kept by what they are bound to: a TaskGraph that still
 * exists, or an open run. Only registries inside the open-run grace window
 * (`entriesWithinOpenRunGrace`) are read.
 */
function boundSessions(
  dir: string,
  mtimes: ReadonlyMap<string, number>,
  cutoffs: SweepCutoffs,
  alreadyProtected: ReadonlySet<SessionGroupKey>,
  operations: StaleSessionOperations,
  diagnostics: StaleCleanupDiagnostic[],
): readonly SessionGroupKey[] {
  const graphBound = graphBoundSessions(dir, [...mtimes.keys()], operations, diagnostics);
  const protectedSoFar = new Set([...alreadyProtected, ...graphBound]);
  const withinGrace = entriesWithinOpenRunGrace(mtimes, cutoffs, protectedSoFar);
  return [...graphBound, ...sessionsWithOpenRuns(dir, withinGrace, operations, diagnostics)];
}

/**
 * Shell: returns every failed operation with its exact path and cause. A
 * session idle past `cutoffs.idleMs` is swept unless it is protected; one whose
 * run binding names an open run is kept until it is idle past `cutoffs.openRunMs`.
 */
export function sweepStaleSessions(
  dir: string,
  cutoffs: SweepCutoffs,
  operations: StaleSessionOperations = REAL_STALE_SESSION_OPERATIONS,
  startingSession: SessionId | null = null,
): readonly StaleCleanupDiagnostic[] {
  const directory = operations.probeDirectory(dir);
  if (directory.kind === "absent") return Object.freeze([]);
  if (directory.kind === "unavailable") {
    const diagnostics = Object.freeze([diagnostic("read-directory", dir, directory.cause)]);
    process.stderr.write(`${renderDiagnostic(diagnostics[0])}\n`);
    return diagnostics;
  }

  const diagnostics: StaleCleanupDiagnostic[] = [];
  const mtimes = new Map<string, number>();
  const protectedSessions = new Set<SessionGroupKey>(startingSession === null ? [] : [sessionGroupKey(startingSession)]);
  for (const entry of directory.entries) {
    const path = join(dir, entry);
    try {
      mtimes.set(entry, operations.mtime(path));
    } catch (error) {
      const session = sessionGroupOfTrackingFile(entry);
      if (session !== null) protectedSessions.add(session);
      if (isDeadStatFailure(error)) {
        // Provably-dead entry (self-referential/dangling symlink): rmSync
        // removes the link itself, never its target. Success heals the
        // directory silently; a failed removal still surfaces so the
        // operator knows it persisted.
        try {
          operations.remove(path);
        } catch (removeError) {
          diagnostics.push(diagnostic("remove", path, removeError));
        }
        continue;
      }
      diagnostics.push(diagnostic("stat", path, error));
    }
  }
  for (const session of boundSessions(dir, mtimes, cutoffs, protectedSessions, operations, diagnostics)) {
    protectedSessions.add(session);
  }
  for (const entry of staleEntries(mtimes, cutoffs.idleMs, protectedSessions)) {
    const path = join(dir, entry);
    try {
      operations.remove(path);
    } catch (error) {
      diagnostics.push(diagnostic("remove", path, error));
    }
  }
  for (const failure of diagnostics) process.stderr.write(`${renderDiagnostic(failure)}\n`);
  return Object.freeze(diagnostics);
}

export function runCleanupStaleSubagents(
  dir: string,
  nowMs: number,
  operations: StaleSessionOperations = REAL_STALE_SESSION_OPERATIONS,
  startingSession: StartingSession = NO_STARTING_SESSION,
) {
  const inputDiagnostics = startingSession.kind === "unusable"
    ? [diagnostic("parse", "SessionStart input", startingSession.cause)]
    : [];
  for (const failure of inputDiagnostics) process.stderr.write(`${renderDiagnostic(failure)}\n`);
  const named = startingSession.kind === "named" ? startingSession.sessionId : null;
  const cutoffs = sweepCutoffs(nowMs - STALE_SUBAGENT_TTL_MS);
  const diagnostics = [...inputDiagnostics, ...sweepStaleSessions(dir, cutoffs, operations, named)];
  return passthroughResult(
    diagnostics.length === 0 ? undefined : diagnostics.map(renderDiagnostic).join("\n"),
  );
}

const handler: HookHandler = async (stdin, _args) =>
  runCleanupStaleSubagents(SUBAGENT_DIR, Date.now(), REAL_STALE_SESSION_OPERATIONS, startingSessionOf(stdin));

export default handler;
