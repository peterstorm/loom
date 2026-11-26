/**
 * Which directories' `node_modules` the isolated worktree shares, read from
 * `git ls-files --others --ignored --exclude-standard --directory -z`.
 * Pure: the shell (`orchestration/owner-mutation-workspace.ts`) runs Git and
 * symlinks the `node_modules` of each directory this names from the real
 * workspace.
 *
 * A JS workspace monorepo (Bun, npm, Yarn, pnpm) installs a package's own
 * dependencies beside it, in `packages/<pkg>/node_modules`. A matrix test
 * under that package resolves them there, so a copy sharing only the root's
 * cannot load it (issue #265).
 *
 * With `--directory`, Git names a wholly ignored directory by one
 * trailing-slash entry and does not descend into it, so the listing holds one
 * entry per installed tree. An entry beneath another named `node_modules` is
 * dropped: the outer link already carries it, and linking through that link
 * would reach into the real workspace.
 */

import { failure, success, type DomainResult } from "../orchestration-contract/identity";
import type { RepositoryRelativePath } from "../completion-suite";
import { compareStrings } from "../ordering";
import { parseReviewPath } from "../review-packet";

const NODE_MODULES = "node_modules";

/** The directory an entry's `node_modules` sits in ("." for the root), or null when the entry is not a `node_modules` directory. */
function holderOf(entry: string): string | null {
  if (!entry.endsWith("/")) return null;
  const segments = entry.slice(0, -1).split("/");
  if (segments.at(-1) !== NODE_MODULES) return null;
  return segments.length === 1 ? "." : segments.slice(0, -1).join("/");
}

const nodeModulesOf = (holder: string): string => (holder === "." ? NODE_MODULES : `${holder}/${NODE_MODULES}`);

/** Whether `holder` lies inside another named holder's `node_modules`. */
const beneathAnother = (holder: string, holders: ReadonlySet<string>): boolean =>
  [...holders].some((other) => other !== holder && holder.startsWith(`${nodeModulesOf(other)}/`));

/**
 * Every directory holding an ignored `node_modules`, sorted and distinct.
 * Refused when Git names one whose path is not canonical and
 * repository-relative.
 */
export function ignoredNodeModulesDirectories(output: string): DomainResult<readonly RepositoryRelativePath[], string> {
  const holders = new Set<string>();
  for (const entry of output.split("\0")) {
    const holder = holderOf(entry);
    if (holder !== null) holders.add(holder);
  }
  const directories: RepositoryRelativePath[] = [];
  for (const holder of [...holders].sort(compareStrings)) {
    if (beneathAnother(holder, holders)) continue;
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
