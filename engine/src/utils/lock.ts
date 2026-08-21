/**
 * Cross-platform file locking
 * Uses rename-based dir locking (atomic on all platforms):
 * - BIRTH is atomic: the pid file is staged in a private temp dir and
 *   renameSync'd onto the lock path, so no contender can ever observe a
 *   pid-less live lock (the old mkdir-then-write window read as "stale").
 * - RETIREMENT is generation-claimed: an observer or owner must atomically
 *   claim the current generation and then re-read its owner record before it
 *   may rename. Release and stale observation therefore cannot overlap, and
 *   authority for generation G cannot move a newly acquired generation H.
 * - RELEASE is ownership-checked: only the process the claimed owner record
 *   names may retire the lock, so a holder whose lock was stolen cannot break
 *   the new holder's mutual exclusion on its way out.
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

type LockSnapshot =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable"; error: unknown }>
  | Readonly<{
      kind: "observed";
      ownerText: string | null;
      pid: number | null;
      generation: string;
    }>;

type GenerationClaim = Readonly<{
  lockDir: string;
  ownerText: string | null;
  generation: string;
  claimantPid: number;
  claimedAtMs: number;
  claimToken: string;
}>;

type GenerationClaimOwner = Readonly<{
  pid: number;
  claimedAtMs: number;
}>;

export type StaleLockObservation = GenerationClaim;

const staleObservationProofs = new WeakSet<object>();
const GENERATION_CLAIM = "generation-claim";
const GENERATION_CLAIM_EXPIRY_MS = 30_000;
const OWNER_RECORD = /^(?<pid>[1-9][0-9]*):(?<generation>[a-zA-Z0-9-]+)$/;
const GENERATION_CLAIM_RECORD = /^v1:(?<pid>[1-9][0-9]*):(?<claimedAtMs>[0-9]+):[a-zA-Z0-9-]+:[a-zA-Z0-9-]+$/;

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

function snapshotLock(lockDir: string): LockSnapshot {
  let ownerText: string;
  try {
    ownerText = readFileSync(join(lockDir, "pid"), "utf-8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return { kind: "unreadable", error };
    }
    try {
      statSync(lockDir);
      return {
        kind: "observed",
        ownerText: null,
        pid: null,
        generation: legacyGeneration(null),
      };
    } catch (lockError) {
      return (lockError as NodeJS.ErrnoException)?.code === "ENOENT"
        ? { kind: "absent" }
        : { kind: "unreadable", error: lockError };
    }
  }

  const parsed = parseOwner(ownerText);
  const rawPid = parsed?.pid ?? Number(ownerText);
  return {
    kind: "observed",
    ownerText,
    pid: Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : null,
    generation: parsed?.generation ?? legacyGeneration(ownerText),
  };
}

function claimText(claim: GenerationClaim): string {
  return `v1:${claim.claimantPid}:${claim.claimedAtMs}:${claim.generation}:${claim.claimToken}`;
}

function parseGenerationClaimOwner(text: string): GenerationClaimOwner | null {
  const match = GENERATION_CLAIM_RECORD.exec(text);
  if (match?.groups === undefined) return null;
  const pid = Number(match.groups["pid"]);
  const claimedAtMs = Number(match.groups["claimedAtMs"]);
  return Number.isSafeInteger(pid) && Number.isSafeInteger(claimedAtMs)
    ? Object.freeze({ pid, claimedAtMs })
    : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * Reap a claim whose process died or whose short retirement lease expired.
 * The retirement path re-checks the fixed claim bytes before moving the lock,
 * so even a claimant paused beyond the lease loses authority rather than
 * retiring a generation after another claimant recovered it.
 */
function reapOrphanedGenerationClaim(lockDir: string): boolean {
  const path = join(lockDir, GENERATION_CLAIM);
  let observed: string;
  try {
    observed = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw error;
  }

  const owner = parseGenerationClaimOwner(observed);
  const claimedAtMs = owner?.claimedAtMs ?? statSync(path).mtimeMs;
  const expired = Date.now() - claimedAtMs >= GENERATION_CLAIM_EXPIRY_MS;
  if (!expired && (owner === null || processIsAlive(owner.pid))) return false;

  try {
    if (readFileSync(path, "utf-8") !== observed) return false;
    rmSync(path, { force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw error;
  }
}

function releaseGenerationClaim(claim: GenerationClaim): void {
  const path = join(claim.lockDir, GENERATION_CLAIM);
  try {
    if (readFileSync(path, "utf-8") !== claimText(claim)) return;
    rmSync(path, { force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

function claimGeneration(
  lockDir: string,
  snapshot: Extract<LockSnapshot, { kind: "observed" }>,
): GenerationClaim | null {
  const claim = Object.freeze({
    lockDir,
    ownerText: snapshot.ownerText,
    generation: snapshot.generation,
    claimantPid: process.pid,
    claimedAtMs: Date.now(),
    claimToken: randomUUID(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(join(lockDir, GENERATION_CLAIM), claimText(claim), { flag: "wx" });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return null;
      if (code !== "EEXIST") throw error;
      if (attempt > 0 || !reapOrphanedGenerationClaim(lockDir)) return null;
    }
  }

  const current = snapshotLock(lockDir);
  if (current.kind !== "observed" ||
      current.ownerText !== snapshot.ownerText ||
      current.generation !== snapshot.generation) {
    releaseGenerationClaim(claim);
    return null;
  }
  return claim;
}

/** Mint exclusive stale-generation authority from one stable owner snapshot. */
export function observeStaleLock(lockDir: string): StaleLockObservation | null {
  const snapshot = snapshotLock(lockDir);
  if (snapshot.kind !== "observed") return null;
  const claim = claimGeneration(lockDir, snapshot);
  if (claim === null) return null;

  if (snapshot.pid !== null) {
    try {
      process.kill(snapshot.pid, 0);
      releaseGenerationClaim(claim);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") {
        releaseGenerationClaim(claim);
        return null;
      }
    }
  }

  staleObservationProofs.add(claim);
  return claim;
}

/** Check if a lock dir is stale without retaining retirement authority. */
export function isStaleLock(lockDir: string): boolean {
  const observed = observeStaleLock(lockDir);
  if (observed === null) return false;
  releaseGenerationClaim(observed);
  return true;
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

function retireClaimedGeneration(claim: GenerationClaim): boolean {
  const snapshot = snapshotLock(claim.lockDir);
  let currentClaim: string;
  try {
    currentClaim = readFileSync(join(claim.lockDir, GENERATION_CLAIM), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
  if (snapshot.kind !== "observed" ||
      snapshot.ownerText !== claim.ownerText ||
      snapshot.generation !== claim.generation ||
      currentClaim !== claimText(claim)) {
    releaseGenerationClaim(claim);
    return false;
  }

  const retired = `${claim.lockDir}.retiring-${claim.claimToken}`;
  try {
    renameSync(claim.lockDir, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
  rmSync(retired, { recursive: true, force: false });
  return true;
}

/**
 * Retire one exclusively claimed generation. The claim lives inside the lock
 * directory, so moving the directory consumes both the generation and the
 * authority atomically; a claim minted for G cannot remain at the path after H
 * acquires. Exported for deterministic race regressions only.
 */
export function retireObservedStaleLock(observed: StaleLockObservation): boolean {
  if (!staleObservationProofs.has(observed)) {
    throw new Error("Stale lock retirement requires a parser-minted observation");
  }
  const retired = retireClaimedGeneration(observed);
  if (retired) {
    process.stderr.write(`Retired stale lock generation ${observed.generation}: ${observed.lockDir}\n`);
  }
  return retired;
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
    // A claimant may die after any earlier observation. Re-check on every
    // retry; generation/token authority still prevents retiring a replacement.
    if (stealStaleLock(lockDir)) continue;
    await sleep(RETRY_MS);
  }

  throw new Error(`Could not acquire lock after ${MAX_ATTEMPTS} attempts: ${lockFile}`);
}

/** Acquire the same cross-process lock for a synchronous shell boundary. */
export function acquireLockSync(lockFile: string): void {
  const lockDir = `${lockFile}.lock`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryBirthLock(lockDir)) return;
    if (stealStaleLock(lockDir)) continue;
    sleepSync(RETRY_MS);
  }

  throw new Error(`Could not acquire lock after ${MAX_ATTEMPTS} attempts: ${lockFile}`);
}

export function releaseLock(lockFile: string): void {
  const lockDir = `${lockFile}.lock`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const snapshot = snapshotLock(lockDir);
    if (snapshot.kind === "absent") return;
    if (snapshot.kind === "unreadable") {
      throw new Error(
        `Cannot inspect lock ownership for ${lockDir}: ${snapshot.error instanceof Error ? snapshot.error.message : String(snapshot.error)}`,
        { cause: snapshot.error },
      );
    }
    if (snapshot.pid !== process.pid) return;

    const claim = claimGeneration(lockDir, snapshot);
    if (claim === null) {
      sleepSync(RETRY_MS);
      continue;
    }
    try {
      if (retireClaimedGeneration(claim)) return;
    } catch (error) {
      throw new Error(
        `Failed to release owned lock ${lockDir}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  throw new Error(`Failed to release owned lock ${lockDir}: generation claim remained contended`);
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
