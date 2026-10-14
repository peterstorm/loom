/**
 * The one rule for matching a path a plan declares against a path a Task's
 * `file_list` declares. A leaf: it knows paths, not plan shapes, so every
 * module that matches plan paths — plan-binding validation, the Wave Gate's
 * lifecycle check, the implementation brief, Acceptance Contracts — shares it
 * without importing the plan model.
 */

/** Forward slashes, no leading `./`. */
export function normalizePlanPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Exact equality of two plan paths after normalization — for a path that is
 *  read from the repository as written, where a suffix match would name a
 *  different file. */
export function samePlanPath(a: string, b: string): boolean {
  return normalizePlanPath(a) === normalizePlanPath(b);
}

/** Whether a normalized plan path stays inside the repository: relative, with
 *  no `..` segment, so `join(root, path)` cannot leave the root. */
export function isRepoRelativePlanPath(p: string): boolean {
  const normalized = normalizePlanPath(p);
  return normalized !== "" && !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split("/").includes("..");
}

/**
 * One-directional, suffix-tolerant match: the task path may be an absolute or
 * deeper form of the declared plan path, never the reverse — a bare-basename
 * file_list entry must not satisfy a fully-pathed declaration. A declared
 * path with no directory segment only matches exactly.
 */
export function pathsMatch(taskFile: string, declared: string): boolean {
  const nt = normalizePlanPath(taskFile);
  const nd = normalizePlanPath(declared);
  if (nt === nd) return true;
  if (!nd.includes("/")) return false;
  return nt.endsWith(`/${nd}`);
}
