/**
 * The one no-clobber skeleton writer (AD-12, INV-3 owner). Every engine byte
 * that reaches a repository source file — a spawn skeleton, a contract stub,
 * a refreshed skeleton — goes through `createSkeleton` or `refreshSkeleton`;
 * no other module calls `writeFileSync`, `renameSync` or `linkSync` on a
 * skeleton path.
 *
 * Both refuse, as values:
 * - a path that is not canonical and repository-relative (`not-repo-relative`);
 * - a path an Acceptance Freeze covers (`frozen-path`, NFR-010/NFR-011);
 * - a path with any symlinked ancestor below the repository root
 *   (`symlinked-ancestor`): an `lstat` walk that follows no component, then
 *   every directory is opened through the anchored no-follow primitives, so a
 *   component swapped after the walk fails the write instead of redirecting it.
 *
 * Both first write the bytes, complete and with the skeleton mode, to a
 * prepared name beside the target, then publish them under the target name
 * with one syscall, and remove the prepared name whatever happened.
 *
 * `createSkeleton` never replaces anything (FR-011): an existing leaf of any
 * kind is `exists`. It publishes with `link(prepared, target)`, which fails
 * with `EEXIST` rather than overwrite, so a file that appears at any moment
 * before the link is never replaced.
 *
 * `refreshSkeleton` replaces a file only when its current bytes digest to
 * `expectedSha256` (the engine's own bytes): otherwise `modified`. A missing
 * file is `absent` and a non-regular leaf `not-a-regular-file`. It publishes
 * with `rename(prepared, target)`. POSIX has no compare-and-rename, so the
 * guard is placed as late as it can be: the replacement is prepared first,
 * and only then are the target's bytes read (no-follow) and digested,
 * immediately followed by the rename. A write that lands before that read —
 * at any time during the walk, the directory opens or the preparation — is
 * seen and refused as `modified`. The window that remains is the interval
 * between that read returning and the rename taking effect, with no I/O in
 * it but the rename itself: a write landing there (in place, or by replacing
 * the name) is lost. Closing it would take an atomic exchange
 * (`renameat2(RENAME_EXCHANGE)`) and a verified swap back, which Node does
 * not expose.
 *
 * Each file is complete or absent (NFR-021): bytes only ever appear under the
 * target name through one link or one rename. A prepared name that cannot be
 * removed after the bytes were published leaves the write `written`, naming
 * the prepared name left behind (`leftover`); after a `modified` refusal it
 * stays that refusal, naming it the same way, so a caller still reads the
 * target as changed by someone else; after anything else, it is an
 * `io-failed` naming both. Missing parent directories are created one
 * anchored component at a time. There is no retry; an I/O failure is
 * `io-failed` with the operating system's message.
 */

import { linkSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes, sha256Hex } from "../core/digest";
import { normalizePlanPath } from "../core/plan-path-match";
import {
  anchoredChildPath,
  closeAnchoredDirectory,
  openChildDirectoryNoFollow,
  openDirectoryNoFollow,
  readDirectoryFileNoFollow,
  removeDirectoryFileNoFollow,
  resolveBaseDirectory,
  writeDirectoryFileAtomicModeNoFollow,
  type AnchoredDirectory,
} from "./no-follow-fs";

/** Why the writer refused a path, before or instead of touching it. */
export type SkeletonWriteRefusal =
  | "not-repo-relative"
  | "frozen-path"
  | "symlinked-ancestor"
  | "not-a-regular-file"
  | "absent"
  | "modified";

/** A prepared name the writer could not remove after a write, and why. */
export type PreparedNameLeftover = Readonly<{ name: string; message: string }>;

export type SkeletonWriteResult =
  /** The bytes are published under the target name. `leftover` is the prepared
   *  name that could not be removed afterwards, if any: the write still stands. */
  | Readonly<{ kind: "written"; sha256: string; leftover: PreparedNameLeftover | null }>
  | Readonly<{ kind: "exists" }>
  /** Refused before the replacement was prepared: nothing was left behind. */
  | Readonly<{ kind: "refused"; reason: Exclude<SkeletonWriteRefusal, "modified"> }>
  /** The target's bytes changed: refused after the replacement was prepared,
   *  so `leftover` names the prepared name that could not be removed, if any. */
  | Readonly<{ kind: "refused"; reason: "modified"; leftover: PreparedNameLeftover | null }>
  | Readonly<{ kind: "io-failed"; message: string }>;

/** Source files are world-readable and owner-writable, like any checkout. */
const SKELETON_MODE = 0o644;
const DIRECTORY_MODE = 0o755;

const refused = (reason: Exclude<SkeletonWriteRefusal, "modified">): SkeletonWriteResult => Object.freeze({ kind: "refused", reason });
const MODIFIED: SkeletonWriteResult = Object.freeze({ kind: "refused", reason: "modified", leftover: null });
const EXISTS: SkeletonWriteResult = Object.freeze({ kind: "exists" });
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const ioFailed = (error: unknown): SkeletonWriteResult => Object.freeze({ kind: "io-failed", message: messageOf(error) });

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/**
 * What a failed `link(prepared, target)` means. `EEXIST` is a file that
 * appeared at the target after the walk: `exists`, never overwritten (FR-011).
 * Any other error is an I/O failure.
 */
export const linkFailureResult = (error: unknown): SkeletonWriteResult =>
  errnoOf(error) === "EEXIST" ? EXISTS : ioFailed(error);

/**
 * Whether a failed `mkdir` of a missing parent directory still lets the write
 * go on. `EEXIST` is a directory that appeared after the open found none: it
 * is opened no-follow next, so a link there still fails the write. Any other
 * error (`EACCES`, `ENOSPC`, ...) is the write's own I/O failure.
 */
export const mkdirFailureTolerated = (error: unknown): boolean => errnoOf(error) === "EEXIST";

/** The path's segments when it is canonical and repository-relative: forward
 *  slashes, no leading `./`, no empty, `.` or `..` segment, not absolute. */
function repoRelativeSegments(path: string): readonly string[] | null {
  if (path === "" || normalizePlanPath(path) !== path || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") ? segments : null;
}

/** What the no-follow `lstat` walk found at the target. */
type Walked =
  | Readonly<{ kind: "refused"; reason: "symlinked-ancestor" }>
  | Readonly<{ kind: "leaf"; leaf: "absent" | "file" | "other" }>;

/**
 * `lstat` every ancestor below the root, then the leaf, following nothing.
 * A missing ancestor ends the walk: everything below it is absent and will be
 * created. A non-directory ancestor is an I/O failure, thrown to the caller.
 */
function walk(realRoot: string, segments: readonly string[]): Walked {
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = join(realRoot, ...segments.slice(0, depth));
    let stat;
    try {
      stat = lstatSync(ancestor);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return { kind: "leaf", leaf: "absent" };
      throw error;
    }
    if (stat.isSymbolicLink()) return { kind: "refused", reason: "symlinked-ancestor" };
    if (!stat.isDirectory()) throw new Error(`${ancestor} is not a directory`);
  }
  try {
    return { kind: "leaf", leaf: lstatSync(join(realRoot, ...segments)).isFile() ? "file" : "other" };
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { kind: "leaf", leaf: "absent" };
    throw error;
  }
}

/** Open (creating when absent) each directory below `root`, following no link;
 *  the caller owns the returned anchor. */
function openParent(root: AnchoredDirectory, directories: readonly string[]): AnchoredDirectory {
  let current = root;
  try {
    for (const name of directories) {
      let next: AnchoredDirectory;
      try {
        next = openChildDirectoryNoFollow(current, name);
      } catch (error) {
        if (errnoOf(error) !== "ENOENT") throw error;
        try {
          mkdirSync(anchoredChildPath(current, name), { mode: DIRECTORY_MODE });
        } catch (mkdirError) {
          if (!mkdirFailureTolerated(mkdirError)) throw mkdirError;
        }
        next = openChildDirectoryNoFollow(current, name);
      }
      if (current !== root) closeAnchoredDirectory(current);
      current = next;
    }
    return current;
  } catch (error) {
    if (current !== root) closeAnchoredDirectory(current);
    throw error;
  }
}

type Effect = (parent: AnchoredDirectory, leaf: string) => SkeletonWriteResult;

/** The shared rules, then `effect` inside the anchored parent directory. */
function guarded(
  root: string,
  path: string,
  frozen: ReadonlySet<string>,
  onLeaf: (leaf: "absent" | "file" | "other") => SkeletonWriteResult | null,
  effect: Effect,
): SkeletonWriteResult {
  const segments = repoRelativeSegments(path);
  if (segments === null) return refused("not-repo-relative");
  if ([...frozen].some((frozenPath) => normalizePlanPath(frozenPath) === path)) return refused("frozen-path");
  try {
    const realRoot = resolveBaseDirectory(root);
    const walked = walk(realRoot, segments);
    if (walked.kind === "refused") return refused(walked.reason);
    const early = onLeaf(walked.leaf);
    if (early !== null) return early;
    const rootDirectory = openDirectoryNoFollow(realRoot);
    try {
      const parent = openParent(rootDirectory, segments.slice(0, -1));
      try {
        return effect(parent, segments[segments.length - 1]!);
      } finally {
        if (parent !== rootDirectory) closeAnchoredDirectory(parent);
      }
    } finally {
      closeAnchoredDirectory(rootDirectory);
    }
  } catch (error) {
    return ioFailed(error);
  }
}

/** A prepared name beside the target, unique to this write. */
const preparedName = (leaf: string): string =>
  `.${leaf}.loom-skeleton-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const written = (bytes: string): SkeletonWriteResult => Object.freeze({ kind: "written", sha256: sha256Hex(bytes), leftover: null });

/**
 * What a write reports when its prepared name could not be removed
 * afterwards. Bytes that reached the target are published: still `written`,
 * naming the prepared name left behind. A `modified` refusal stays that
 * refusal, naming it the same way: the target still changed under someone
 * else's hand. Any other result becomes an I/O failure naming both what
 * happened and the name left behind.
 */
export function withPreparedNameLeft(result: SkeletonWriteResult, prepared: string, error: unknown): SkeletonWriteResult {
  const leftover: PreparedNameLeftover = Object.freeze({ name: prepared, message: messageOf(error) });
  switch (result.kind) {
    case "written":
      return Object.freeze({ ...result, leftover });
    case "exists":
      return ioFailed(`a file appeared at the target meanwhile, and the prepared name ${prepared} was left behind (${leftover.message})`);
    case "refused":
      return result.reason === "modified"
        ? Object.freeze({ ...result, leftover })
        : ioFailed(`refused (${result.reason}), and the prepared name ${prepared} was left behind (${leftover.message})`);
    case "io-failed":
      return ioFailed(`${result.message}, and the prepared name ${prepared} was left behind (${leftover.message})`);
  }
}

/**
 * Write `bytes` to a prepared name beside the target (complete, with the
 * skeleton mode), let `publish` put them under the target name, then remove
 * the prepared name whatever happened.
 */
function publishPrepared(
  parent: AnchoredDirectory,
  leaf: string,
  bytes: string,
  publish: (prepared: string) => SkeletonWriteResult,
): SkeletonWriteResult {
  const prepared = preparedName(leaf);
  let result: SkeletonWriteResult;
  try {
    writeDirectoryFileAtomicModeNoFollow(parent, prepared, bytes, SKELETON_MODE);
    result = publish(prepared);
  } catch (error) {
    result = ioFailed(error);
  }
  try {
    removeDirectoryFileNoFollow(parent, prepared);
  } catch (error) {
    return withPreparedNameLeft(result, prepared, error);
  }
  return result;
}

/** Write `bytes` at `path` only if nothing is there: `written`, or `exists`. */
export function createSkeleton(root: string, path: string, bytes: string, frozen: ReadonlySet<string>): SkeletonWriteResult {
  return guarded(root, path, frozen, (leaf) => (leaf === "absent" ? null : EXISTS), (parent, leaf) =>
    publishPrepared(parent, leaf, bytes, (prepared) => {
      try {
        linkSync(anchoredChildPath(parent, prepared), anchoredChildPath(parent, leaf));
      } catch (error) {
        return linkFailureResult(error);
      }
      return written(bytes);
    }));
}

/**
 * Replace the file at `path` with `bytes` only while its bytes digest to
 * `expectedSha256`: `written`, or refused `absent`/`not-a-regular-file`/`modified`.
 * The replacement is prepared first; the digest is read last, right before
 * the rename (see the module header for the window that remains).
 */
export function refreshSkeleton(
  root: string,
  path: string,
  expectedSha256: string,
  bytes: string,
  frozen: ReadonlySet<string>,
): SkeletonWriteResult {
  const onLeaf = (leaf: "absent" | "file" | "other"): SkeletonWriteResult | null =>
    leaf === "absent" ? refused("absent") : leaf === "other" ? refused("not-a-regular-file") : null;
  return guarded(root, path, frozen, onLeaf, (parent, leaf) =>
    publishPrepared(parent, leaf, bytes, (prepared) => {
      if (sha256Bytes(readDirectoryFileNoFollow(parent, leaf)) !== expectedSha256) return MODIFIED;
      renameSync(anchoredChildPath(parent, prepared), anchoredChildPath(parent, leaf));
      return written(bytes);
    }));
}

/** `; its prepared name … was left behind (…)` for a leftover, else nothing. */
export const leftoverClause = (leftover: PreparedNameLeftover | null): string =>
  leftover === null ? "" : `; its prepared name ${leftover.name} was left behind (${leftover.message})`;

/** One line naming why a write did not happen, for a refusal diagnostic. */
export function renderSkeletonWriteResult(path: string, result: SkeletonWriteResult): string {
  switch (result.kind) {
    case "written":
      return `${path}: written${leftoverClause(result.leftover)}`;
    case "exists":
      return `${path}: a file appeared there during registration; it was left untouched`;
    case "refused":
      return `${path}: refused (${result.reason})${result.reason === "modified" ? leftoverClause(result.leftover) : ""}`;
    case "io-failed":
      return `${path}: write failed (${result.message})`;
  }
}
