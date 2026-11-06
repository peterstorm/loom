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
 * `createSkeleton` never replaces anything (FR-011): an existing leaf of any
 * kind is `exists`. It writes the bytes to a prepared file in the target
 * directory, then publishes it with `link(prepared, target)`, which fails with
 * `EEXIST` rather than overwrite, and drops the prepared name.
 *
 * `refreshSkeleton` replaces a file only when its current bytes digest to
 * `expectedSha256` (the engine's own bytes): otherwise `modified`. A missing
 * file is `absent` and a non-regular leaf `not-a-regular-file`. It renames a
 * prepared temp file over the target.
 *
 * Each file is complete or absent (NFR-021): bytes only ever appear under the
 * target name through one link or one rename, and every prepared name is
 * removed whatever happens. Missing parent directories are created one
 * anchored component at a time. There is no retry; an I/O failure is
 * `io-failed` with the operating system's message.
 */

import { linkSync, lstatSync, mkdirSync } from "node:fs";
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

export type SkeletonWriteResult =
  | Readonly<{ kind: "written"; sha256: string }>
  | Readonly<{ kind: "exists" }>
  | Readonly<{ kind: "refused"; reason: SkeletonWriteRefusal }>
  | Readonly<{ kind: "io-failed"; message: string }>;

/** Source files are world-readable and owner-writable, like any checkout. */
const SKELETON_MODE = 0o644;
const DIRECTORY_MODE = 0o755;

const refused = (reason: SkeletonWriteRefusal): SkeletonWriteResult => Object.freeze({ kind: "refused", reason });
const EXISTS: SkeletonWriteResult = Object.freeze({ kind: "exists" });
const ioFailed = (error: unknown): SkeletonWriteResult =>
  Object.freeze({ kind: "io-failed", message: error instanceof Error ? error.message : String(error) });

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
  | Readonly<{ kind: "refused"; reason: SkeletonWriteRefusal }>
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

/** A prepared name beside the target, unique to this write. */
const preparedName = (leaf: string): string =>
  `.${leaf}.loom-skeleton-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

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

/** Write `bytes` at `path` only if nothing is there: `written`, or `exists`. */
export function createSkeleton(root: string, path: string, bytes: string, frozen: ReadonlySet<string>): SkeletonWriteResult {
  return guarded(root, path, frozen, (leaf) => (leaf === "absent" ? null : EXISTS), (parent, leaf) => {
    const prepared = preparedName(leaf);
    try {
      writeDirectoryFileAtomicModeNoFollow(parent, prepared, bytes, SKELETON_MODE);
      try {
        linkSync(anchoredChildPath(parent, prepared), anchoredChildPath(parent, leaf));
      } catch (error) {
        return linkFailureResult(error);
      }
      return Object.freeze({ kind: "written", sha256: sha256Hex(bytes) });
    } finally {
      removeDirectoryFileNoFollow(parent, prepared);
    }
  });
}

/** Replace the file at `path` with `bytes` only while its bytes digest to
 *  `expectedSha256`: `written`, or refused `absent`/`not-a-regular-file`/`modified`. */
export function refreshSkeleton(
  root: string,
  path: string,
  expectedSha256: string,
  bytes: string,
  frozen: ReadonlySet<string>,
): SkeletonWriteResult {
  const onLeaf = (leaf: "absent" | "file" | "other"): SkeletonWriteResult | null =>
    leaf === "absent" ? refused("absent") : leaf === "other" ? refused("not-a-regular-file") : null;
  return guarded(root, path, frozen, onLeaf, (parent, leaf) => {
    if (sha256Bytes(readDirectoryFileNoFollow(parent, leaf)) !== expectedSha256) return refused("modified");
    writeDirectoryFileAtomicModeNoFollow(parent, leaf, bytes, SKELETON_MODE);
    return Object.freeze({ kind: "written", sha256: sha256Hex(bytes) });
  });
}

/** One line naming why a write did not happen, for a refusal diagnostic. */
export function renderSkeletonWriteResult(path: string, result: SkeletonWriteResult): string {
  switch (result.kind) {
    case "written":
      return `${path}: written`;
    case "exists":
      return `${path}: a file appeared there during registration; it was left untouched`;
    case "refused":
      return `${path}: refused (${result.reason})`;
    case "io-failed":
      return `${path}: write failed (${result.message})`;
  }
}
