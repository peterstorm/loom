/**
 * Cross-platform file locking
 * Uses rename-based dir locking (atomic on all platforms):
 * - BIRTH is atomic: the pid file is staged in a private temp dir and
 *   renameSync'd onto the lock path, so no contender can ever observe a
 *   pid-less live lock (the old mkdir-then-write window read as "stale").
 * - RETIRING a stale lock is generation-addressed: birth writes PID and a
 *   unique generation in one owner record. Every observer of that generation
 *   renames toward the same persistent, non-empty fence, so a delayed observer
 *   cannot rename a newer live generation after another contender acquires it.
 * - RELEASE is ownership-checked: only the process the pid file names may
 *   remove the lock, so a holder whose lock was stolen cannot break the new
 *   holder's mutual exclusion on its way out.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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

type LockObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "live" }>
  | Readonly<{ kind: "stale"; generation: string }>;

export type StaleLockObservation = Readonly<{
  lockDir: string;
  generation: string;
}>;

const staleObservationProofs = new WeakSet<object>();

const OWNER_RECORD = /^(?<pid>[1-9][0-9]*):(?<generation>[a-zA-Z0-9-]+)$/;

function legacyGeneration(ownerText: string | null): string {
  if (ownerText === null) return "legacy-missing-owner";
  const digest = createHash("sha256").update(ownerText).digest("hex").slice(0, 24);
  return `legacy-${digest}`;
}

function parseOwner(ownerText: string): Readonly<{ pid: number; generation: string }> | null {
  const match = OWNER_RECORD.exec(ownerText.trim());
  if (match?.groups === undefined) return null;
  const pid = Number(match.groups["pid"]);
  const generation = match.groups["generation"];
  return Number.isSafeInteger(pid) && generation !== undefined ? { pid, generation } : null;
}

function observeLock(lockDir: string): LockObservation {
  let ownerText: string;
  try {
    ownerText = readFileSync(join(lockDir, "pid"), "utf-8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return { kind: "live" };
    try {
      // Distinguish a missing owner record in an existing legacy lock from an
      // acquisition race in which the whole lock has already disappeared.
      statSync(lockDir);
      return { kind: "stale", generation: legacyGeneration(null) };
    } catch (lockError) {
      return (lockError as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { kind: "absent" }
        : { kind: "live" };
    }
  }

  const parsed = parseOwner(ownerText);
  const pid = parsed?.pid ?? Number(ownerText);
  const generation = parsed?.generation ?? legacyGeneration(ownerText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "stale", generation };
  try {
    process.kill(pid, 0);
    return { kind: "live" };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ESRCH"
      ? { kind: "stale", generation }
      : { kind: "live" };
  }
}

/** Check if a lock dir is stale (owning process is dead). */
export function isStaleLock(lockDir: string): boolean {
  return observeLock(lockDir).kind === "stale";
}

/** Mint stale-generation authority from one owner-record observation. */
export function observeStaleLock(lockDir: string): StaleLockObservation | null {
  const observed = observeLock(lockDir);
  if (observed.kind !== "stale") return null;
  const stale = Object.freeze({ lockDir, generation: observed.generation });
  staleObservationProofs.add(stale);
  return stale;
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
    writeFileSync(join(staging, "pid"), `${process.pid}:${randomUUID()}`);
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
 * Retire one already-observed stale generation. The destination is deliberately
 * persistent and non-empty: once generation G is retired, every delayed G
 * observer collides with the same fence instead of moving whichever generation
 * now occupies `lockDir`.
 *
 * Exported for the deterministic late-observer regression only.
 */
export function retireObservedStaleLock(observed: StaleLockObservation): boolean {
  if (!staleObservationProofs.has(observed)) {
    throw new Error("Stale lock retirement requires a parser-minted observation");
  }
  const { lockDir, generation } = observed;
  const retired = `${lockDir}.retired-${generation}`;
  try {
    // This also makes a legacy pid-less lock non-empty before rename. A late
    // observer may write the same marker, but can never remove it.
    writeFileSync(join(lockDir, "retired"), generation, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    renameSync(lockDir, retired);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
    throw error;
  }
  process.stderr.write(`Retired stale lock generation ${generation}: ${lockDir}\n`);
  return true;
}

/** Observe and retire a stale lock; false means absent, live, or lost race. */
export function stealStaleLock(lockDir: string): boolean {
  const observed = observeStaleLock(lockDir);
  return observed === null ? false : retireObservedStaleLock(observed);
}

export async function acquireLock(lockFile: string): Promise<void> {
  const lockDir = `${lockFile}.lock`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryBirthLock(lockDir)) return;
    // Check for stale lock on first retry.
    if (attempt === 0 && stealStaleLock(lockDir)) {
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
    if (attempt === 0 && stealStaleLock(lockDir)) continue;
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
    pid = readFileSync(join(lockDir, "pid"), "utf-8").trim().split(":", 1)[0] ?? "";
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
