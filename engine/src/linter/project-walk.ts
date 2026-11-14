/**
 * The project walk — the files beneath a directory, BEFORE exclusions. A
 * shell: it reads directories. Which names are lintable and which directories
 * never hold source are `project-scope.ts`'s pure answers.
 *
 * One walk for `scripts/lint-project.ts`, the clone corpus and the
 * doc-reference snapshot, so "the files the linter reads", "the files a copy
 * can be a copy of" and "the files a doc can name" are the same tree.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLintableName, isNeverSourceDirectory } from "./project-scope";

/** One file as the walk saw it: where it is, and the size and modification time that identify its bytes. */
export type WalkedFile = Readonly<{ absolute: string; size: number; mtimeMs: number }>;

/**
 * Every file beneath `dir` whose name `accept` takes, sorted by path.
 * Directories that never hold project source (`NEVER_SOURCE_DIRECTORIES`) are
 * not entered, and an entry that vanishes between the listing and its stat is
 * skipped: another writer removed it, so it is not part of the tree.
 */
export function walkProjectFiles(dir: string, accept: (name: string) => boolean): readonly WalkedFile[] {
  return readdirSync(dir).sort().flatMap((entry): readonly WalkedFile[] => {
    if (isNeverSourceDirectory(entry)) return [];
    const absolute = join(dir, entry);
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (stat === undefined) return [];
    if (stat.isDirectory()) return walkProjectFiles(absolute, accept);
    return stat.isFile() && accept(entry) ? [{ absolute, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
  });
}

/** Every lintable file beneath `dir`, sorted by path. */
export const walkLintableFiles = (dir: string): readonly WalkedFile[] => walkProjectFiles(dir, isLintableName);
