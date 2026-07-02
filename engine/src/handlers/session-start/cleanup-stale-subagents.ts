/**
 * Clean up stale subagent tracking files from previous sessions.
 *
 * Staleness is judged per SESSION GROUP, not per file: only the `.machine`
 * binding file has its mtime refreshed by refreshBindingActivity, so a
 * long-lived session's `.active` roster or `.evidence.jsonl` ledger would
 * look stale on its own mtime while the session is demonstrably live. A
 * session's files are deleted only when the MAX mtime across ALL of its
 * files (`.machine` / `.active` / `.evidence.jsonl` / `.cleanup` /
 * `.task_graph`) exceeds STALE_SUBAGENT_TTL_MS (shared with the
 * machine-binding liveness TTL). Files that match no known session suffix
 * fall back to their own mtime.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler } from "../../types";
import { STALE_SUBAGENT_TTL_MS, SUBAGENT_DIR } from "../../config";

/** Every per-session file suffix written under SUBAGENT_DIR — keep in sync
 *  with machine/ledger.ts path helpers and mark-subagent-active. Ordered so
 *  the multi-dot suffix wins over any accidental shorter match. */
const SESSION_SUFFIXES = [
  ".evidence.jsonl",
  ".machine",
  ".active",
  ".cleanup",
  ".task_graph",
] as const;

/** Pure: session id for a tracking file, or null when the name matches no
 *  known per-session suffix. */
export function sessionOfEntry(entry: string): string | null {
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
export function sweepStaleSessions(dir: string, cutoffMs: number): void {
  if (!existsSync(dir)) return;

  try {
    const mtimes = new Map<string, number>();
    for (const entry of readdirSync(dir)) {
      try {
        mtimes.set(entry, statSync(join(dir, entry)).mtimeMs);
      } catch {}
    }
    for (const entry of staleEntries(mtimes, cutoffMs)) {
      // rmSync handles both files and the `.cleanup` mkdir-lock directories.
      try {
        rmSync(join(dir, entry), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

const handler: HookHandler = async (_stdin, _args) => {
  sweepStaleSessions(SUBAGENT_DIR, Date.now() - STALE_SUBAGENT_TTL_MS);
  return { kind: "passthrough" };
};

export default handler;
