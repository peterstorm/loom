/**
 * Clean up stale subagent tracking files from previous sessions.
 *
 * Staleness is judged per SESSION GROUP, not per file: only the `.machine`
 * binding file has its mtime refreshed by refreshBindingActivity, so a
 * long-lived session's `.active` roster or `.evidence.jsonl` ledger would
 * look stale on its own mtime while the session is demonstrably live. A
 * session's files are deleted only when the MAX mtime across ALL of its
 * files (every SESSION_SUFFIXES entry — the single source of truth in
 * machine/evidence.ts) exceeds STALE_SUBAGENT_TTL_MS (shared with the
 * machine-binding liveness TTL). Files that match no known session suffix
 * fall back to their own mtime.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { passthroughResult, type HookHandler } from "../../types";
import { STALE_SUBAGENT_TTL_MS, SUBAGENT_DIR } from "../../config";
import {
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  SESSION_SUFFIXES,
} from "../../machine";

/** Pure: session id for a tracking file, or null when the name matches no
 *  known per-session suffix. */
export function sessionOfEntry(entry: string): string | null {
  if (entry.endsWith(IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX)) {
    const keyed = entry.slice(0, -IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX.length);
    const separator = keyed.lastIndexOf(".");
    const encodedAgent = separator < 0 ? "" : keyed.slice(separator + 1);
    if (separator > 0 && encodedAgent.length > 0 && encodedAgent.length % 2 === 0 &&
        /^[0-9a-f]+$/.test(encodedAgent)) {
      return keyed.slice(0, separator);
    }
    return null;
  }
  for (const suffix of SESSION_SUFFIXES) {
    if (entry.endsWith(suffix) && entry.length > suffix.length) {
      return entry.slice(0, -suffix.length);
    }
  }
  return null;
}

/**
 * Pure: which entries are stale, judged per session group. `mtimes` maps
 * each entry to its mtime (ms); entries in the same session group share the
 * group's max mtime, ungrouped entries stand alone.
 */
export function staleEntries(
  mtimes: ReadonlyMap<string, number>,
  cutoffMs: number,
): string[] {
  const groupMax = new Map<string, number>();
  for (const [entry, mtime] of mtimes) {
    const session = sessionOfEntry(entry);
    if (session === null) continue;
    groupMax.set(session, Math.max(groupMax.get(session) ?? -Infinity, mtime));
  }
  return [...mtimes.entries()]
    .filter(([entry, mtime]) => {
      const session = sessionOfEntry(entry);
      const anchor = session === null ? mtime : (groupMax.get(session) ?? mtime);
      return anchor < cutoffMs;
    })
    .map(([entry]) => entry);
}

/** Shell: sweep one tracking dir. Dir is a parameter so tests can run the
 *  sweep hermetically against a temp dir (SUBAGENT_DIR freezes at first
 *  config import, which a shared-process test run cannot re-point). */
export type StaleCleanupDiagnostic = Readonly<{
  operation: "read-directory" | "stat" | "remove";
  path: string;
  cause: string;
}>;

export type StaleSessionOperations = Readonly<{
  exists: (path: string) => boolean;
  entries: (path: string) => readonly string[];
  mtime: (path: string) => number;
  remove: (path: string) => void;
}>;

const REAL_STALE_SESSION_OPERATIONS: StaleSessionOperations = Object.freeze({
  exists: existsSync,
  entries: readdirSync,
  mtime: (path) => statSync(path).mtimeMs,
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

/** Shell: returns every failed operation with its exact path and cause. */
export function sweepStaleSessions(
  dir: string,
  cutoffMs: number,
  operations: StaleSessionOperations = REAL_STALE_SESSION_OPERATIONS,
): readonly StaleCleanupDiagnostic[] {
  if (!operations.exists(dir)) return Object.freeze([]);
  const diagnostics: StaleCleanupDiagnostic[] = [];
  let entries: readonly string[];
  try {
    entries = operations.entries(dir);
  } catch (error) {
    diagnostics.push(diagnostic("read-directory", dir, error));
    entries = [];
  }

  const mtimes = new Map<string, number>();
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      mtimes.set(entry, operations.mtime(path));
    } catch (error) {
      diagnostics.push(diagnostic("stat", path, error));
    }
  }
  for (const entry of staleEntries(mtimes, cutoffMs)) {
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

const handler: HookHandler = async (_stdin, _args) => {
  const diagnostics = sweepStaleSessions(SUBAGENT_DIR, Date.now() - STALE_SUBAGENT_TTL_MS);
  return passthroughResult(
    diagnostics.length === 0 ? undefined : diagnostics.map(renderDiagnostic).join("\n"),
  );
};

export default handler;
