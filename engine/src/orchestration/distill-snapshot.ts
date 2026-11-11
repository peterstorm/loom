/**
 * The Git adapter of the Distill Snapshot port (ADR-0068 §5,
 * `core/distill-snapshot.ts`): a Distill Task attempt's scope bytes as one
 * Git tree, kept alive by `refs/loom/distill/<authority digest>`.
 *
 * - **Capture** hashes every scope leaf into the object store
 *   (`hash-object -w --stdin`: raw bytes, no clean filter), builds the tree
 *   in a throwaway index (`update-index --index-info`, `write-tree`) and
 *   points the ref at it. The user's index and worktree are never touched. A
 *   scope path is read from disk whatever the ignore rules say (it is
 *   declared scope); a scope DIRECTORY contributes its Git-visible leaves,
 *   exactly the leaves the declared-artifact baseline hashes for it, so
 *   "restored" and "equal to the attempt baseline" agree.
 * - **Restore** makes every scope path what the tree holds, and removes what
 *   it lacks. It writes only where bytes, link target or executable bit
 *   differ, so it is idempotent and leaves an untouched file's mtime alone.
 * - **Discard** deletes the ref.
 *
 * Every Git child runs under the one execution policy (`spawnGit`); the ref
 * writes additionally run with no hooks directory, so an engine-internal ref
 * never fires a repository's `reference-transaction` hook. Every expected
 * failure is a `DistillSnapshotFailure` value.
 *
 * Limit: Git stores no empty directory. A scope directory that was empty at
 * capture is indistinguishable from a missing one, so a restore removes it
 * when the attempt filled it; settlement's re-observation then reports the
 * difference as infrastructure rather than passing it.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  describeDistillSnapshotFailure,
  parseSnapshotTree,
  restoredFilePermissions,
  snapshotEntriesUnder,
  snapshotFileMode,
  snapshotIndexInfo,
  withinScopePath,
  type DistillSnapshotEntry,
  type DistillSnapshotFailure,
  type DistillSnapshotMode,
  type DistillSnapshotPort,
  type DistillSnapshotResult,
} from "../core/distill-snapshot";
import { distillSnapshotRef } from "../core/distill-task";
import type { DomainResult } from "../core/orchestration-contract";
import { describeCause } from "../utils/describe-cause";
import { GIT_PROBE_OUTPUT_LIMIT, spawnGit, type SpawnGitRun } from "../utils/git-execution-policy";
import { worktreeVisibleLeafPaths } from "../utils/git-leaves";
import { describeGitOutcome, gitCleanNegative, gitExitedWith, gitStdoutText } from "../utils/git-spawn-outcome";
import { inspectRepositoryPath } from "../utils/repository-path";

type Outcome<T> = DomainResult<T, DistillSnapshotFailure>;

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const failed = (error: DistillSnapshotFailure): Outcome<never> => ({ ok: false, error });

/** One blob's budget: a scope file, read back whole. */
const BLOB_OUTPUT_LIMIT = 100 * 1024 * 1024;

/** An engine-internal ref write runs no repository hook. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;

const SCOPE_LABEL = "distill scope path";

/** One Git command that must exit 0: its stdout, or the failure naming it. */
function git(root: string, command: string, args: readonly string[], run: Partial<SpawnGitRun> = {}): Outcome<Buffer> {
  const outcome = spawnGit(args, { cwd: root, maxBuffer: GIT_PROBE_OUTPUT_LIMIT, ...run });
  return gitExitedWith(outcome, [0])
    ? ok(outcome.stdout)
    : failed({ kind: "git-failed", command, detail: describeGitOutcome(outcome) });
}

/** A filesystem step at one scope path: a throw becomes that path's failure. */
function atScopePath<T>(path: string, step: () => Outcome<T>): Outcome<T> {
  try {
    return step();
  } catch (error) {
    return failed({ kind: "scope-path-failed", path, detail: describeCause(error) });
  }
}

/** Every result's value in order, or the first failure. */
function allOf<T>(results: readonly Outcome<T>[]): Outcome<readonly T[]> {
  const failure = results.find((result) => !result.ok);
  if (failure !== undefined && !failure.ok) return failure;
  return ok(results.flatMap((result) => (result.ok ? [result.value] : [])));
}

/** The node at `path` without following a link, or null when none is there:
 *  the path is missing, or a parent of it is no directory (an index entry
 *  behind a file that took its directory's place). */
function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** One leaf to snapshot: its path, its Git mode and the bytes Git stores for it. */
type WorktreeSnapshotLeaf = Readonly<{ path: string; mode: DistillSnapshotMode; bytes: Buffer }>;

/** The leaf at one present path: a file's bytes, or a symlink's target text (never followed). */
function leafAt(root: string, path: string): WorktreeSnapshotLeaf | null {
  const absolute = join(root, path);
  const stat = lstatIfPresent(absolute);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) return { path, mode: "120000", bytes: readlinkSync(absolute, { encoding: "buffer" }) };
  if (stat.isFile()) return { path, mode: snapshotFileMode(stat.mode), bytes: readFileSync(absolute) };
  throw new Error(`${path} is neither a file nor a symlink`);
}

/**
 * The leaves one scope path holds now. A missing path holds none. A file or
 * symlink is itself, whatever the ignore rules say. A directory holds its
 * Git-visible leaves (`worktreeVisibleLeafPaths`, the enumerator the
 * declared-artifact baseline hashes a directory by); an index entry the
 * worktree no longer holds has no bytes and contributes nothing.
 */
function scopeLeaves(root: string, scopePath: string): Outcome<readonly WorktreeSnapshotLeaf[]> {
  return atScopePath(scopePath, () => {
    const inspected = inspectRepositoryPath(root, scopePath, SCOPE_LABEL, { allowLeafSymlink: true });
    if (!inspected.exists) return ok([]);
    const paths = lstatSync(inspected.absolute).isDirectory()
      ? worktreeVisibleLeafPaths(root, inspected.relative).filter((path) => !path.endsWith("/"))
      : [inspected.relative];
    return ok(paths.flatMap((path) => {
      const leaf = leafAt(root, path);
      return leaf === null ? [] : [leaf];
    }));
  });
}

/** Store one leaf's bytes as a blob: raw, with no clean filter or line-ending conversion. */
function storeBlob(root: string, leaf: WorktreeSnapshotLeaf): Outcome<DistillSnapshotEntry> {
  const stored = git(root, "hash-object", ["hash-object", "-w", "--stdin"], { input: leaf.bytes });
  if (!stored.ok) return stored;
  return ok({ mode: leaf.mode, sha: stored.value.toString("utf-8").trim(), path: leaf.path });
}

/** The tree of `entries`, built in a throwaway index so the user's index is never read or written. */
function writeTree(root: string, entries: readonly DistillSnapshotEntry[]): Outcome<string> {
  let directory: string;
  try {
    directory = mkdtempSync(join(tmpdir(), "loom-distill-index-"));
  } catch (error) {
    return failed({ kind: "git-failed", command: "write-tree", detail: `could not create a temporary index: ${describeCause(error)}` });
  }
  try {
    const location = { GIT_INDEX_FILE: join(directory, "index") };
    // Git reads a missing index as an empty one, so an empty snapshot stages nothing.
    const staged = entries.length === 0
      ? ok(Buffer.alloc(0))
      : git(root, "update-index", ["update-index", "-z", "--index-info"], { location, input: Buffer.from(snapshotIndexInfo(entries), "utf-8") });
    if (!staged.ok) return staged;
    const tree = git(root, "write-tree", ["write-tree"], { location });
    return tree.ok ? ok(tree.value.toString("utf-8").trim()) : tree;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function capture(root: string, authorityDigest: string, scope: readonly string[]): DistillSnapshotResult {
  const ref = distillSnapshotRef(authorityDigest);
  const leaves = allOf(scope.map((scopePath) => scopeLeaves(root, scopePath)));
  if (!leaves.ok) return leaves;
  const distinct = [...new Map(leaves.value.flat().map((leaf) => [leaf.path, leaf] as const)).values()];
  const entries = allOf(distinct.map((leaf) => storeBlob(root, leaf)));
  if (!entries.ok) return entries;
  const tree = writeTree(root, entries.value);
  if (!tree.ok) return tree;
  // An unconditional update replaces a snapshot left under the same ref.
  const pointed = git(root, "update-ref", [...NO_HOOKS, "update-ref", ref, tree.value]);
  return pointed.ok ? ok({ ref }) : pointed;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** The leaves of the snapshot tree under `ref`, or `no-snapshot` when the ref names none. */
function snapshotTree(root: string, ref: string): Outcome<readonly DistillSnapshotEntry[]> {
  const resolved = spawnGit(["rev-parse", "--verify", "--quiet", `${ref}^{tree}`], { cwd: root, maxBuffer: GIT_PROBE_OUTPUT_LIMIT });
  if (gitCleanNegative(resolved)) return failed({ kind: "no-snapshot", ref });
  if (!gitExitedWith(resolved, [0])) return failed({ kind: "git-failed", command: "rev-parse", detail: describeGitOutcome(resolved) });
  const listing = git(root, "ls-tree", ["ls-tree", "-r", "-z", gitStdoutText(resolved).trim()], { maxBuffer: BLOB_OUTPUT_LIMIT });
  if (!listing.ok) return listing;
  const parsed = parseSnapshotTree(listing.value.toString("utf-8"));
  return parsed.ok ? ok(parsed.value) : failed({ kind: "git-failed", command: "ls-tree", detail: parsed.error });
}

/** The present leaves at or below one scope path: what a restore may have to remove. */
function presentLeafPaths(root: string, scopePath: string, exists: boolean): readonly string[] {
  if (!exists) return [];
  if (!lstatSync(join(root, scopePath)).isDirectory()) return [scopePath];
  return worktreeVisibleLeafPaths(root, scopePath)
    .filter((path) => !path.endsWith("/") && lstatIfPresent(join(root, path)) !== null);
}

/**
 * Remove one leaf the snapshot lacks, then every directory it leaves empty
 * below the scope path — and the scope path itself when the snapshot holds
 * nothing there, so a directory the attempt created is gone again.
 */
function removeLeaf(root: string, scopePath: string, leaf: string, removeScopeDirectory: boolean): void {
  rmSync(join(root, leaf), { force: true });
  let directory = dirname(leaf);
  while (withinScopePath(scopePath, directory) && (directory !== scopePath || removeScopeDirectory)) {
    try {
      rmdirSync(join(root, directory));
    } catch {
      return;
    }
    directory = dirname(directory);
  }
}

/**
 * Make every parent of `path` a real directory. A parent at or below the
 * scope path that is a file or a link is the attempt's write and is replaced;
 * one above the scope path is not this Task's to change.
 */
function ensureParentDirectories(root: string, scopePath: string, path: string): void {
  const segments = path.split("/").slice(0, -1);
  let parent = "";
  for (const segment of segments) {
    parent = parent === "" ? segment : `${parent}/${segment}`;
    const absolute = join(root, parent);
    const stat = lstatIfPresent(absolute);
    if (stat?.isDirectory() === true) continue;
    if (stat !== null) {
      if (!withinScopePath(scopePath, parent)) throw new Error(`parent ${parent} is not a directory`);
      rmSync(absolute, { recursive: true, force: true });
    }
    mkdirSync(absolute);
  }
}

/** Write one snapshot leaf back, touching the path only where it differs. */
function writeEntry(root: string, entry: DistillSnapshotEntry, bytes: Buffer): void {
  const absolute = join(root, entry.path);
  const stat = lstatIfPresent(absolute);
  if (entry.mode === "120000") {
    if (stat?.isSymbolicLink() === true && readlinkSync(absolute, { encoding: "buffer" }).equals(bytes)) return;
    rmSync(absolute, { recursive: true, force: true });
    symlinkSync(bytes, absolute);
    return;
  }
  // A link or directory where the snapshot holds a file is removed first: a
  // write through a link would land on its target.
  if (stat !== null && !stat.isFile()) rmSync(absolute, { recursive: true, force: true });
  if (stat?.isFile() !== true || !readFileSync(absolute).equals(bytes)) writeFileSync(absolute, bytes);
  const permissions = lstatSync(absolute).mode & 0o777;
  const wanted = restoredFilePermissions(permissions, entry.mode === "100755");
  if (wanted !== permissions) chmodSync(absolute, wanted);
}

/** Make one scope path what the snapshot holds: remove what it lacks, write back what it has. */
function restoreScopePath(root: string, rawScopePath: string, tree: readonly DistillSnapshotEntry[]): Outcome<null> {
  return atScopePath(rawScopePath, () => {
    const inspected = inspectRepositoryPath(root, rawScopePath, SCOPE_LABEL, { allowLeafSymlink: true });
    const scopePath = inspected.relative;
    const wanted = snapshotEntriesUnder(tree, scopePath);
    const kept = new Set(wanted.map(({ path }) => path));
    for (const leaf of presentLeafPaths(root, scopePath, inspected.exists)) {
      if (!kept.has(leaf)) removeLeaf(root, scopePath, leaf, wanted.length === 0);
    }
    for (const entry of wanted) {
      const blob = git(root, "cat-file", ["cat-file", "blob", entry.sha], { maxBuffer: BLOB_OUTPUT_LIMIT });
      if (!blob.ok) return blob;
      ensureParentDirectories(root, scopePath, entry.path);
      writeEntry(root, entry, blob.value);
    }
    return ok(null);
  });
}

function restore(root: string, authorityDigest: string, scope: readonly string[]): DistillSnapshotResult {
  const ref = distillSnapshotRef(authorityDigest);
  const tree = snapshotTree(root, ref);
  if (!tree.ok) return tree;
  const restored = allOf(scope.map((scopePath) => restoreScopePath(root, scopePath, tree.value)));
  return restored.ok ? ok({ ref }) : restored;
}

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

function discard(root: string, authorityDigest: string): DistillSnapshotResult {
  const ref = distillSnapshotRef(authorityDigest);
  // Deleting a ref that does not exist exits 0, so a repeated discard is no failure.
  const deleted = git(root, "update-ref", [...NO_HOOKS, "update-ref", "-d", ref]);
  return deleted.ok ? ok({ ref }) : deleted;
}

/**
 * Forget snapshots nothing reads any more, through `snapshots`. One that
 * cannot be forgotten is a leftover ref: it is noted on stderr and never
 * refuses or fails the registration or settlement that let it go.
 */
export function discardDistillSnapshots(
  root: string,
  authorityDigests: readonly string[],
  snapshots: DistillSnapshotPort,
): void {
  for (const authorityDigest of authorityDigests) {
    const discarded = snapshots.discard(root, authorityDigest);
    if (!discarded.ok) {
      process.stderr.write(`[loom] distill snapshot note: ${describeDistillSnapshotFailure(discarded.error)}\n`);
    }
  }
}

/** The production Distill Snapshot store: this repository's own object store and refs. */
export const gitDistillSnapshots: DistillSnapshotPort = Object.freeze({ capture, restore, discard });
