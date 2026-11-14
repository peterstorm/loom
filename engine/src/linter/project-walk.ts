/**
 * The project walk — the files beneath a directory, BEFORE exclusions. A
 * shell: it reads directories. Which names are lintable and which directories
 * never hold source are `project-scope.ts`'s pure answers.
 *
 * One walk for `scripts/lint-project.ts` (`lintedProjectFiles`), the clone
 * corpus and the doc-reference snapshot outside git, so "the files the linter
 * reads", "the files a copy can be a copy of" and "the files a doc can name"
 * are the same tree.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProgrammaticConfig } from "./programmatic/config";
import { isLintableName, isNeverSourceDirectory, walkedBesides } from "./project-scope";

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

const absolutes = (files: readonly WalkedFile[]): readonly string[] => files.map(({ absolute }) => absolute);

/**
 * The tree `lint-project` reads, BEFORE exclusions: every lintable file of the
 * project, plus each path the config governs beneath a directory the walk
 * never enters (`walkedBesides`: a project's `.claude/plans/`), walked when it
 * is a directory, so a governed plan is linted in the full tier and not only
 * when it is edited. Absolute and sorted; a besides path that does not exist
 * adds nothing. With no config, the walk alone.
 *
 * The one definition: `lint-project` and Loom's baseline guard both read it,
 * so the guard sees exactly the tree the linter does.
 */
export function lintedProjectFiles(root: string, config: ProgrammaticConfig | null): readonly string[] {
  const walked = absolutes(walkLintableFiles(root));
  const besides = config === null ? [] : walkedBesides(config).flatMap((path) => {
    const absolute = join(root, path);
    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (stat === undefined) return [];
    return stat.isDirectory() ? absolutes(walkLintableFiles(absolute)) : [absolute];
  });
  return besides.length === 0 ? walked : [...new Set([...walked, ...besides])].sort();
}
