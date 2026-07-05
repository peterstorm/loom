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
import type { HookHandler } from "../../types";
import { STALE_SUBAGENT_TTL_MS, SUBAGENT_DIR } from "../../config";
import { SESSION_SUFFIXES } from "../../machine";

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
    let failedStats = 0;
    for (const entry of readdirSync(dir)) {
      try {
        mtimes.set(entry, statSync(join(dir, entry)).mtimeMs);
      } catch {
        failedStats++;
      }
    }
    if (failedStats > 0) {
      // An unstatable entry is excluded from its session group's max-mtime
      // anchor AND from the sweep — say so once (mirrors failedRemovals).
      process.stderr.write(
        `cleanup-stale-subagents: could not stat ${failedStats} tracking entr${failedStats === 1 ? "y" : "ies"} under ${dir} — skipped this sweep\n`,
      );
    }
    let failedRemovals = 0;
    for (const entry of staleEntries(mtimes, cutoffMs)) {
      // rmSync handles both files and the `.cleanup` mkdir-lock directories.
      try {
        rmSync(join(dir, entry), { recursive: true, force: true });
      } catch {
        failedRemovals++;
      }
    }
    if (failedRemovals > 0) {
      process.stderr.write(
        `cleanup-stale-subagents: ${failedRemovals} stale tracking entr${failedRemovals === 1 ? "y" : "ies"} could not be removed under ${dir}\n`,
      );
    }
  } catch (e) {
    // A failed sweep leaks stale bindings/rosters until the NEXT session
    // start — mirror the pi twin's logging instead of swallowing it.
    process.stderr.write(
      `loom: session cleanup failed for ${dir}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

const handler: HookHandler = async (_stdin, _args) => {
  sweepStaleSessions(SUBAGENT_DIR, Date.now() - STALE_SUBAGENT_TTL_MS);
  return { kind: "passthrough" };
};

export default handler;
