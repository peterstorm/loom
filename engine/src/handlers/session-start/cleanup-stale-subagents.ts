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
 * When either fact cannot be read (SessionStart input without a usable
 * `session_id`, a malformed pointer) the sweep says so in its diagnostics: a
 * silent miss would bring back the deleted-ledger failure with no trace.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { passthroughResult, type HookHandler } from "../../types";
import { STALE_SUBAGENT_TTL_MS, SUBAGENT_DIR } from "../../config";
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
 * `protectedSessions` (alive, or not observable) is never stale.
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
      const session = sessionGroupOfTrackingFile(entry);
      if (session !== null && protectedSessions.has(session)) return false;
      const anchor = session === null ? mtime : (groupMax.get(session) ?? mtime);
      return anchor < cutoffMs;
    })
    .map(([entry]) => entry);
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
    const session = entry.endsWith(TASK_GRAPH_POINTER_SUFFIX) ? entry.slice(0, -TASK_GRAPH_POINTER_SUFFIX.length) : "";
    if (session === "") return [];
    const path = join(dir, entry);
    let raw: string | null;
    try {
      raw = operations.readText(path);
    } catch (error) {
      diagnostics.push(diagnostic("read", path, error));
      return [sessionGroupKey(session)];
    }
    if (raw === null) return [];
    const pointer = parseCanonicalTaskGraphPointer(raw);
    if (!pointer.ok) {
      diagnostics.push(diagnostic("parse", path, pointer.error));
      return [];
    }
    return operations.exists(pointer.value) ? [sessionGroupKey(session)] : [];
  });
}

/** Shell: returns every failed operation with its exact path and cause. */
export function sweepStaleSessions(
  dir: string,
  cutoffMs: number,
  operations: StaleSessionOperations = REAL_STALE_SESSION_OPERATIONS,
  startingSession: SessionId | null = null,
): readonly StaleCleanupDiagnostic[] {
  const directory = operations.probeDirectory(dir);
  if (directory.kind === "absent") return Object.freeze([]);
  if (directory.kind === "unavailable") {
    const diagnostics = Object.freeze([diagnostic("read-directory", dir, directory.cause)]);
    process.stderr.write(`${renderDiagnostic(diagnostics[0]!)}\n`);
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
  for (const session of graphBoundSessions(dir, [...mtimes.keys()], operations, diagnostics)) {
    protectedSessions.add(session);
  }
  for (const entry of staleEntries(mtimes, cutoffMs, protectedSessions)) {
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
  const diagnostics = [...inputDiagnostics, ...sweepStaleSessions(dir, nowMs - STALE_SUBAGENT_TTL_MS, operations, named)];
  return passthroughResult(
    diagnostics.length === 0 ? undefined : diagnostics.map(renderDiagnostic).join("\n"),
  );
}

const handler: HookHandler = async (stdin, _args) =>
  runCleanupStaleSubagents(SUBAGENT_DIR, Date.now(), REAL_STALE_SESSION_OPERATIONS, startingSessionOf(stdin));

export default handler;
