/**
 * The filesystem adapter behind `ProjectSnapshot` — the shell half of
 * `no-dangling-doc-reference`.
 *
 * It lists the project once (the project walk, every file name accepted),
 * answers "what is at this path" with one `stat` — also beneath the
 * directories the walk never enters, so `.claude/plans/` resolves — and reads
 * a file's text when the index asks for it. Nothing is read before the index's
 * first question, so a lint run that resolves nothing never walks.
 *
 * A path the snapshot cannot read because it is absent, or a directory, is
 * null; any other failure propagates, and the lint run fails closed.
 */

import { readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { walkProjectFiles } from "../project-walk";
import { referenceIndex } from "./reference-index";
import type { EntryKind, ProjectSnapshot, ReferenceIndex } from "./types";

const UNREADABLE_AS_TEXT: ReadonlySet<string | undefined> = new Set(["ENOENT", "EISDIR", "ENOTDIR"]);

/** The snapshot of the project rooted at `projectRoot`. */
export function fsProjectSnapshot(projectRoot: string): ProjectSnapshot {
  let files: readonly string[] | undefined;
  return Object.freeze({
    files: () => {
      files ??= walkProjectFiles(projectRoot, () => true)
        .map(({ absolute }) => relative(projectRoot, absolute).split(sep).join("/"));
      return files;
    },
    entryAt: (path: string): EntryKind | null => {
      const stat = statSync(join(projectRoot, path), { throwIfNoEntry: false });
      if (stat === undefined) return null;
      if (stat.isDirectory()) return "directory";
      return stat.isFile() ? "file" : null;
    },
    read: (path: string): string | null => {
      try {
        return readFileSync(join(projectRoot, path), "utf-8");
      } catch (error) {
        if (UNREADABLE_AS_TEXT.has((error as NodeJS.ErrnoException).code)) return null;
        throw error;
      }
    },
  });
}

/** The reference index of the project rooted at `projectRoot`, read from disk on first use. */
export const projectReferenceIndex = (projectRoot: string): ReferenceIndex =>
  referenceIndex(fsProjectSnapshot(projectRoot));
