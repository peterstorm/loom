/**
 * The leaves Git can see below a repository path — in the worktree and at a
 * revision — for the artifact baseline and reviewed-workspace shells.
 *
 * ONE worktree enumerator serves both the declared-artifact snapshot hasher
 * and the reviewed-workspace reader, so they agree by construction on ignored
 * files, deleted index entries, symlinks and empty directories. Commands here
 * THROW on failure (the `utils/git.ts` helpers warn and return `undefined`);
 * both callers fail closed on a thrown observation.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { compareStrings } from "../core/ordering";

const GIT_OUTPUT_LIMIT = 100 * 1024 * 1024;

export function gitOutput(root: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_OUTPUT_LIMIT,
  });
}

export function nulSeparatedGitPaths(root: string, args: readonly string[]): readonly string[] {
  return gitOutput(root, args).toString("utf-8").split("\0").filter((path) => path !== "");
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

/**
 * Every Git-visible leaf at or below one repository path, sorted: tracked
 * entries (including an index entry deleted from the worktree) and untracked
 * files Git does not ignore. Ignore rules are the repository's own (its
 * `.gitignore` files, `info/exclude` and `core.excludesFile`), and a tracked
 * file is never ignored, exactly as Git never ignores it. An empty directory
 * contributes nothing; non-regular files (FIFOs, sockets) are not Git-visible.
 */
export function worktreeVisibleLeaves(root: string, path: string): readonly WorktreeLeaf[] {
  const listed = nulSeparatedGitPaths(root, [
    "-c", "core.fsmonitor=false", "--literal-pathspecs",
    "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", path,
  ]);
  return Object.freeze([...new Set(listed)].sort(compareStrings).map((leaf) => worktreeLeaf(root, leaf)));
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

/** The paths that exist at a revision. Git has no empty trees, so a path
 *  exists there exactly when it has a leaf. */
export function presentAtRevision(root: string, revision: string, paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.filter((path) => revisionTreeLeaves(root, revision, path).length > 0));
}
