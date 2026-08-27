/**
 * Anchored filesystem primitives shared by every run directory.
 *
 * Every path below a run's base directory must be refused if ANY component of
 * it is a symlink. Linux is the sole supported runtime because Node exposes no
 * portable `openat`/`mkdirat`/`renameat`/`unlinkat` API and `/proc/self/fd`
 * provides the required descriptor-relative authority only on Linux.
 *
 * Each absolute path is opened one component at a time relative to the
 * descriptor for its parent. `O_NOFOLLOW` protects every hop, and validation
 * and use share one retained descriptor. A component swapped after validation
 * therefore cannot redirect a later read or pathname mutation.
 *
 * The run's BASE directory is trusted configuration: see
 * `ensureResolvedBaseDirectory`, which resolves it once so that everything
 * below it can be held to the strict no-symlink rule.
 *
 * These live in the orchestration layer because both the panel helpers and the
 * anchored `RunDirHandle` need them; the handle is the consolidation point the
 * plan calls for, and the handlers import them back from here.
 */

import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

/** A directory held open as the capability for every child operation. */
export type AnchoredDirectory = Readonly<{ anchor: "descriptor"; fd: number }>;

export function assertAnchoredFilesystemPlatformSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux") {
    throw new Error(
      `Loom orchestration requires Linux descriptor-relative filesystem operations; platform ${platform} is unsupported`,
    );
  }
}

export function noFollowFlag(): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("O_NOFOLLOW is unavailable; refusing an unsafe run artifact write");
  }
  return noFollow;
}

export function directoryFlag(): number {
  assertAnchoredFilesystemPlatformSupported();
  const directory = fsConstants.O_DIRECTORY;
  if (typeof directory !== "number" || directory === 0) {
    throw new Error(
      `anchored directory traversal is unavailable on ${process.platform}; refusing an unsafe run artifact write`,
    );
  }
  return directory;
}

/** Open one leaf under an anchor, following no component of its path. */
const leafFlags = (extra: number): number => extra | noFollowFlag();

/** Open one directory under an anchor, following no component of its path. */
const dirFlags = (): number => fsConstants.O_RDONLY | directoryFlag() | noFollowFlag();

/**
 * The path that names `child` through the retained descriptor, so an ancestor
 * swapped after the anchor was opened cannot redirect it.
 */
export function anchoredChildPath(directory: AnchoredDirectory, child: string): string {
  return `/proc/self/fd/${directory.fd}/${child}`;
}

/** Release a directory anchor. The descriptor is the only owned resource. */
export function closeAnchoredDirectory(directory: AnchoredDirectory): void {
  closeSync(directory.fd);
}

const anchorFor = (fd: number): AnchoredDirectory =>
  Object.freeze({ anchor: "descriptor" as const, fd });

/**
 * Resolve a configured BASE directory to its real path, creating it if absent.
 *
 * The base is the one place an operator-configured symlink is legitimate
 * rather than hostile. Resolving it once moves that tolerance to a single
 * documented point; every path below the result follows the strict rule.
 *
 * The configured base is trusted and realpath-canonicalized;
 * the strict no-symlink invariant starts below that resolved boundary.
 */
export function ensureResolvedBaseDirectory(path: string): string {
  assertAnchoredFilesystemPlatformSupported();
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const real = realpathSync.native(absolute);
  if (!lstatSync(real).isDirectory()) {
    throw new Error(`run base directory is not a directory: ${real}`);
  }
  return real;
}

function assertLeafName(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`anchored directory entry must be one safe leaf name: ${JSON.stringify(name)}`);
  }
}

/**
 * List one anchored directory through the retained descriptor without
 * resolving its original path again.
 */
export function listDirectoryNamesNoFollow(directory: AnchoredDirectory): readonly string[] {
  return Object.freeze(readdirSync(`/proc/self/fd/${directory.fd}`).sort());
}

/** Open one child directory relative to an anchored directory. */
export function openChildDirectoryNoFollow(directory: AnchoredDirectory, name: string): AnchoredDirectory {
  assertLeafName(name);
  const childPath = anchoredChildPath(directory, name);
  return anchorFor(openSync(childPath, dirFlags()));
}

/** Read one leaf relative to an anchored directory, following no component. */
export function readDirectoryFileNoFollow(directory: AnchoredDirectory, name: string): Buffer {
  assertLeafName(name);
  let fileFd: number | null = null;
  try {
    fileFd = openSync(anchoredChildPath(directory, name), leafFlags(fsConstants.O_RDONLY));
    return readFileSync(fileFd);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
  }
}

/** Exclusively publish one leaf relative to an anchored directory. */
export function writeDirectoryFileExclusiveNoFollow(
  directory: AnchoredDirectory,
  name: string,
  data: string | Uint8Array,
): void {
  assertLeafName(name);
  let fileFd: number | null = null;
  try {
    fileFd = openSync(
      anchoredChildPath(directory, name),
      leafFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    writeFileSync(fileFd, data);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
  }
}

/** Atomically replace one leaf through an exclusively-created no-follow temp. */
export function writeDirectoryFileAtomicNoFollow(
  directory: AnchoredDirectory,
  name: string,
  data: string | Uint8Array,
): void {
  assertLeafName(name);
  const temporary = `${name}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  assertLeafName(temporary);
  let published = false;
  let primaryError: unknown = null;
  try {
    writeDirectoryFileExclusiveNoFollow(directory, temporary, data);
    renameSync(anchoredChildPath(directory, temporary), anchoredChildPath(directory, name));
    published = true;
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown = null;
  if (!published) {
    try {
      unlinkSync(anchoredChildPath(directory, temporary));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupError = error;
    }
  }
  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `atomic write of ${name} and temporary-file cleanup both failed`,
    );
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
}

/** Remove one anchored leaf; ENOENT is the only idempotent absence. */
export function removeDirectoryFileNoFollow(directory: AnchoredDirectory, name: string): void {
  assertLeafName(name);
  try {
    unlinkSync(anchoredChildPath(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

type LockOwner = Readonly<{ pid: number }>;

function parseLockOwner(rawOwner: string, lockName: string): LockOwner {
  if (!/^[1-9]\d*(?::\d+:[a-z0-9]+)?$/u.test(rawOwner)) {
    throw new Error(`lock ${lockName} has malformed owner token: ${JSON.stringify(rawOwner)}`);
  }
  const pid = Number(rawOwner.split(":", 1)[0]);
  if (!Number.isSafeInteger(pid)) {
    throw new Error(`lock ${lockName} has malformed owner token: ${JSON.stringify(rawOwner)}`);
  }
  return Object.freeze({ pid });
}

function processIsAlive(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Does `name` exist as a directory entry under `directory`, without following
 * a symlink? ENOENT is the ONE absent answer; every other errno is rethrown, so
 * an unreadable entry never reads as a missing one.
 */
function directoryEntryExistsNoFollow(directory: AnchoredDirectory, name: string): boolean {
  try {
    readDirectoryFileNoFollow(directory, name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeOwnedRecoveryGuard(
  directory: AnchoredDirectory,
  recoveryName: string,
  recoveryToken: string,
): void {
  let observed: string;
  try {
    observed = readDirectoryFileNoFollow(directory, recoveryName).toString("utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `cannot inspect recovery guard ${recoveryName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (observed !== recoveryToken) return;
  try {
    unlinkSync(anchoredChildPath(directory, recoveryName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `cannot remove recovery guard ${recoveryName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
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
  directory: AnchoredDirectory,
  lockName: string,
  afterTombstoned: (tombName: string) => void = () => undefined,
): boolean {
  const recoveryName = `${lockName}.recovery`;
  const recoveryToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
  try {
    writeDirectoryFileExclusiveNoFollow(directory, recoveryName, recoveryToken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  let primaryFailed = false;
  let primaryError: unknown;
  try {
    let observedOwner: string;
    try {
      observedOwner = readDirectoryFileNoFollow(directory, lockName).toString("utf-8");
    } catch (error) {
      // A vanished lock is the one expected race — recovery stands down. Any
      // other read failure (EACCES/EPERM, ELOOP, ENOTDIR, EIO, corruption) is
      // an attack or damage an operator must see, not contention.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(
        `cannot inspect lock ${lockName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (processIsAlive(parseLockOwner(observedOwner, lockName))) return false;

    const tomb = `${lockName}.tomb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      renameSync(anchoredChildPath(directory, lockName), anchoredChildPath(directory, tomb));
      afterTombstoned(tomb);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error(
        `cannot tombstone stale lock ${lockName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let tombOwner: string | null = null;
    try {
      tombOwner = readDirectoryFileNoFollow(directory, tomb).toString("utf-8");
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
    if (tombOwner !== observedOwner || tombOwner === null ||
        processIsAlive(parseLockOwner(tombOwner, tomb))) {
      try {
        renameSync(anchoredChildPath(directory, tomb), anchoredChildPath(directory, lockName));
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
    unlinkSync(anchoredChildPath(directory, tomb));
    return true;
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      removeOwnedRecoveryGuard(directory, recoveryName, recoveryToken);
    } catch (cleanupError) {
      if (primaryFailed) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `stale lock recovery for ${lockName} failed and its recovery guard could not be cleaned up`,
        );
      }
      throw cleanupError;
    }
  }
}

async function acquireDirectoryLock(directory: AnchoredDirectory, lockName: string): Promise<string> {
  const ownerToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 12)}`;
  const recoveryName = `${lockName}.recovery`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (directoryEntryExistsNoFollow(directory, recoveryName)) {
      await wait(LOCK_RETRY_MS);
      continue;
    }
    try {
      writeDirectoryFileExclusiveNoFollow(directory, lockName, ownerToken);
      // Recovery may have claimed its guard between the pre-check and our
      // exclusive create. Withdraw this exact token before entering; the
      // recovery owner will either reclaim the prior stale file or stand down.
      if (directoryEntryExistsNoFollow(directory, recoveryName)) {
        releaseDirectoryLock(directory, lockName, ownerToken);
        await wait(LOCK_RETRY_MS);
        continue;
      }
      return ownerToken;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (recoverStaleDirectoryLock(directory, lockName)) continue;
      await wait(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Could not acquire anchored lock after ${LOCK_ATTEMPTS} attempts: ${lockName}`);
}

function releaseDirectoryLock(directory: AnchoredDirectory, lockName: string, ownerToken: string): void {
  try {
    const observed = readDirectoryFileNoFollow(directory, lockName).toString("utf-8");
    if (observed !== ownerToken) {
      throw new Error(`anchored lock ${lockName} ownership lost: expected ${ownerToken}, found ${observed}`);
    }
    unlinkSync(anchoredChildPath(directory, lockName));
  } catch (error) {
    throw new Error(
      `cannot release anchored lock ${lockName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Hold a lock and its target directory through one retained descriptor.
 *
 * The retained descriptor is the anchor, so no path swap after acquisition
 * can redirect either the lock or the callback's I/O.
 */
export async function withAnchoredDirectoryLock<T>(
  directory: string,
  lockName: string,
  operation: (directory: AnchoredDirectory) => T | Promise<T>,
): Promise<T> {
  assertLeafName(lockName);
  const anchored = openDirectoryNoFollow(directory);
  try {
    const ownerToken = await acquireDirectoryLock(anchored, lockName);
    let operationFailed = false;
    let operationError: unknown;
    try {
      return await operation(anchored);
    } catch (error) {
      operationFailed = true;
      operationError = error;
      throw error;
    } finally {
      try {
        releaseDirectoryLock(anchored, lockName, ownerToken);
      } catch (releaseError) {
        if (operationFailed) {
          throw new AggregateError(
            [operationError, releaseError],
            `anchored operation failed and lock ${lockName} could not be released`,
          );
        }
        throw releaseError;
      }
    }
  } finally {
    closeAnchoredDirectory(anchored);
  }
}

/**
 * Anchor an absolute directory path, refusing it if any component is a symlink.
 *
 * Every component is opened relative to the descriptor for its parent, so
 * `O_NOFOLLOW` protects every hop and the returned descriptor is the authority.
 */
export function openDirectoryNoFollow(path: string): AnchoredDirectory {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = openSync(root, dirFlags());
  try {
    const components = relative(root, absolute).split(sep).filter(Boolean);
    for (const component of components) {
      const next = openSync(`/proc/self/fd/${current}/${component}`, dirFlags());
      closeSync(current);
      current = next;
    }
    return anchorFor(current);
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

/** Create an absolute directory path without following any existing symlink. */
export function ensureDirectoryNoFollow(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const rootDirectory = openDirectoryNoFollow(root);
  try {
    ensureRelativeDirectoryNoFollow(rootDirectory, root, absolute);
  } finally {
    closeAnchoredDirectory(rootDirectory);
  }
}

/**
 * Create a run subdirectory one anchored component at a time.
 *
 * `mkdirSync(path, { recursive: true })` hands the whole path to the kernel
 * with ordinary symlink-following semantics, so a swapped component would have
 * directories created at the link's TARGET. Walking one component at a time
 * refuses that instead: on Linux both mkdir and open resolve relative to a
 * retained parent descriptor, so a symlinked or swapped ancestor cannot
 * redirect the next component creation.
 */
export function ensureRelativeDirectoryNoFollow(
  rootDirectory: AnchoredDirectory,
  runDir: string,
  target: string,
): void {
  const fromRun = relative(resolve(runDir), resolve(target));
  if (fromRun === ".." || fromRun.startsWith(`..${sep}`) || isAbsolute(fromRun)) {
    throw new Error(`run subdirectory escapes run directory: ${target}`);
  }
  const components = fromRun.split(sep).filter(Boolean);
  if (components.length === 0) return;
  let current: AnchoredDirectory = rootDirectory;
  let ownsCurrent = false;
  try {
    for (const component of components) {
      const child = anchoredChildPath(current, component);
      try {
        mkdirSync(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const next = anchorFor(openSync(child, dirFlags()));
      if (ownsCurrent) closeAnchoredDirectory(current);
      current = next;
      ownsCurrent = true;
    }
  } finally {
    if (ownsCurrent) closeAnchoredDirectory(current);
  }
}

function writeAnchoredRunFile(path: string, data: string | Uint8Array, exclusive: boolean): void {
  const parent = openDirectoryNoFollow(dirname(path));
  let fileFd: number | null = null;
  try {
    fileFd = openSync(
      anchoredChildPath(parent, basename(path)),
      leafFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT |
        (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC)),
      0o600,
    );
    writeFileSync(fileFd, data);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
    closeAnchoredDirectory(parent);
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
 * Claim one fresh immutable byte artifact without following or replacing a leaf.
 *
 * Raw harness transcripts and binary artifacts must survive byte-for-byte, so
 * they never pass through a string encoding on the way in.
 */
export function writeRunBytesExclusiveNoFollow(path: string, bytes: Uint8Array): void {
  writeAnchoredRunFile(path, bytes, true);
}

/** Read one run artifact with no component of its path followed. */
export function readRunFileNoFollow(path: string): string {
  return readAnchoredRunFile(path).toString("utf-8");
}

/** Read exact bytes back, without any encoding round trip. */
export function readRunBytesNoFollow(path: string): Buffer {
  return readAnchoredRunFile(path);
}

function readAnchoredRunFile(path: string): Buffer {
  const parent = openDirectoryNoFollow(dirname(path));
  let fileFd: number | null = null;
  try {
    fileFd = openSync(anchoredChildPath(parent, basename(path)), leafFlags(fsConstants.O_RDONLY));
    return readFileSync(fileFd);
  } finally {
    if (fileFd !== null) closeSync(fileFd);
    closeAnchoredDirectory(parent);
  }
}

/**
 * Remove a run artifact relative to its retained parent descriptor.
 *
 * Darwin's anchor retains a verified textual path because Node exposes no
 * `unlinkat`. Reusing that path would reopen an ancestor-swap race between the
 * verified open and `unlinkSync`, so removal fails closed there until a native
 * descriptor-relative boundary is available. Linux names the leaf through the
 * retained descriptor; `unlink` removes a planted leaf symlink, never its
 * target.
 */
export function removeRunFileNoFollow(path: string): void {
  const parent = openDirectoryNoFollow(dirname(path));
  try {
    unlinkSync(anchoredChildPath(parent, basename(path)));
  } finally {
    closeAnchoredDirectory(parent);
  }
}

/**
 * Publish staged bytes through one anchored parent directory. Both names are
 * resolved inside that directory, so neither can be redirected out of the run.
 */
export function publishStagedRunFile(stagedPath: string, finalPath: string): void {
  if (resolve(dirname(stagedPath)) !== resolve(dirname(finalPath))) {
    throw new Error("staged and final run artifacts must share one run directory");
  }
  const parent = openDirectoryNoFollow(dirname(stagedPath));
  try {
    renameSync(
      anchoredChildPath(parent, basename(stagedPath)),
      anchoredChildPath(parent, basename(finalPath)),
    );
  } finally {
    closeAnchoredDirectory(parent);
  }
}
