/**
 * The filesystem adapter behind `ProjectSnapshot` — the shell half of
 * `no-dangling-doc-reference`.
 *
 * In a git repository the snapshot is the tree as every clone has it: git's
 * files, tracked or not yet added, never an ignored or a deleted one. A
 * runtime directory such as `.claude/state/` exists on one machine and not on
 * another or in CI, so a reference that resolved against it, or a word an
 * ignored file held, would pass on one machine and fail on the next. Outside
 * a git repository the snapshot falls back to the project walk and `stat`.
 *
 * `files()` holds the source the corpus reads: the paths beneath a directory
 * that never holds source (`.claude/`, `node_modules/`) are left out of it,
 * as the walk leaves them out. `entryAt` still answers for them, so a tracked
 * `.claude/plans/` plan resolves. Nothing is listed before the index's first
 * question, so a lint run that resolves nothing never asks git.
 *
 * A path that names nothing is null: it is absent, or it runs through a file
 * (`ENOTDIR` — in a git worktree `.git` is a file, so `.git/index` is such a
 * path). A directory is null as text. Any other failure propagates, and the
 * lint run fails closed.
 */

import { readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import { match } from "ts-pattern";
import { spawnGit } from "../../utils/git-execution-policy";
import { isNeverSourceDirectory } from "../project-scope";
import { walkProjectFiles } from "../project-walk";
import { referenceIndex } from "./reference-index";
import type { EntryKind, ProjectSnapshot, ReferenceIndex } from "./types";

/** The codes that say a path names nothing: absent, or beneath a file. */
const NAMES_NOTHING: ReadonlySet<string | undefined> = new Set(["ENOENT", "ENOTDIR"]);

/** …and, for reading text, a directory too. */
const UNREADABLE_AS_TEXT: ReadonlySet<string | undefined> = new Set([...NAMES_NOTHING, "EISDIR"]);

/** The attempt's answer, or null when it fails with one of `codes`; any other failure propagates. */
function nullOn<T>(codes: ReadonlySet<string | undefined>, attempt: () => T): T | null {
  try {
    return attempt();
  } catch (error) {
    if (codes.has((error as NodeJS.ErrnoException).code)) return null;
    throw error;
  }
}

/** The project as git lists it: every file and every directory above one. */
type GitTree = Readonly<{ files: ReadonlySet<string>; directories: ReadonlySet<string> }>;

/** The stdout budget of one listing: a large monorepo's paths, NUL-separated. */
const LISTING_LIMIT = 256 * 1024 * 1024;

/**
 * One `git ls-files` listing, NUL-separated and relative to `root`, through
 * the engine's one policy-bound Git seam. Null when there is no git to ask or
 * `root` is in no repository, so the snapshot falls back to the filesystem.
 * Any other failure (a corrupt repository, a refused ownership check) throws:
 * the lint fails closed rather than silently reading the disk instead.
 */
function gitListing(root: string, args: readonly string[]): readonly string[] | null {
  const outcome = spawnGit(["ls-files", "-z", ...args], { cwd: root, maxBuffer: LISTING_LIMIT });
  const failed = (detail: string): never => {
    throw new Error(`git ls-files failed in ${root}: ${detail}`);
  };
  return match(outcome)
    .with({ kind: "spawn-failed" }, () => null)
    .with({ kind: "exited", status: 0 }, ({ stdout }) => stdout.toString("utf8").split("\0").filter((path) => path !== ""))
    .with({ kind: "exited" }, ({ status, stderr }) => {
      const message = stderr.toString("utf8").trim();
      return status === 128 && message.includes("not a git repository") ? null : failed(`exit ${status}: ${message}`);
    })
    .with({ kind: "faulted" }, ({ message }) => failed(message))
    .with({ kind: "timed-out" }, () => failed("timed out"))
    .with({ kind: "over-budget" }, ({ maxBuffer }) => failed(`listing exceeded ${maxBuffer} bytes`))
    .with({ kind: "signalled" }, ({ signal }) => failed(`killed by ${signal}`))
    .exhaustive();
}

/** The directories above a project-relative file, nearest first; never the root. */
function directoriesAbove(file: string): readonly string[] {
  const parent = posix.dirname(file);
  return parent === "." ? [] : [parent, ...directoriesAbove(parent)];
}

/**
 * The tree git would commit at `root`: its files, tracked or untracked but not
 * ignored, minus the tracked ones deleted from the working tree. Null outside
 * a git repository.
 */
function gitTree(root: string): GitTree | null {
  const present = gitListing(root, ["--cached", "--others", "--exclude-standard"]);
  const deleted = gitListing(root, ["--deleted"]);
  if (present === null || deleted === null) return null;
  const gone = new Set(deleted);
  const files = new Set(present.filter((file) => !gone.has(file)));
  return { files, directories: new Set([...files].flatMap(directoriesAbove)) };
}

/** Does a project-relative file sit beneath a directory that never holds source? */
const beneathNeverSource = (file: string): boolean => directoriesAbove(file).some((directory) => isNeverSourceDirectory(posix.basename(directory)));

/** The snapshot of the project rooted at `projectRoot`. */
export function fsProjectSnapshot(projectRoot: string): ProjectSnapshot {
  let tree: { readonly current: GitTree | null } | undefined;
  const git = (): GitTree | null => (tree ??= { current: gitTree(projectRoot) }).current;
  let files: readonly string[] | undefined;

  const statEntry = (path: string): EntryKind | null => {
    const stat = nullOn(NAMES_NOTHING, () => statSync(join(projectRoot, path)));
    if (stat === null) return null;
    if (stat.isDirectory()) return "directory";
    return stat.isFile() ? "file" : null;
  };

  return Object.freeze({
    files: () => {
      files ??= ((): readonly string[] => {
        const listed = git();
        if (listed !== null) return [...listed.files].filter((file) => !beneathNeverSource(file)).sort();
        return walkProjectFiles(projectRoot, () => true)
          .map(({ absolute }) => relative(projectRoot, absolute).split(sep).join("/"));
      })();
      return files;
    },
    entryAt: (path: string): EntryKind | null => {
      const listed = git();
      if (listed === null) return statEntry(path);
      if (listed.files.has(path)) return "file";
      return listed.directories.has(path) ? "directory" : null;
    },
    read: (path: string): string | null =>
      nullOn(UNREADABLE_AS_TEXT, () => readFileSync(join(projectRoot, path), "utf-8")),
  });
}

/** The reference index of the project rooted at `projectRoot`, read from disk on first use. */
export const projectReferenceIndex = (projectRoot: string): ReferenceIndex =>
  referenceIndex(fsProjectSnapshot(projectRoot));
