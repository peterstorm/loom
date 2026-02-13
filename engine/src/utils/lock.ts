/**
 * Cross-platform file locking
 * Uses mkdir-based locking (atomic on all platforms)
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const MAX_ATTEMPTS = 50;
const RETRY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if a lock dir is stale (owning process is dead) */
export function isStaleLock(lockDir: string): boolean {
  try {
    const pidFile = `${lockDir}/pid`;
    if (!existsSync(pidFile)) return true;
    const pid = Number(readFileSync(pidFile, "utf-8").trim());
    if (isNaN(pid)) return true;
    process.kill(pid, 0); // throws if process doesn't exist
    return false;
  } catch (err: unknown) {
    // ESRCH = no such process → stale lock
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ESRCH") {
      return true;
    }
    // EPERM or other → process exists but we can't signal it → not stale
    return false;
  }
}

export async function acquireLock(lockFile: string): Promise<void> {
  const lockDir = `${lockFile}.lock`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      mkdirSync(lockDir);
      writeFileSync(`${lockDir}/pid`, `${process.pid}`);
      return;
    } catch {
      // Check for stale lock on first retry
      if (attempt === 0 && isStaleLock(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
          process.stderr.write(`Removed stale lock: ${lockDir}\n`);
          continue; // retry immediately
        } catch {}
      }
      await sleep(RETRY_MS);
    }
  }

  throw new Error(`Could not acquire lock after ${MAX_ATTEMPTS} attempts: ${lockFile}`);
}

export function releaseLock(lockFile: string): void {
  try {
    rmSync(`${lockFile}.lock`, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Run fn while holding lock, auto-release on completion or error */
export async function withLock<T>(lockFile: string, fn: () => T | Promise<T>): Promise<T> {
  await acquireLock(lockFile);
  try {
    return await fn();
  } finally {
    releaseLock(lockFile);
  }
}
