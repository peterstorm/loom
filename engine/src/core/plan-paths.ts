/**
 * How a path a plan declares (a lifecycle machine file, an invariant's owner,
 * siblings and matrix test) is matched against the paths Tasks declare in
 * their `file_list`. One rule, shared by plan-binding validation, the Wave
 * Gate's lifecycle artifact check and the implementation brief, so a path the
 * validator accepted is the same path the brief tells a Task it changes.
 */

/** Forward slashes, no leading `./`. */
export function normalizePlanPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
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
