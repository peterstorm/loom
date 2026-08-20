/**
 * Cross-platform file locking
 * Uses rename-based dir locking (atomic on all platforms):
 * - BIRTH is atomic: the pid file is staged in a private temp dir and
 *   renameSync'd onto the lock path, so no contender can ever observe a
 *   pid-less live lock (the old mkdir-then-write window read as "stale").
 * - STEALING a stale lock is atomic: the victim dir is renameSync'd into a
 *   private tomb first — of two contenders that both judged the same lock
 *   stale, only one rename succeeds, so the loser can never rmSync a FRESH
 *   lock re-created at the path in the meantime.
 * - RELEASE is ownership-checked: only the process the pid file names may
 *   remove the lock, so a holder whose lock was stolen cannot break the new
 *   holder's mutual exclusion on its way out.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const MAX_ATTEMPTS = 50;
const RETRY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Synchronous retry delay for shell APIs whose public contract is synchronous. */
function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, ms);
}

/** Check if a lock dir is stale (owning process is dead) */
export function isStaleLock(lockDir: string): boolean {
  try {
    const pid = Number(readFileSync(join(lockDir, "pid"), "utf-8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0); // throws if process doesn't exist
    return false;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // A missing pid file or dead owner is stale. Every access/path/I/O error
    // is treated as a live lock so an authority failure cannot break mutual
    // exclusion.
    return code === "ENOENT" || code === "ESRCH";
  }
}

/**
 * Atomic birth: stage `<lockDir>/pid` in a private temp dir, then rename it
 * onto the lock path. False when the lock is held (rename refuses to
 * replace a non-empty dir — the EEXIST-equivalent); non-retryable errors
 * (EACCES / ENOENT / ENOSPC) throw, exactly like the old bare mkdirSync.
 */
function tryBirthLock(lockDir: string): boolean {
  const staging = mkdtempSync(`${lockDir}.birth-`);
  try {
    writeFileSync(join(staging, "pid"), `${process.pid}`);
    renameSync(staging, lockDir);
    return true;
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    const code = (err as NodeJS.ErrnoException)?.code;
    // rename onto an existing non-empty dir: the lock is held by someone.
    // (Linux reports ENOTEMPTY, some platforms EEXIST.)
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Atomic steal of a stale lock. Rename the victim into a private tomb:
 * losers of the rename race fall through to a normal retry instead of
 * rmSync'ing whatever now lives at the path. The staleness judgment is
 * repeated INSIDE the tomb — if a faster contender already reaped and a
 * fresh lock was re-born between our read and our rename, we stole a LIVE
 * lock and must put it back. True only when this process reaped the stale
 * dir (caller may retry acquisition immediately).
 *
 * Exported for tests only — withLock/acquireLock are the real API.
 */
export function stealStaleLock(lockDir: string): boolean {
  const tomb = `${lockDir}.tomb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(lockDir, tomb);
  } catch {
    // Someone else stole or released it first — normal retry, never a crash.
    return false;
  }
  if (!isStaleLock(tomb)) {
    // We grabbed a live lock (stale-reap + fresh re-birth raced our rename):
    // restore it. If the path was ALREADY re-taken, restoring is impossible —
    // the victim holder lost its lock; say so loudly (its ownership-checked
    // release will no-op) instead of leaving a silent double-hold.
    try {
      renameSync(tomb, lockDir);
    } catch {
      rmSync(tomb, { recursive: true, force: true });
      process.stderr.write(
        `WARNING: displaced a live lock while reaping ${lockDir} — the previous holder's lock is gone and its release will no-op\n`,
      );
    }
    return false;
  }
  rmSync(tomb, { recursive: true, force: true });
  process.stderr.write(`Removed stale lock: ${lockDir}\n`);
  return true;
}

export async function acquireLock(lockFile: string): Promise<void> {
  const lockDir = `${lockFile}.lock`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryBirthLock(lockDir)) return;
    // Check for stale lock on first retry
    if (attempt === 0 && isStaleLock(lockDir) && stealStaleLock(lockDir)) {
      continue; // we won the reap → retry immediately
    }
    await sleep(RETRY_MS);
  }

  throw new Error(`Could not acquire lock after ${MAX_ATTEMPTS} attempts: ${lockFile}`);
}

/** Acquire the same cross-process lock for a synchronous shell boundary. */
export function acquireLockSync(lockFile: string): void {
  const lockDir = `${lockFile}.lock`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryBirthLock(lockDir)) return;
    if (attempt === 0 && isStaleLock(lockDir) && stealStaleLock(lockDir)) continue;
    sleepSync(RETRY_MS);
  }

  throw new Error(`Could not acquire lock after ${MAX_ATTEMPTS} attempts: ${lockFile}`);
}

export function releaseLock(lockFile: string): void {
  const lockDir = `${lockFile}.lock`;
  let pid: string;
  try {
    // Ownership check: if this lock was stale-reaped and re-acquired while
    // we ran, the pid file names the NEW holder — removing it would break
    // their mutual exclusion too. Only the recorded owner releases; a
    // genuinely missing lock remains an idempotent no-op.
    pid = readFileSync(join(lockDir, "pid"), "utf-8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw new Error(
      `Cannot inspect lock ownership for ${lockDir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (pid !== `${process.pid}`) return;
  try {
    rmSync(lockDir, { recursive: true, force: false });
  } catch (error) {
    throw new Error(
      `Failed to release owned lock ${lockDir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Run fn while holding lock, auto-release on completion or error. */
export async function withLock<T>(lockFile: string, fn: () => T | Promise<T>): Promise<T> {
  await acquireLock(lockFile);
  try {
    return await fn();
  } finally {
    releaseLock(lockFile);
  }
}

/** Synchronous counterpart for synchronous filesystem adapters. */
export function withLockSync<T>(lockFile: string, fn: () => T): T {
  acquireLockSync(lockFile);
  try {
    return fn();
  } finally {
    releaseLock(lockFile);
  }
}
