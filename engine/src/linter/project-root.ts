/**
 * Project discovery: which project a directory sits in. The one answer to
 * "which project is this" — the edit hooks ask it from the edited file's
 * directory, `lint-project`, `helper validate-lint-rules` and the lint-coverage
 * reminder from the working directory, so a shell that has wandered into
 * `engine/` — or into another checkout — never lints a file under the wrong
 * project's rules.
 *
 * Pure: the caller owns the presence probe, which receives absolute paths.
 * The engine's shell resolver is `projectAt` in `config.ts`.
 */

import { dirname, join } from "node:path";
import { projectRulesLayout } from "./programmatic/config";

/** An absolute directory and every directory above it, nearest first. */
const selfAndAncestors = (directory: string): readonly string[] =>
  dirname(directory) === directory ? [directory] : [directory, ...selfAndAncestors(dirname(directory))];

/**
 * The root of the project an absolute directory sits in: the nearest
 * directory, itself or above, that holds a rules layout; else the nearest that
 * holds `.git` (a repository with no project rules); else null.
 */
export function findProjectRoot(directory: string, isPresent: (path: string) => boolean): string | null {
  const chain = selfAndAncestors(directory);
  return chain.find((dir) => projectRulesLayout((layout) => isPresent(join(dir, layout))) !== null)
    ?? chain.find((dir) => isPresent(join(dir, ".git")))
    ?? null;
}
