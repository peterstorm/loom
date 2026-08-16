/**
 * Descriptor-anchored filesystem primitives shared by every run directory.
 *
 * Each absolute path is opened one component at a time relative to the
 * descriptor for its parent, so `O_NOFOLLOW` protects every hop rather than
 * only the final leaf, and validation and use share one descriptor — which is
 * what closes the lstat-before-write race. Callers therefore never hand a
 * path string to the kernel twice and hope it still means the same file.
 *
 * These live in the orchestration layer because both the panel helpers and the
 * anchored `RunDirHandle` need them; the handle is the consolidation point the
 * plan calls for, and the handlers import them back from here.
 */

import {
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export function noFollowFlag(): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("O_NOFOLLOW is unavailable; refusing an unsafe run artifact write");
  }
  return noFollow;
}

export function directoryFlag(): number {
  const directory = fsConstants.O_DIRECTORY;
  if (process.platform !== "linux" || typeof directory !== "number" || directory === 0) {
    throw new Error("anchored /proc directory traversal is unavailable; refusing an unsafe run artifact write");
  }
  return directory;
}

export const procFdChild = (fd: number, child: string): string => `/proc/self/fd/${fd}/${child}`;

function assertLeafName(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`anchored directory entry must be one safe leaf name: ${JSON.stringify(name)}`);
  }
}

/** List one retained directory descriptor without resolving its path again. */
export function listDirectoryNamesNoFollow(directoryFd: number): readonly string[] {
  return Object.freeze(readdirSync(`/proc/self/fd/${directoryFd}`).sort());
}

/** Open one child directory relative to a retained directory descriptor. */
export function openChildDirectoryNoFollow(directoryFd: number, name: string): number {
  assertLeafName(name);
  return openSync(procFdChild(directoryFd, name), fsConstants.O_RDONLY | directoryFlag() | noFollowFlag());
}

/** Read one leaf relative to a retained directory descriptor with O_NOFOLLOW. */
export function readDirectoryFileNoFollow(directoryFd: number, name: string): Buffer {
  assertLeafName(name);
  let fileFd: number | null = null;
  try {
    fileFd = openSync(procFdChild(directoryFd, name), fsConstants.O_RDONLY | noFollowFlag());
    return readFileSync(fileFd);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
  }
}

/** Exclusively publish one leaf relative to a retained directory descriptor. */
export function writeDirectoryFileExclusiveNoFollow(
  directoryFd: number,
  name: string,
  data: string | Uint8Array,
): void {
  assertLeafName(name);
  let fileFd: number | null = null;
  try {
    fileFd = openSync(
      procFdChild(directoryFd, name),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    writeFileSync(fileFd, data);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
  }
}

const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

function processIsAlive(rawOwner: string): boolean {
  const pid = Number(rawOwner.trim().split(":", 1)[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Does `name` exist as a directory entry under `directoryFd`, without following
 * a symlink? ENOENT is the ONE absent answer; every other errno is rethrown, so
 * an unreadable entry never reads as a missing one.
 */
function directoryEntryExistsNoFollow(directoryFd: number, name: string): boolean {
  try {
    readDirectoryFileNoFollow(directoryFd, name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Recover one stale descriptor-relative lock without ever removing a lock that
 * may still have a live owner. The owner is inspected while the canonical lock
 * name remains occupied; only a proven-dead owner may be moved aside. The
 * tombstone is then re-read to close the release/reacquire race between the
 * first observation and the rename.
 *
 * Stale recovery is serialized by a second exclusive name. Every normal
 * acquirer checks that guard both before and after publishing its owner token,
 * so a contender created just as recovery begins withdraws before entering its
 * critical section. While the guard is held, no new owner can become live and
 * the canonical stale inode cannot be replaced between observation and rename.
 */
export function recoverStaleDirectoryLock(
  directoryFd: number,
  lockName: string,
  afterTombstoned: (tombName: string) => void = () => undefined,
): boolean {
  const recoveryName = `${lockName}.recovery`;
  const recoveryToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
  try {
    writeDirectoryFileExclusiveNoFollow(directoryFd, recoveryName, recoveryToken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  try {
    let observedOwner: string;
    try {
      observedOwner = readDirectoryFileNoFollow(directoryFd, lockName).toString("utf-8");
    } catch (error) {
      // A vanished lock is the one expected race — recovery stands down. Any
      // other read failure (EACCES/EPERM, ELOOP, ENOTDIR, EIO, corruption) is
      // an attack or damage an operator must see, not contention.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(
        `cannot inspect lock ${lockName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (processIsAlive(observedOwner)) return false;

    const tomb = `${lockName}.tomb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(procFdChild(directoryFd, lockName), procFdChild(directoryFd, tomb));
      afterTombstoned(tomb);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(
        `cannot tombstone stale lock ${lockName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let tombOwner: string | null = null;
    try {
      tombOwner = readDirectoryFileNoFollow(directoryFd, tomb).toString("utf-8");
    } catch (error) {
      // Absent tombstone is the expected race (restore below). Anything else
      // (EACCES/EPERM, EIO, ELOOP, ENOTDIR, corrupt contents) is damage an
      // operator must see, not quiet contention.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") tombOwner = null;
      else {
        throw new Error(
          `cannot verify tombstoned lock ${tomb}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (tombOwner !== observedOwner || tombOwner === null || processIsAlive(tombOwner)) {
      try {
        renameSync(procFdChild(directoryFd, tomb), procFdChild(directoryFd, lockName));
      } catch (error) {
        // The recovery guard prevents a new legitimate owner from occupying
        // the canonical name. Failure here is therefore corruption; surface it
        // with the lock name instead of reporting mere contention.
        throw new Error(
          `cannot restore lock ${lockName} after failed tombstone verification: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
    unlinkSync(procFdChild(directoryFd, tomb));
    return true;
  } finally {
    try {
      if (readDirectoryFileNoFollow(directoryFd, recoveryName).toString("utf-8") === recoveryToken) {
        unlinkSync(procFdChild(directoryFd, recoveryName));
      }
    } catch {
      // A missing/foreign recovery guard is never ours to remove.
    }
  }
}

async function acquireDirectoryLock(directoryFd: number, lockName: string): Promise<string> {
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
  const recoveryName = `${lockName}.recovery`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (directoryEntryExistsNoFollow(directoryFd, recoveryName)) {
      await wait(LOCK_RETRY_MS);
      continue;
    }
    try {
      writeDirectoryFileExclusiveNoFollow(directoryFd, lockName, ownerToken);
      // Recovery may have claimed its guard between the pre-check and our
      // exclusive create. Withdraw this exact token before entering; the
      // recovery owner will either reclaim the prior stale file or stand down.
      if (directoryEntryExistsNoFollow(directoryFd, recoveryName)) {
        releaseDirectoryLock(directoryFd, lockName, ownerToken);
        await wait(LOCK_RETRY_MS);
        continue;
      }
      return ownerToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (recoverStaleDirectoryLock(directoryFd, lockName)) continue;
      await wait(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Could not acquire anchored lock after ${LOCK_ATTEMPTS} attempts: ${lockName}`);
}

function releaseDirectoryLock(directoryFd: number, lockName: string, ownerToken: string): void {
  try {
    if (readDirectoryFileNoFollow(directoryFd, lockName).toString("utf-8").trim() !== ownerToken) return;
    unlinkSync(procFdChild(directoryFd, lockName));
  } catch (error) {
    // ENOENT is the ONLY benign outcome: the lock is already gone, so this
    // process no longer owns it and there is nothing to release. Every other
    // code (EACCES, EIO, EPERM) means the unlink genuinely failed and the lock
    // file is STILL THERE — stranded until a stale-lock recovery notices it,
    // with every waiter blocked in the meantime. Swallowing them all made that
    // outcome indistinguishable from a clean release; the sibling catches in
    // this module already discriminate, and now so does this one.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    process.stderr.write(
      `loom: could not release anchored lock ${lockName}: ` +
      `${error instanceof Error ? error.message : String(error)} — the lock file remains and ` +
      `blocks other holders until stale-lock recovery reclaims it\n`,
    );
  }
}

/**
 * Hold a lock and its target directory through one retained descriptor. A path
 * swap after acquisition cannot redirect either the lock or callback I/O.
 */
export async function withAnchoredDirectoryLock<T>(
  directory: string,
  lockName: string,
  operation: (directoryFd: number) => T | Promise<T>,
): Promise<T> {
  assertLeafName(lockName);
  const directoryFd = openDirectoryNoFollow(directory);
  try {
    const ownerToken = await acquireDirectoryLock(directoryFd, lockName);
    try {
      return await operation(directoryFd);
    } finally {
      releaseDirectoryLock(directoryFd, lockName, ownerToken);
    }
  } finally {
    closeSync(directoryFd);
  }
}

/**
 * Open every absolute directory component relative to the descriptor for its
 * parent. O_NOFOLLOW therefore protects every hop, not only the final file.
 */
export function openDirectoryNoFollow(path: string): number {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = openSync(root, fsConstants.O_RDONLY | directoryFlag() | noFollowFlag());
  try {
    const components = relative(root, absolute).split(sep).filter(Boolean);
    for (const component of components) {
      const next = openSync(
        procFdChild(current, component),
        fsConstants.O_RDONLY | directoryFlag() | noFollowFlag(),
      );
      closeSync(current);
      current = next;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

/** Create an absolute directory path without following any existing symlink. */
export function ensureDirectoryNoFollow(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const rootFd = openDirectoryNoFollow(root);
  try {
    ensureRelativeDirectoryNoFollow(rootFd, root, absolute);
  } finally {
    closeSync(rootFd);
  }
}

/**
 * Create a run subdirectory one anchored component at a time. mkdir and open
 * both resolve relative to a retained parent descriptor, closing the parent
 * replacement race that recursive path-string creation leaves open.
 */
export function ensureRelativeDirectoryNoFollow(rootFd: number, runDir: string, target: string): void {
  const fromRun = relative(resolve(runDir), resolve(target));
  if (fromRun === ".." || fromRun.startsWith(`..${sep}`) || isAbsolute(fromRun)) {
    throw new Error(`run subdirectory escapes run directory: ${target}`);
  }
  let current = rootFd;
  let ownsCurrent = false;
  try {
    for (const component of fromRun.split(sep).filter(Boolean)) {
      const child = procFdChild(current, component);
      try {
        mkdirSync(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const next = openSync(
        child,
        fsConstants.O_RDONLY | directoryFlag() | noFollowFlag(),
      );
      if (ownsCurrent) closeSync(current);
      current = next;
      ownsCurrent = true;
    }
  } finally {
    if (ownsCurrent) closeSync(current);
  }
}

function writeAnchoredRunFile(path: string, data: string | Uint8Array, exclusive: boolean): void {
  const parentFd = openDirectoryNoFollow(dirname(path));
  let fileFd: number | null = null;
  try {
    fileFd = openSync(
      procFdChild(parentFd, basename(path)),
      fsConstants.O_WRONLY | fsConstants.O_CREAT |
        (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC) | noFollowFlag(),
      0o600,
    );
    writeFileSync(fileFd, data);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
    closeSync(parentFd);
  }
}

export function writeRunFileNoFollow(path: string, data: string): void {
  writeAnchoredRunFile(path, data, false);
}

/** Claim one fresh authority artifact without following or replacing a leaf. */
export function writeRunFileExclusiveNoFollow(path: string, data: string): void {
  writeAnchoredRunFile(path, data, true);
}

/**
 * Write exact bytes. Raw harness transcripts and binary artifacts must survive
 * byte-for-byte, so they never pass through a string encoding on the way in.
 */
export function writeRunBytesNoFollow(path: string, bytes: Uint8Array): void {
  writeAnchoredRunFile(path, bytes, false);
}

/** Claim one fresh immutable byte artifact without following or replacing a leaf. */
export function writeRunBytesExclusiveNoFollow(path: string, bytes: Uint8Array): void {
  writeAnchoredRunFile(path, bytes, true);
}

/** Read one run artifact through descriptors for every path hop. */
export function readRunFileNoFollow(path: string): string {
  return readAnchoredRunFile(path).toString("utf-8");
}

/** Read exact bytes back, without any encoding round trip. */
export function readRunBytesNoFollow(path: string): Buffer {
  return readAnchoredRunFile(path);
}

function readAnchoredRunFile(path: string): Buffer {
  const parentFd = openDirectoryNoFollow(dirname(path));
  let fileFd: number | null = null;
  try {
    fileFd = openSync(procFdChild(parentFd, basename(path)), fsConstants.O_RDONLY | noFollowFlag());
    return readFileSync(fileFd);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
    closeSync(parentFd);
  }
}

/** Remove a run artifact from its retained parent directory without following it. */
export function removeRunFileNoFollow(path: string): void {
  const parentFd = openDirectoryNoFollow(dirname(path));
  try {
    unlinkSync(procFdChild(parentFd, basename(path)));
  } finally {
    closeSync(parentFd);
  }
}

/**
 * Publish staged bytes through one retained parent descriptor. Both names are
 * resolved inside that directory even if an ancestor is replaced concurrently.
 */
export function publishStagedRunFile(stagedPath: string, finalPath: string): void {
  if (resolve(dirname(stagedPath)) !== resolve(dirname(finalPath))) {
    throw new Error("staged and final run artifacts must share one run directory");
  }
  const parentFd = openDirectoryNoFollow(dirname(stagedPath));
  try {
    renameSync(
      procFdChild(parentFd, basename(stagedPath)),
      procFdChild(parentFd, basename(finalPath)),
    );
  } finally {
    closeSync(parentFd);
  }
}
