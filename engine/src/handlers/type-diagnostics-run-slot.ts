/**
 * The type-diagnostics RUN SLOT: at most one type check per tsconfig at a time.
 *
 * A slot file names its owner as `{pid, startedAt, output}`. It is created
 * atomically, by linking a fully written staging file into place, so no
 * reader ever sees a half-written record. A second check that finds the owner
 * alive is `busy`.
 *
 * A slot is reclaimed when its owner is dead, older than STALE_RUN_MS (which
 * bounds the damage of a recycled pid), or its record is unreadable. The
 * reclaimer also removes the old run's output, but only an output inside this
 * cache directory.
 *
 * A check that misses its deadline hands the slot to its detached compiler,
 * so the slot stays held while that compiler finishes warming the cache.
 *
 * Residual race: two checks reclaiming the same stale slot at the same moment
 * can both win. Each run writes its own output file and memory is replaced by
 * atomic rename, so such a pair costs one redundant check, never a corrupted
 * result.
 */

import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isRecord } from "../core/plain-record";

/** A slot older than this is reclaimed even if its pid is alive: the pid may have been recycled. */
export const STALE_RUN_MS = 10 * 60_000;

export type RunSlotPaths = Readonly<{ cacheDir: string; slot: string }>;
export type SlotRecord = Readonly<{ pid: number; startedAt: number; output: string }>;
export type SlotAcquisition = Readonly<{ kind: "acquired" }> | Readonly<{ kind: "busy" }>;

/**
 * Whether a taken slot must be left to its owner or may be reclaimed.
 * `current` is null when the record is unreadable. Pure.
 */
export function slotDecision(current: SlotRecord | null, ownerAlive: boolean, now: number): "busy" | "reclaim" {
  return current !== null && ownerAlive && now - current.startedAt <= STALE_RUN_MS ? "busy" : "reclaim";
}

const errnoCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

function parseSlotRecord(raw: string): SlotRecord | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isRecord(value)) return null;
  const { pid, startedAt, output } = value;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && typeof startedAt === "number" && Number.isFinite(startedAt) && typeof output === "string"
    ? { pid, startedAt, output }
    : null;
}

/** The slot's current record; null when it is absent or unreadable. */
function readSlot(slot: string): SlotRecord | null {
  try {
    return parseSlotRecord(readFileSync(slot, "utf-8"));
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM: the process exists but belongs to another user — still running.
    return errnoCode(error) === "EPERM";
  }
}

/** Write a complete record to a private file first, so the slot never holds a partial one. */
function stageRecord(paths: RunSlotPaths, record: SlotRecord): string {
  const staged = `${paths.slot}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staged, JSON.stringify(record));
  return staged;
}

/** Remove a run's output, but only a run output this cache directory owns. */
function removeRunOutput(paths: RunSlotPaths, output: string): void {
  const resolved = resolve(output);
  if (dirname(resolved) === resolve(paths.cacheDir) && resolved.endsWith(".out")) rmSync(resolved, { force: true });
}

/** Take the slot for `record`, reclaiming it from a dead, stale or unreadable owner. */
export function acquireRunSlot(paths: RunSlotPaths, record: SlotRecord): SlotAcquisition {
  const staged = stageRecord(paths, record);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(staged, paths.slot); // atomic, and fails if the slot is taken
        return { kind: "acquired" };
      } catch (error: unknown) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }
      const current = readSlot(paths.slot);
      if (slotDecision(current, current !== null && isAlive(current.pid), record.startedAt) === "busy") return { kind: "busy" };
      if (current !== null) removeRunOutput(paths, current.output);
      rmSync(paths.slot, { force: true });
    }
    // Another check took the slot between our reclaim and our second link.
    return { kind: "busy" };
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Re-own the held slot to the detached compiler, so it stays held while that process lives. */
export function handSlotTo(paths: RunSlotPaths, record: SlotRecord): void {
  renameSync(stageRecord(paths, record), paths.slot);
}

/** Release the slot this run holds, unless another run has since reclaimed it, and remove this run's output. */
export function releaseRunSlot(paths: RunSlotPaths, output: string): void {
  if (readSlot(paths.slot)?.output === output) rmSync(paths.slot, { force: true });
  removeRunOutput(paths, output);
}
