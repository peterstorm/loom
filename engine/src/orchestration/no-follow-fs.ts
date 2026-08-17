/**
 * Anchored filesystem primitives shared by every run directory.
 *
 * Every path below a run's base directory must be refused if ANY component of
 * it is a symlink — that is the attack these primitives exist to stop, and it
 * is enforced identically on both supported platforms. How the kernel is asked
 * for that guarantee differs, because the two systems expose different tools:
 *
 * - **Linux — anchored to a descriptor.** Each absolute path is opened one
 *   component at a time relative to the descriptor for its parent, addressed
 *   through `/proc/self/fd/<fd>/<child>`, so `O_NOFOLLOW` protects every hop
 *   rather than only the final leaf AND validation and use share one
 *   descriptor. That shared descriptor is what closes the lstat-before-write
 *   race: a component swapped after validation cannot be reached through the
 *   descriptor already held.
 *
 * - **macOS — anchored to a real path.** Darwin has no usable fd→path bridge:
 *   `/dev/fd/<fd>` is an `fdesc` node, not a directory, so `open`, `readdir`,
 *   `mkdir`, and `rename` through `/dev/fd/<fd>/<child>` all fail (ENOTDIR /
 *   ENOENT), and Node exposes no `openat`. Instead every operation carries
 *   Darwin's `O_NOFOLLOW_ANY`, which makes the KERNEL reject the open with
 *   ELOOP if any component of the path is a symlink, evaluated over the whole
 *   path in a single resolution. That is atomic — strictly better than an
 *   lstat-per-component walk, which races between its own checks.
 *
 * The one guarantee darwin cannot reproduce is binding validation and use to a
 * single descriptor: an ancestor directory replaced by another REAL directory
 * between two operations is not detected, because closing that window needs
 * `openat`. Symlink escapes — the modelled attack — are refused on both.
 *
 * Both platforms treat the run's BASE directory as trusted configuration: see
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
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/**
 * Darwin's `O_NOFOLLOW_ANY` (`sys/fcntl.h`): refuse the open with ELOOP if any
 * component of the path is a symlink, not merely the last one. Node does not
 * surface it in `fs.constants`, so the platform value is named here.
 */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

/**
 * A directory held open for anchored access, carrying whatever the platform
 * needs to address its children. Linux addresses them through the retained
 * descriptor; darwin has no such bridge and must re-state the real path, which
 * `openDirectoryNoFollow` has already proven symlink-free.
 */
export type AnchoredDirectory =
  | Readonly<{ anchor: "descriptor"; fd: number }>
  | Readonly<{ anchor: "real-path"; fd: number; path: string }>;

export function noFollowFlag(): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("O_NOFOLLOW is unavailable; refusing an unsafe run artifact write");
  }
  return noFollow;
}

/**
 * The no-follow mask for one anchored open.
 *
 * On darwin this is `O_NOFOLLOW_ANY` INSTEAD of `O_NOFOLLOW`, never both: the
 * kernel rejects the pair with EINVAL, and it does not need them — the "any"
 * form already covers the final component as well as every ancestor. On Linux
 * `O_NOFOLLOW` is the whole story, because descriptor anchoring gives each hop
 * its own open and therefore its own leaf check.
 */
function noFollowMask(): number {
  return process.platform === "darwin" ? DARWIN_O_NOFOLLOW_ANY : noFollowFlag();
}

export function directoryFlag(): number {
  const directory = fsConstants.O_DIRECTORY;
  if (
    (process.platform !== "linux" && process.platform !== "darwin") ||
    typeof directory !== "number" || directory === 0
  ) {
    throw new Error(
      `anchored directory traversal is unavailable on ${process.platform}; refusing an unsafe run artifact write`,
    );
  }
  return directory;
}

/** Open one leaf under an anchor, following no component of its path. */
const leafFlags = (extra: number): number => extra | noFollowMask();

/** Open one directory under an anchor, following no component of its path. */
const dirFlags = (): number => fsConstants.O_RDONLY | directoryFlag() | noFollowMask();

/**
 * The path that names `child` inside an already-anchored directory. On Linux
 * this routes through the retained descriptor, so an ancestor swapped after
 * the anchor was opened cannot redirect it. On darwin it re-states the
 * proven-real directory path, and every open through it carries
 * `O_NOFOLLOW_ANY` so a planted symlink is still refused by the kernel.
 */
export function anchoredChildPath(directory: AnchoredDirectory, child: string): string {
  return directory.anchor === "descriptor"
    ? `/proc/self/fd/${directory.fd}/${child}`
    : join(directory.path, child);
}

/** Release a directory anchor. The descriptor is the only owned resource. */
export function closeAnchoredDirectory(directory: AnchoredDirectory): void {
  closeSync(directory.fd);
}

const anchorFor = (fd: number, path: string): AnchoredDirectory =>
  process.platform === "darwin"
    ? Object.freeze({ anchor: "real-path" as const, fd, path })
    : Object.freeze({ anchor: "descriptor" as const, fd });

/**
 * Resolve a configured BASE directory to its real path, creating it if absent.
 *
 * The base is the one place a symlink is legitimate rather than hostile: on
 * macOS `/tmp` and `/var` are system symlinks (`/tmp` → `/private/tmp`), so a
 * strict no-symlink rule applied from the filesystem root would refuse every
 * real run directory. Resolving the base once moves that tolerance to a single
 * documented point — after this returns, every path built under the result can
 * be, and is, held to the strict rule.
 *
 * On Linux this is an identity: a base containing a symlink is already refused
 * by the anchored walk today, so any base that works keeps working unchanged.
 */
export function ensureResolvedBaseDirectory(path: string): string {
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
 * List one anchored directory without resolving its path again. Linux reads
 * the retained descriptor through `/proc/self/fd`; darwin has no such node, so
 * it reads the proven-real path — whose own components were checked when the
 * anchor was opened.
 */
export function listDirectoryNamesNoFollow(directory: AnchoredDirectory): readonly string[] {
  const path = directory.anchor === "descriptor"
    ? `/proc/self/fd/${directory.fd}`
    : directory.path;
  return Object.freeze(readdirSync(path).sort());
}

/** Open one child directory relative to an anchored directory. */
export function openChildDirectoryNoFollow(directory: AnchoredDirectory, name: string): AnchoredDirectory {
  assertLeafName(name);
  const childPath = anchoredChildPath(directory, name);
  return anchorFor(openSync(childPath, dirFlags()), childPath);
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
    if (processIsAlive(observedOwner)) return false;

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
    if (tombOwner !== observedOwner || tombOwner === null || processIsAlive(tombOwner)) {
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
  } finally {
    try {
      if (readDirectoryFileNoFollow(directory, recoveryName).toString("utf-8") === recoveryToken) {
        unlinkSync(anchoredChildPath(directory, recoveryName));
      }
    } catch {
      // A missing/foreign recovery guard is never ours to remove.
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
    if (readDirectoryFileNoFollow(directory, lockName).toString("utf-8").trim() !== ownerToken) return;
    unlinkSync(anchoredChildPath(directory, lockName));
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
  operation: (directory: AnchoredDirectory) => T | Promise<T>,
): Promise<T> {
  assertLeafName(lockName);
  const anchored = openDirectoryNoFollow(directory);
  try {
    const ownerToken = await acquireDirectoryLock(anchored, lockName);
    try {
      return await operation(anchored);
    } finally {
      releaseDirectoryLock(anchored, lockName, ownerToken);
    }
  } finally {
    closeAnchoredDirectory(anchored);
  }
}

/**
 * Anchor an absolute directory path, refusing it if any component is a symlink.
 *
 * Linux opens every component relative to the descriptor for its parent, so
 * `O_NOFOLLOW` protects every hop and the returned descriptor IS the
 * validation. Darwin cannot walk descriptors, so it asks the kernel for the
 * same guarantee in one resolution via `O_NOFOLLOW_ANY` — which is why the
 * returned real path is safe to address children through.
 */
export function openDirectoryNoFollow(path: string): AnchoredDirectory {
  const absolute = resolve(path);
  if (process.platform === "darwin") {
    return anchorFor(openSync(absolute, dirFlags()), absolute);
  }
  const root = parse(absolute).root;
  let current = openSync(root, dirFlags());
  try {
    const components = relative(root, absolute).split(sep).filter(Boolean);
    for (const component of components) {
      const next = openSync(`/proc/self/fd/${current}/${component}`, dirFlags());
      closeSync(current);
      current = next;
    }
    return anchorFor(current, absolute);
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
 * retained parent descriptor; on darwin each open re-checks the whole path
 * under `O_NOFOLLOW_ANY`, so a symlinked ancestor is caught before the next
 * component is created.
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
  let current = rootDirectory;
  let currentPath = resolve(runDir);
  let ownsCurrent = false;
  try {
    for (const component of fromRun.split(sep).filter(Boolean)) {
      const child = anchoredChildPath(current, component);
      try {
        mkdirSync(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      currentPath = join(currentPath, component);
      const next = anchorFor(openSync(child, dirFlags()), currentPath);
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
 * Remove a run artifact from its anchored parent directory without following
 * it. `unlink` never resolves the FINAL component, so a planted symlink loses
 * the link itself and never its target; the anchored parent is what keeps the
 * removal inside the run directory.
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
