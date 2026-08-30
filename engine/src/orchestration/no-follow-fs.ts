/**
 * Anchored filesystem primitives shared by every run directory.
 *
 * No open below a run's base directory may follow any symlink component.
 * Leaf symlinks may be safely removed or atomically replaced because those
 * pathname operations act on the link itself. The opening guarantee is
 * enforced on both supported platforms through different kernel facilities:
 *
 * - **Linux — anchored to a descriptor.** Each absolute path is opened one
 *   component at a time relative to the descriptor for its parent, addressed
 *   through `/proc/self/fd/<fd>/<child>`, so `O_NOFOLLOW` protects every hop
 *   AND validation and use share one retained descriptor. A component swapped
 *   after validation therefore cannot redirect a later read or pathname
 *   mutation.
 *
 * - **macOS — anchored to a real path.** Darwin has no usable fd→path bridge:
 *   `/dev/fd/<fd>` is an fdesc node, not a directory, and Node exposes no
 *   `openat`. Instead every open carries Darwin's `O_NOFOLLOW_ANY`, which makes
 *   the kernel reject the open with ELOOP if ANY component of the path is a
 *   symlink, evaluated over the whole path in one resolution. The one
 *   guarantee darwin cannot reproduce — binding validation and use to a single
 *   descriptor — is documented at the primitive.
 *
 * The run's BASE directory is trusted configuration: see
 * `ensureResolvedBaseDirectory`, which resolves it once so that everything
 * below it can be held to the strict no-symlink rule. On macOS `/tmp` and
 * `/var` are system symlinks, so a strict rule applied from the filesystem
 * root would refuse every real run directory.
 *
 * These live in the orchestration layer because both the panel helpers and the
 * anchored `RunDirHandle` need them; the handle is the consolidation point the
 * plan calls for, and the handlers import them back from here.
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const ANCHORED_DIRECTORY_CAPABILITY: unique symbol = Symbol("loom.anchored-directory");
const LIVE_ANCHORED_DIRECTORIES = new WeakSet<object>();
const REVOKED_ANCHORED_DIRECTORIES = new WeakSet<object>();

declare const anchoredFdBrand: unique symbol;
export type AnchoredDirectoryFd = number & { readonly [anchoredFdBrand]: "anchored-directory-fd" };

/**
 * A live, runtime-authenticated directory capability. Linux addresses children
 * through the retained descriptor; Darwin uses the proven-real path while
 * retaining the descriptor for identity and lifetime authority.
 */
export type AnchoredDirectory =
  | Readonly<{
      anchor: "descriptor";
      fd: AnchoredDirectoryFd;
      [ANCHORED_DIRECTORY_CAPABILITY]: true;
    }>
  | Readonly<{
      anchor: "real-path";
      fd: AnchoredDirectoryFd;
      path: string;
      [ANCHORED_DIRECTORY_CAPABILITY]: true;
    }>;

function assertAnchoredDirectory(directory: AnchoredDirectory): void {
  const candidate = directory as unknown as Record<PropertyKey, unknown>;
  const validAnchor = candidate.anchor === "descriptor" ||
    (candidate.anchor === "real-path" && typeof candidate.path === "string" && isAbsolute(candidate.path));
  if (!LIVE_ANCHORED_DIRECTORIES.has(directory) || REVOKED_ANCHORED_DIRECTORIES.has(directory) ||
      candidate[ANCHORED_DIRECTORY_CAPABILITY] !== true || !validAnchor ||
      typeof candidate.fd !== "number" || !Number.isSafeInteger(candidate.fd) || candidate.fd < 0) {
    throw new Error("anchored directory capability was not produced by the no-follow filesystem boundary");
  }
}

/** Stable identity used to reject a pathname that was rebound after capture. */
export type AnchoredDirectoryIdentity = Readonly<{ device: bigint; inode: bigint }>;

export function anchoredDirectoryIdentity(directory: AnchoredDirectory): AnchoredDirectoryIdentity {
  assertAnchoredDirectory(directory);
  const stat = fstatSync(directory.fd, { bigint: true });
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

export function anchoredDirectoryHasIdentity(
  directory: AnchoredDirectory,
  expected: AnchoredDirectoryIdentity,
): boolean {
  const observed = anchoredDirectoryIdentity(directory);
  return observed.device === expected.device && observed.inode === expected.inode;
}

export function assertAnchoredFilesystemPlatformSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(
      `Loom orchestration requires POSIX anchored-filesystem operations; platform ${platform} is unsupported`,
    );
  }
  if (platform === "darwin" && process.platform === "darwin") assertDarwinNoFollowAnyCapability();
}

/**
 * Darwin kernels first honored `O_NOFOLLOW_ANY` on macOS 13. An older kernel
 * either fails every flagged open (fail-closed breakage) or silently ignores
 * the unknown bit — which would open planted symlinks with NO protection and
 * defeat the guarantee this module exists to enforce. The one-time probe below
 * converts either unknown-kernel behavior into a fail-closed startup error: a
 * planted symlink chain must be refused with ELOOP, and nothing else counts as
 * proof.
 */
let darwinCapabilityVerified = false;
function assertDarwinNoFollowAnyCapability(): void {
  if (darwinCapabilityVerified) return;
  const probeDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-anchor-probe-")));
  try {
    symlinkSync(".", join(probeDir, "planted-link"));
    let refusedWithEloop = false;
    try {
      openSync(join(probeDir, "planted-link"), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | DARWIN_O_NOFOLLOW_ANY);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") refusedWithEloop = true;
      else {
        throw new Error(
          `darwin O_NOFOLLOW_ANY capability probe failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    if (!refusedWithEloop) {
      throw new Error(
        "darwin kernel did not refuse an anchored open through a symlink with ELOOP — " +
          "O_NOFOLLOW_ANY requires macOS 13 or newer; refusing unsafe anchored filesystem operations",
      );
    }
    darwinCapabilityVerified = true;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

function noFollowFlag(): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("O_NOFOLLOW is unavailable; refusing an unsafe run artifact write");
  }
  return noFollow;
}

/**
 * Darwin's `O_NOFOLLOW_ANY` (`sys/fcntl.h`): refuse the open with ELOOP if any
 * component of the path is a symlink, not merely the last one. Node does not
 * surface it in `fs.constants`, so the platform value is named here.
 */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

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

function directoryFlag(): number {
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
const leafFlags = (extra: number): number => extra | noFollowMask();

/** Open one directory under an anchor, following no component of its path. */
const dirFlags = (): number => fsConstants.O_RDONLY | directoryFlag() | noFollowMask();

/**
 * The path that addresses an anchored directory's children: the retained
 * descriptor on Linux, the proven-real path on darwin. One enforcement point
 * for the descriptor-versus-real-path addressing decision.
 */
function anchoredDirectoryPath(directory: AnchoredDirectory): string {
  return directory.anchor === "descriptor" ? `/proc/self/fd/${directory.fd}` : directory.path;
}

export function anchoredChildPath(directory: AnchoredDirectory, child: string): string {
  assertAnchoredDirectory(directory);
  assertLeafName(child);
  return join(anchoredDirectoryPath(directory), child);
}

/** Release a directory anchor. The descriptor is the only owned resource. */
function revokeAnchoredDirectory(directory: AnchoredDirectory): void {
  assertAnchoredDirectory(directory);
  REVOKED_ANCHORED_DIRECTORIES.add(directory);
  LIVE_ANCHORED_DIRECTORIES.delete(directory);
}

export function closeAnchoredDirectory(directory: AnchoredDirectory): void {
  revokeAnchoredDirectory(directory);
  closeSync(directory.fd);
}

const anchorFor = (fd: number, path: string): AnchoredDirectory => {
  const branded = fd as AnchoredDirectoryFd;
  const directory = process.platform === "darwin"
    ? {
        anchor: "real-path" as const,
        fd: branded,
        path,
        [ANCHORED_DIRECTORY_CAPABILITY]: true as const,
      }
    : {
        anchor: "descriptor" as const,
        fd: branded,
        [ANCHORED_DIRECTORY_CAPABILITY]: true as const,
      };
  Object.defineProperty(directory, ANCHORED_DIRECTORY_CAPABILITY, { enumerable: false });
  LIVE_ANCHORED_DIRECTORIES.add(directory);
  return Object.freeze(directory);
};

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
 * This canonicalization contract is platform-independent: a configured base
 * may itself contain symlinks and is returned as their real target. Strict
 * no-follow traversal begins below that resolved base.
 */
export function ensureResolvedBaseDirectory(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return resolveBaseDirectory(absolute);
}

/**
 * Resolve a configured BASE directory to its real path WITHOUT creating it.
 *
 * Snapshot and removal callers treat an absent base as the ONE documented
 * absent answer, so unlike `ensureResolvedBaseDirectory` this propagates
 * ENOENT instead of mkdir-ing the base into existence. Everything below the
 * resolved result is still held to the strict no-symlink rule.
 */
export function resolveBaseDirectory(path: string): string {
  const real = realpathSync.native(resolve(path));
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
 * List one anchored directory without resolving its original path again.
 * Linux reads the retained descriptor through `/proc/self/fd`; darwin has no
 * such node, so it reads the proven-real path — whose own components were
 * checked when the anchor was opened.
 */
export function listDirectoryNamesNoFollow(directory: AnchoredDirectory): readonly string[] {
  assertAnchoredDirectory(directory);
  return Object.freeze(readdirSync(anchoredDirectoryPath(directory)).sort());
}

/** Open one child directory relative to an anchored directory. */
export function openChildDirectoryNoFollow(directory: AnchoredDirectory, name: string): AnchoredDirectory {
  assertLeafName(name);
  const childPath = anchoredChildPath(directory, name);
  return anchorFor(openSync(childPath, dirFlags()), childPath);
}

function closeFileDescriptor(
  fileDescriptor: number | null,
  primaryError: unknown,
  operation: string,
): unknown {
  if (fileDescriptor === null) return primaryError;
  try {
    closeSync(fileDescriptor);
    return primaryError;
  } catch (closeError) {
    return primaryError === null
      ? closeError
      : new AggregateError([primaryError, closeError], `${operation} and descriptor close both failed`);
  }
}

/** Release an anchor without masking a primary failure or leaking its fd. */
export function closeAnchorGuarded(
  directory: AnchoredDirectory,
  primaryError: unknown,
  operation: string,
): unknown {
  revokeAnchoredDirectory(directory);
  return closeFileDescriptor(directory.fd, primaryError, `${operation} and directory close`);
}

/** Read one leaf relative to an anchored directory, following no component. */
export function readDirectoryFileNoFollow(directory: AnchoredDirectory, name: string): Buffer {
  assertLeafName(name);
  let fileFd: number | null = null;
  let bytes: Buffer | null = null;
  let primaryError: unknown = null;
  try {
    fileFd = openSync(anchoredChildPath(directory, name), leafFlags(fsConstants.O_RDONLY));
    bytes = readFileSync(fileFd);
  } catch (error) {
    primaryError = error;
  }
  primaryError = closeFileDescriptor(fileFd, primaryError, `read of ${name}`);
  if (primaryError !== null) throw primaryError;
  if (bytes === null) throw new Error(`read of ${name} produced no bytes`);
  return bytes;
}

/** Exclusively publish one leaf relative to an anchored directory. */
export function writeDirectoryFileExclusiveNoFollow(
  directory: AnchoredDirectory,
  name: string,
  data: string | Uint8Array,
): void {
  assertLeafName(name);
  let fileFd: number | null = null;
  let primaryError: unknown = null;
  try {
    fileFd = openSync(
      anchoredChildPath(directory, name),
      leafFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    writeFileSync(fileFd, data);
  } catch (error) {
    primaryError = error;
  }
  primaryError = closeFileDescriptor(fileFd, primaryError, `exclusive write of ${name}`);
  if (primaryError !== null) throw primaryError;
}

function writeDirectoryFileAtomicPreparedNoFollow(
  directory: AnchoredDirectory,
  name: string,
  data: string | Uint8Array,
  prepare: (fileDescriptor: number) => void,
): void {
  assertLeafName(name);
  const temporary = `${name}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  assertLeafName(temporary);
  let fileFd: number | null = null;
  let published = false;
  let primaryError: unknown = null;
  try {
    fileFd = openSync(
      anchoredChildPath(directory, temporary),
      leafFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    writeFileSync(fileFd, data);
    prepare(fileFd);
    const preparedFd = fileFd;
    fileFd = null;
    closeSync(preparedFd);
    renameSync(anchoredChildPath(directory, temporary), anchoredChildPath(directory, name));
    published = true;
  } catch (error) {
    primaryError = error;
  } finally {
    primaryError = closeFileDescriptor(fileFd, primaryError, `atomic write of ${name}`);
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

/** Atomically replace one leaf through an exclusively-created no-follow temp. */
export function writeDirectoryFileAtomicNoFollow(
  directory: AnchoredDirectory,
  name: string,
  data: string | Uint8Array,
): void {
  writeDirectoryFileAtomicPreparedNoFollow(directory, name, data, () => undefined);
}

/**
 * Publish one replacement whose final mode is installed before rename.
 *
 * The target never needs to become writable: bytes and mode are prepared on an
 * exclusively-created leaf, then one anchored pathname rename commits both.
 * Linux addresses that pathname through the retained descriptor; Darwin uses
 * the parent path previously proved with `O_NOFOLLOW_ANY`.
 */
export function writeDirectoryFileAtomicModeNoFollow(
  directory: AnchoredDirectory,
  name: string,
  data: string | Uint8Array,
  mode: number,
): void {
  writeDirectoryFileAtomicPreparedNoFollow(directory, name, data, (fileDescriptor) =>
    fchmodSync(fileDescriptor, mode));
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

/**
 * The owner-token grammar, in one place: a pid, optionally followed by the
 * claim time and randomness that make a token unique. A token that does not
 * match is a claim whose bytes never landed, not a claimant to signal.
 */
const OWNER_TOKEN = /^[1-9]\d*(?::\d+:[a-z0-9]+)?$/u;

function ownerPid(rawOwner: string): number | null {
  if (!OWNER_TOKEN.test(rawOwner)) return null;
  const pid = Number(rawOwner.split(":", 1)[0]);
  return Number.isSafeInteger(pid) ? pid : null;
}

function parseLockOwner(rawOwner: string, lockName: string): LockOwner {
  const pid = ownerPid(rawOwner);
  if (pid === null) {
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
 * Does `name` exist as a readable file-like entry under `directory`, without
 * following a symlink? ENOENT is the ONE absent answer; every other errno —
 * including EISDIR — is rethrown, so an unreadable entry never reads as missing.
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
 * A recovery guard is mutual exclusion, not a lease — so a claimant killed
 * between claiming the guard and releasing it would lock the State File for
 * every future process. Abandonment is therefore decidable from the guard
 * itself and never guessed: a pid the kernel reports gone is proof, and a token
 * that never landed (the guard was created and its writer killed before the
 * bytes) is proof only once it is older than any real recovery could take.
 */
const RECOVERY_GUARD_ABANDONED_MS = 60_000;

type RecoveryGuardSnapshot = Readonly<{
  token: string;
  device: bigint;
  inode: bigint;
  publishedAt: number;
}>;

function readRecoveryGuardSnapshot(
  directory: AnchoredDirectory,
  name: string,
): RecoveryGuardSnapshot {
  let fileFd: number | null = null;
  let snapshot: RecoveryGuardSnapshot | null = null;
  let primaryError: unknown = null;
  try {
    fileFd = openSync(anchoredChildPath(directory, name), leafFlags(fsConstants.O_RDONLY));
    const stat = fstatSync(fileFd, { bigint: true });
    snapshot = Object.freeze({
      token: readFileSync(fileFd).toString("utf-8"),
      device: stat.dev,
      inode: stat.ino,
      // Hard-linking a guard changes ctime. mtime remains the publication age
      // of an empty/partial token whose writer vanished before bytes landed.
      publishedAt: Number(stat.mtimeMs),
    });
  } catch (error) {
    primaryError = error;
  }
  primaryError = closeFileDescriptor(fileFd, primaryError, `read of recovery guard ${name}`);
  if (primaryError !== null) throw primaryError;
  if (snapshot === null) throw new Error(`read of recovery guard ${name} produced no snapshot`);
  return snapshot;
}

function sameRecoveryGuard(left: RecoveryGuardSnapshot, right: RecoveryGuardSnapshot): boolean {
  return left.token === right.token && left.device === right.device && left.inode === right.inode;
}

function recoveryGuardIsAbandoned(snapshot: RecoveryGuardSnapshot, now: number): boolean {
  const claimedPid = ownerPid(snapshot.token);
  return claimedPid === null
    ? now - snapshot.publishedAt >= RECOVERY_GUARD_ABANDONED_MS
    : !processIsAlive({ pid: claimedPid });
}

const recoveryTombPrefix = (recoveryName: string): string => `${recoveryName}.tomb-`;

function recoveryTombName(directory: AnchoredDirectory, recoveryName: string): string | null {
  return listDirectoryNamesNoFollow(directory)
    .find((name) => name.startsWith(recoveryTombPrefix(recoveryName))) ?? null;
}

/**
 * Finish an atomically claimed recovery guard.
 *
 * The tomb pathname owns one exact inode. A live guard moved by a race is
 * restored with a hard link that cannot replace a newer canonical guard; an
 * abandoned guard is deleted only at its unique tomb name. Acquirers treat a
 * tomb as recovery in progress, so the canonical-name gap cannot admit another
 * stale-lock recovery.
 */
function settleRecoveryGuardTomb(
  directory: AnchoredDirectory,
  recoveryName: string,
  tombName: string,
  now: number,
): boolean {
  let tomb: RecoveryGuardSnapshot;
  try {
    tomb = readRecoveryGuardSnapshot(directory, tombName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new Error(
      `cannot inspect recovery guard tomb ${tombName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!recoveryGuardIsAbandoned(tomb, now)) {
    try {
      linkSync(anchoredChildPath(directory, tombName), anchoredChildPath(directory, recoveryName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `cannot restore live recovery guard ${recoveryName}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      try {
        const canonical = readRecoveryGuardSnapshot(directory, recoveryName);
        if (!sameRecoveryGuard(canonical, tomb)) return false;
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw readError;
      }
    }
    removeDirectoryFileNoFollow(directory, tombName);
    return true;
  }

  // Re-read the tomb immediately before unlink. This proves the unique name
  // still denotes the exact abandoned token/inode this reclamation assessed.
  const confirmed = readRecoveryGuardSnapshot(directory, tombName);
  if (!sameRecoveryGuard(confirmed, tomb) || !recoveryGuardIsAbandoned(confirmed, now)) return false;
  removeDirectoryFileNoFollow(directory, tombName);
  process.stderr.write(
    `loom: reclaimed the recovery guard ${recoveryName} of a dead or vanished claimant; ` +
      "a prior lock recovery was interrupted\n",
  );
  return true;
}

function reclaimAbandonedRecoveryGuard(
  directory: AnchoredDirectory,
  recoveryName: string,
  now: number,
): boolean {
  const existingTomb = recoveryTombName(directory, recoveryName);
  if (existingTomb !== null) return settleRecoveryGuardTomb(directory, recoveryName, existingTomb, now);

  let observed: RecoveryGuardSnapshot;
  try {
    observed = readRecoveryGuardSnapshot(directory, recoveryName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(
      `cannot inspect recovery guard ${recoveryName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!recoveryGuardIsAbandoned(observed, now)) return false;

  const tombName = `${recoveryTombPrefix(recoveryName)}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    renameSync(anchoredChildPath(directory, recoveryName), anchoredChildPath(directory, tombName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(
      `cannot claim abandoned recovery guard ${recoveryName}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return settleRecoveryGuardTomb(directory, recoveryName, tombName, now);
}

function removeOwnedRecoveryEntry(
  directory: AnchoredDirectory,
  name: string,
  recoveryToken: string,
): void {
  let observed: string;
  try {
    observed = readDirectoryFileNoFollow(directory, name).toString("utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `cannot inspect recovery guard ${name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (observed !== recoveryToken) return;
  try {
    unlinkSync(anchoredChildPath(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `cannot remove recovery guard ${name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function removeOwnedRecoveryGuard(
  directory: AnchoredDirectory,
  recoveryName: string,
  recoveryToken: string,
): void {
  const ownedNames = [
    recoveryName,
    ...listDirectoryNamesNoFollow(directory)
      .filter((name) => name.startsWith(recoveryTombPrefix(recoveryName))),
  ];
  const failures: unknown[] = [];
  for (const name of ownedNames) {
    try {
      removeOwnedRecoveryEntry(directory, name, recoveryToken);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `multiple owned recovery entries for ${recoveryName} could not be cleaned up`);
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
  if (recoveryTombName(directory, recoveryName) !== null) return false;
  try {
    writeDirectoryFileExclusiveNoFollow(directory, recoveryName, recoveryToken);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  // A reclaimer may have atomically tombstoned the preceding guard between
  // our pre-check and exclusive publication. Withdraw this exact replacement
  // before it can authorize a concurrent stale-lock recovery.
  if (recoveryTombName(directory, recoveryName) !== null) {
    removeOwnedRecoveryGuard(directory, recoveryName, recoveryToken);
    return false;
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
    // An exclusively-created lock is observable for a moment before its owner
    // token lands. Such a claimant can become live at any instant, so its lock
    // is never stale — recovery stands down and the caller retries.
    if (observedOwner.trim().length === 0) return false;
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
    if (directoryEntryExistsNoFollow(directory, recoveryName) || recoveryTombName(directory, recoveryName) !== null) {
      if (reclaimAbandonedRecoveryGuard(directory, recoveryName, Date.now())) continue;
      await wait(LOCK_RETRY_MS);
      continue;
    }
    try {
      writeDirectoryFileExclusiveNoFollow(directory, lockName, ownerToken);
      // Recovery may have claimed its guard between the pre-check and our
      // exclusive create. Withdraw this exact token before entering; the
      // recovery owner will either reclaim the prior stale file or stand down.
      if (directoryEntryExistsNoFollow(directory, recoveryName) || recoveryTombName(directory, recoveryName) !== null) {
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

/** Hold one lock inside an already-retained directory capability. */
export async function withAnchoredDirectoryHandleLock<T>(
  anchored: AnchoredDirectory,
  lockName: string,
  operation: (directory: AnchoredDirectory) => T | Promise<T>,
): Promise<T> {
  assertLeafName(lockName);
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
}

/**
 * Hold a lock and its target directory through one anchored capability.
 *
 * On Linux the retained descriptor is the anchor, so no path swap after
 * acquisition can redirect either the lock or the callback's I/O. On darwin
 * the anchor is the proven-real path; a component swapped after acquisition
 * remains the documented accepted risk (see module header).
 */
export async function withAnchoredDirectoryLock<T>(
  directory: string,
  lockName: string,
  operation: (directory: AnchoredDirectory) => T | Promise<T>,
): Promise<T> {
  const anchored = openDirectoryNoFollow(directory);
  try {
    return await withAnchoredDirectoryHandleLock(anchored, lockName, operation);
  } finally {
    closeAnchoredDirectory(anchored);
  }
}

/**
 * Anchor an absolute directory path without following a symlink component.
 *
 * Linux walks each component relative to a retained parent descriptor with
 * `O_NOFOLLOW`. Darwin performs one whole-path open with `O_NOFOLLOW_ANY` and
 * retains both that descriptor and the proven pathname.
 */
export function openDirectoryNoFollow(path: string): AnchoredDirectory {
  const absolute = resolve(path);
  if (process.platform === "darwin") {
    // Darwin has no usable fd→path bridge: `/dev/fd/<fd>` is an fdesc node,
    // not a directory, and Node exposes no `openat`. `O_NOFOLLOW_ANY` asks the
    // kernel for the same whole-path guarantee in ONE resolution — the open
    // fails with ELOOP if ANY component is a symlink — so the returned real
    // path is safe to address children through.
    return anchorFor(openSync(absolute, dirFlags()), absolute);
  }
  const root = parse(absolute).root;
  let current = openSync(root, dirFlags());
  try {
    const components = relative(root, absolute).split(sep).filter(Boolean);
    for (const component of components) {
      const next = openSync(`/proc/self/fd/${current}/${component}`, dirFlags());
      const previous = current;
      current = next;
      // A throwing close must not replace the walk error nor leak the fd we
      // just opened: `current` is adopted before the close can fail, and the
      // outer catch releases it. The ELOOP diagnostic naming the hostile
      // component is the single most valuable error this primitive produces.
      const closeError = closeFileDescriptor(previous, null, `anchored walk of ${component}`);
      if (closeError !== null) throw closeError;
    }
    return anchorFor(current, absolute);
  } catch (error) {
    throw closeFileDescriptor(current, error, `anchored walk of ${absolute}`);
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
 * retained parent descriptor. On Darwin the retained parent identity is
 * re-proved through `O_NOFOLLOW_ANY` immediately before mkdir, and the child is
 * then opened with `O_NOFOLLOW_ANY`. That refuses an ancestor already swapped
 * at either proof; Node exposes no `mkdirat`, so the pathname-only Darwin branch
 * cannot claim descriptor-relative creation between those adjacent checks.
 */
function proveDarwinParentPath(directory: AnchoredDirectory): void {
  if (directory.anchor !== "real-path") return;
  const expected = anchoredDirectoryIdentity(directory);
  let proofFd: number | null = null;
  let primaryError: unknown = null;
  try {
    proofFd = openSync(directory.path, dirFlags());
    const observed = fstatSync(proofFd, { bigint: true });
    if (observed.dev !== expected.device || observed.ino !== expected.inode) {
      throw new Error(`darwin anchored parent path changed identity before directory creation: ${directory.path}`);
    }
  } catch (error) {
    primaryError = error;
  }
  primaryError = closeFileDescriptor(proofFd, primaryError, `darwin parent proof of ${directory.path}`);
  if (primaryError !== null) throw primaryError;
}

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
      proveDarwinParentPath(current);
      try {
        mkdirSync(child, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // The no-follow open checks the created/existing child before it becomes
      // the parent authority for another mkdir. On Darwin it also re-checks
      // every ancestor in the whole pathname after creation.
      const next = anchorFor(openSync(child, dirFlags()), child);
      if (ownsCurrent) closeAnchoredDirectory(current);
      current = next;
      ownsCurrent = true;
    }
  } finally {
    if (ownsCurrent) closeAnchoredDirectory(current);
  }
}

type AnchoredOperation<T> =
  | Readonly<{ kind: "returned"; value: T }>
  | Readonly<{ kind: "threw"; error: unknown }>;

function withOpenedDirectoryNoFollow<T>(
  path: string,
  operation: string,
  use: (directory: AnchoredDirectory) => T,
): T {
  const directory = openDirectoryNoFollow(path);
  let outcome: AnchoredOperation<T>;
  try {
    outcome = { kind: "returned", value: use(directory) };
  } catch (error) {
    outcome = { kind: "threw", error };
  }
  const failure = closeAnchorGuarded(
    directory,
    outcome.kind === "threw" ? outcome.error : null,
    operation,
  );
  if (failure !== null) throw failure;
  if (outcome.kind === "threw") throw outcome.error;
  return outcome.value;
}

function writeAnchoredRunFile(path: string, data: string | Uint8Array, exclusive: boolean): void {
  withOpenedDirectoryNoFollow(dirname(path), `write of ${basename(path)}`, (parent) => {
    let fileFd: number | null = null;
    let primaryError: unknown = null;
    try {
      fileFd = openSync(
        anchoredChildPath(parent, basename(path)),
        leafFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT |
          (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC)),
        0o600,
      );
      writeFileSync(fileFd, data);
    } catch (error) {
      primaryError = error;
    }
    primaryError = closeFileDescriptor(fileFd, primaryError, `write of ${basename(path)}`);
    if (primaryError !== null) throw primaryError;
  });
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
  return withOpenedDirectoryNoFollow(dirname(path), `read of ${basename(path)}`, (parent) =>
    readDirectoryFileNoFollow(parent, basename(path)));
}

/**
 * Remove a run artifact relative to its anchored parent. The leaf is named
 * relative to the anchored parent — the retained descriptor on Linux, the
 * proven-real path on darwin — so unlinking a planted symlink removes the link
 * itself and never its target (unlink(2) never follows the final component).
 */
export function removeRunFileNoFollow(path: string): void {
  withOpenedDirectoryNoFollow(dirname(path), `remove of ${basename(path)}`, (parent) =>
    unlinkSync(anchoredChildPath(parent, basename(path))));
}

/**
 * Publish staged bytes through one anchored parent directory. Both names are
 * resolved inside that directory, so neither can be redirected out of the run.
 */
export function publishStagedRunFile(stagedPath: string, finalPath: string): void {
  if (resolve(dirname(stagedPath)) !== resolve(dirname(finalPath))) {
    throw new Error("staged and final run artifacts must share one run directory");
  }
  withOpenedDirectoryNoFollow(dirname(stagedPath), `publish of ${basename(finalPath)}`, (parent) =>
    renameSync(
      anchoredChildPath(parent, basename(stagedPath)),
      anchoredChildPath(parent, basename(finalPath)),
    ));
}
