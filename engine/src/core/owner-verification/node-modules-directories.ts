/**
 * Which directories' `node_modules` the isolated worktree shares: the
 * repository root's, the runner cwd's, and that of each directory Git lists an
 * ignored entry under, read from
 * `git ls-files --others --ignored --exclude-standard --directory -z`.
 * Pure: the shell (`orchestration/owner-mutation-workspace.ts`) runs Git and
 * symlinks each named directory's `node_modules` from the real workspace.
 *
 * A JS workspace monorepo (Bun, npm, Yarn, pnpm) installs a package's own
 * dependencies beside it, in `packages/<pkg>/node_modules`. A matrix test
 * under that package resolves them there, so a copy sharing only the root's
 * cannot load it (issue #265).
 *
 * Git names a wholly ignored `node_modules` by one trailing-slash entry; one
 * the checkout partly tracks it names entry by entry beneath it. Either way
 * the holder is the directory of the outermost `node_modules` segment on the
 * entry's directory part, so a nested `node_modules` is carried by its outer
 * one's link, never linked through it. A `node_modules` inside a wholly
 * ignored parent directory (a build output) is not listed, and not shared.
 */

import { failure, success, type DomainResult } from "../orchestration-contract/identity";
import type { RepositoryRelativePath } from "../completion-suite";
import { compareStrings } from "../ordering";
import { parseReviewPath } from "../review-packet";

const NODE_MODULES = "node_modules";

/**
 * The directory holding the outermost `node_modules` among `path`'s directory
 * segments ("." for the root), or null when it passes through none. A file
 * entry's last segment is its name, not a directory, so a file named
 * `node_modules` holds nothing.
 */
function outermostHolder(path: string, isDirectory: boolean): string | null {
  const segments = path.split("/");
  const directories = isDirectory ? segments : segments.slice(0, -1);
  const index = directories.indexOf(NODE_MODULES);
  if (index === -1) return null;
  return index === 0 ? "." : segments.slice(0, index).join("/");
}

/** The holder an ignored-listing entry names, or null when it is under no `node_modules`. */
function holderOfEntry(entry: string): string | null {
  const isDirectory = entry.endsWith("/");
  return outermostHolder(isDirectory ? entry.slice(0, -1) : entry, isDirectory);
}

/**
 * Every directory whose `node_modules` the copy shares, sorted and distinct:
 * the root, the runner cwd (or the holder of the `node_modules` it lies in),
 * and each holder the ignored listing names. Refused when Git names a holder
 * whose path is not canonical and repository-relative.
 */
export function sharedNodeModulesDirectories(
  listing: string,
  runnerCwd: RepositoryRelativePath,
): DomainResult<readonly RepositoryRelativePath[], string> {
  const holders = new Set<string>([".", runnerCwd === "." ? "." : outermostHolder(runnerCwd, true) ?? runnerCwd]);
  for (const entry of listing.split("\0")) {
    const holder = holderOfEntry(entry);
    if (holder !== null) holders.add(holder);
  }
  const directories: RepositoryRelativePath[] = [];
  for (const holder of [...holders].sort(compareStrings)) {
    if (holder === ".") {
      directories.push(".");
      continue;
    }
    const parsed = parseReviewPath(holder, "node_modules directory");
    if (!parsed.ok) return failure(`git ls-files named an unusable node_modules directory ${JSON.stringify(holder)}: ${parsed.errors.join("; ")}`);
    directories.push(parsed.value);
  }
  return success(Object.freeze(directories));
}
