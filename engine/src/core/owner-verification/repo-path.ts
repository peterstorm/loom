/**
 * Repository-relative path arithmetic: the one rule both owner-verification
 * seams resolve paths by, so an alias target (`tsconfig-paths.ts`) and an
 * import specifier (`coverage.ts`) always name the same file. Pure, with no
 * `node:path`: paths are `/`-separated and relative to the repository root,
 * which "" names.
 */

/** The directory of a repository-relative file path; "" at the repository root. */
export const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** A repository-relative join that collapses `.`, `..` and empty segments; null when it escapes the repository. */
export const within = (directory: string, relative: string): string | null => {
  const segments = `${directory}/${relative}`.split("/").reduce<readonly string[] | null>((kept, segment) => {
    if (kept === null || segment === "" || segment === ".") return kept;
    if (segment === "..") return kept.length === 0 ? null : kept.slice(0, -1);
    return [...kept, segment];
  }, []);
  return segments === null ? null : segments.join("/");
};

/** A repository-relative path with `.`, `..` and empty segments collapsed; null when it escapes the repository. */
export const normalizeRepoPath = (path: string): string | null => within("", path);
