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

function processIsAlive(rawPid: string): boolean {
  const pid = Number(rawPid.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Atomically move and inspect one stale descriptor-relative lock. */
function stealStaleDirectoryLock(directoryFd: number, lockName: string): boolean {
  const tomb = `${lockName}.tomb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(procFdChild(directoryFd, lockName), procFdChild(directoryFd, tomb));
  } catch {
    return false;
  }

  let live = true;
  try {
    live = processIsAlive(readDirectoryFileNoFollow(directoryFd, tomb).toString("utf-8"));
  } catch {
    live = true;
  }
  if (live) {
    try {
      renameSync(procFdChild(directoryFd, tomb), procFdChild(directoryFd, lockName));
    } catch {
      try { unlinkSync(procFdChild(directoryFd, tomb)); } catch { /* already gone */ }
    }
    return false;
  }
  unlinkSync(procFdChild(directoryFd, tomb));
  return true;
}

async function acquireDirectoryLock(directoryFd: number, lockName: string): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      writeDirectoryFileExclusiveNoFollow(directoryFd, lockName, `${process.pid}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && stealStaleDirectoryLock(directoryFd, lockName)) continue;
      await wait(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Could not acquire anchored lock after ${LOCK_ATTEMPTS} attempts: ${lockName}`);
}

function releaseDirectoryLock(directoryFd: number, lockName: string): void {
  try {
    if (readDirectoryFileNoFollow(directoryFd, lockName).toString("utf-8").trim() !== `${process.pid}`) return;
    unlinkSync(procFdChild(directoryFd, lockName));
  } catch {
    // Missing/foreign lock: this process no longer owns it.
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
    await acquireDirectoryLock(directoryFd, lockName);
    try {
      return await operation(directoryFd);
    } finally {
      releaseDirectoryLock(directoryFd, lockName);
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
