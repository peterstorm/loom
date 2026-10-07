/**
 * The leaves Git can see below a repository path — in the worktree and at a
 * revision. This module is the only place that asks Git for them.
 *
 * ONE worktree enumerator (`worktreeVisibleLeafPaths`) serves the
 * declared-artifact snapshot hasher, the reviewed-workspace reader, the Review
 * Packet builder, the Wave lint shell and the task-local diff collector, so
 * they agree by construction on literal pathspecs, ignore rules, deleted index
 * entries, symlinks and empty directories. A path containing glob characters
 * is always that literal path, never a pattern. Every command runs under the
 * shared `git-execution-policy` (see `gitOutput`). Commands here THROW on
 * failure; `utils/git.ts` wraps the enumerator in the warn-and-return Result
 * adapters (`visibleLeavesAt`, `untrackedLeavesAt`) its callers expect.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { compareStrings } from "../core/ordering";
import { hardenedGitInvocation } from "./git-execution-policy";

/** The stdout budget of one Git path or revision listing — this module's and
 *  `utils/git.ts`'s shadow-run dirty-path listings alike. */
export const GIT_OUTPUT_LIMIT = 100 * 1024 * 1024;

/**
 * One Git command's stdout bytes, run in the real repository under the shared
 * `git-execution-policy`: an allow-listed environment (no ambient GIT_* or
 * config injection, no system or global config) and `core.fsmonitor`
 * disabled by a `-c` argv prefix. Every enumerator and revision read in this module — and every
 * consumer of them — therefore shares one execution policy, chosen in one
 * place. It deliberately does not use `utils/git.ts`'s shadow administration
 * directory: that removes `info/exclude` and the repository's
 * `core.excludesFile`, which the leaf enumerator's ignore rules require, and
 * the listing commands run no filter or diff driver.
 */
export function gitOutput(root: string, args: readonly string[]): Buffer {
  const { argv, env } = hardenedGitInvocation(args);
  return execFileSync("git", argv, {
    cwd: root,
    encoding: "buffer",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
}

/** Git's `-z` record format: NUL-terminated records, decoded as UTF-8. The one
 *  parse of it, shared with `utils/git.ts`'s shadow-run listings (pure). */
export function splitNulPaths(output: Buffer): readonly string[] {
  return Object.freeze(output.toString("utf-8").split("\0").filter((path) => path !== ""));
}

export function nulSeparatedGitPaths(root: string, args: readonly string[]): readonly string[] {
  return splitNulPaths(gitOutput(root, args));
}

/**
 * One Git-visible leaf in the worktree, typed by `lstat` without following any
 * link — not the leaf, not a parent:
 *
 * - `file` / `symlink`: a node to read (a symlink by its target text);
 * - `absent`: an index entry with no worktree node;
 * - `shadowed`: an index entry behind a parent that is no longer a real
 *   directory (a file or symlink took its place), so the worktree cannot hold it;
 * - `unsupported`: a Git-visible node that is neither a file nor a symlink
 *   (an embedded repository or a gitlink directory).
 */
export type WorktreeLeaf =
  | Readonly<{ kind: "file" | "symlink"; path: string; absolute: string }>
  | Readonly<{ kind: "absent" | "shadowed" | "unsupported"; path: string }>;

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

function worktreeLeaf(root: string, listed: string): WorktreeLeaf {
  // `ls-files --others` lists an untracked embedded repository as `dir/`.
  if (listed.endsWith("/")) return Object.freeze({ kind: "unsupported", path: listed.slice(0, -1) });
  const segments = listed.split("/");
  let absolute = root;
  for (const [index, segment] of segments.entries()) {
    absolute = join(absolute, segment);
    const stat = lstatIfPresent(absolute);
    if (stat === null) return Object.freeze({ kind: "absent", path: listed });
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) return Object.freeze({ kind: "shadowed", path: listed });
      continue;
    }
    if (stat.isFile()) return Object.freeze({ kind: "file", path: listed, absolute });
    if (stat.isSymbolicLink()) return Object.freeze({ kind: "symlink", path: listed, absolute });
  }
  return Object.freeze({ kind: "unsupported", path: listed });
}

/** Which worktree leaves to list: every Git-visible one, or only untracked ones. */
export type WorktreeLeafSelection = "visible" | "untracked";

/**
 * The repository-relative paths of the Git-visible leaves at or below one
 * repository path, unique and sorted: tracked entries (including an index
 * entry deleted from the worktree) and untracked files Git does not ignore,
 * or only the untracked ones. Ignore rules are the repository's own (its
 * `.gitignore` files, `info/exclude` and `core.excludesFile`), and a tracked
 * file is never ignored, exactly as Git never ignores it. An empty directory
 * contributes nothing; non-regular files (FIFOs, sockets) are not Git-visible.
 * An untracked embedded repository lists as `dir/`, exactly as Git lists it.
 * It runs through `gitOutput`'s shared execution policy, so no
 * repository-configured hook runs and no ambient GIT_* variable reaches Git.
 */
export function worktreeVisibleLeafPaths(
  root: string,
  path: string,
  selection: WorktreeLeafSelection = "visible",
): readonly string[] {
  const listed = nulSeparatedGitPaths(root, [
    "--literal-pathspecs",
    "ls-files", ...(selection === "visible" ? ["--cached"] : []), "--others", "--exclude-standard", "-z", "--", path,
  ]);
  return Object.freeze([...new Set(listed)].sort(compareStrings));
}

/** Every Git-visible leaf at or below one repository path, sorted and typed
 *  by `lstat` (see `worktreeVisibleLeafPaths` for which leaves are visible). */
export function worktreeVisibleLeaves(root: string, path: string): readonly WorktreeLeaf[] {
  return Object.freeze(worktreeVisibleLeafPaths(root, path).map((leaf) => worktreeLeaf(root, leaf)));
}

/** The bytes Git stores for a present leaf: a file's content, or a symlink's
 *  target text (never followed). */
export function worktreeLeafBytes(leaf: Extract<WorktreeLeaf, { absolute: string }>): Buffer {
  return leaf.kind === "file" ? readFileSync(leaf.absolute) : readlinkSync(leaf.absolute, { encoding: "buffer" });
}

export type RevisionTreeLeaf = Readonly<{ mode: string; sha: string; path: string }>;

/** `git ls-tree -r -z` records are `<mode> SP <type> SP <sha> TAB <path>`. A
 *  lone file lists as itself; a directory lists every leaf below it. */
export function revisionTreeLeaves(root: string, revision: string, path: string): readonly RevisionTreeLeaf[] {
  return nulSeparatedGitPaths(root, ["ls-tree", "-r", "-z", revision, "--", path]).map((record) => {
    const match = /^(\d{6}) [a-z]+ ([0-9a-f]+)\t(.+)$/s.exec(record);
    if (match === null) {
      throw new Error(`Unparseable git ls-tree record for ${path} at ${revision}: ${JSON.stringify(record)}`);
    }
    return Object.freeze({ mode: match[1]!, sha: match[2]!, path: match[3]! });
  });
}

/**
 * The leaves a Review Packet reviews for one scoped directory: exactly the
 * worktree-visible leaves the reviewed-workspace observation and the
 * declared-artifact snapshot hash, plus every leaf at the packet base. The
 * base leaves are the one deliberate difference: the packet reviews a diff, so
 * a leaf deleted since the base must still show its deletion, while the
 * workspace observation hashes current bytes, where a deleted leaf has none.
 */
export function reviewedDirectoryLeafPaths(root: string, baseRevision: string, path: string): readonly string[] {
  const atBase = revisionTreeLeaves(root, baseRevision, path).map((leaf) => leaf.path);
  return Object.freeze([...new Set([...worktreeVisibleLeafPaths(root, path), ...atBase])].sort(compareStrings));
}

/** The paths that exist at a revision. Git has no empty trees, so a path
 *  exists there exactly when it has a leaf. */
export function presentAtRevision(root: string, revision: string, paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.filter((path) => revisionTreeLeaves(root, revision, path).length > 0));
}
