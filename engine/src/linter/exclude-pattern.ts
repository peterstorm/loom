/**
 * The one matcher for a rule's exclusion list — a regex rule's
 * `excludePatterns` and `maxFunctionLines`' `excludeFromMaxLines`: which files
 * a single rule does not read. (The purity and boundary rules scope by module
 * entries, a different grammar with its own matcher.)
 *
 * Two forms, distinguished by a trailing slash, and nothing else:
 *
 *   `".test.ts"`        a FILE-SUFFIX   — every path ending with those bytes
 *   `"src/infra/"`      a DIRECTORY     — every path with that segment sequence
 *
 * The directory form exists because a rule scoped to a layer (`"apps/"`,
 * `"packages/framework/src/types/"`) has no way to express "everything beneath
 * here" as a suffix: a file path never ends with a directory name followed by a
 * slash. The Java setup reference has always told authors to write `/infra/`,
 * which matched nothing under the suffix-only rule — the docs described this
 * behaviour before the code did.
 *
 * The directory form matches at a SEGMENT boundary: `"/src/infra/"` cannot be
 * satisfied by `/src/infrastructure/Db.java`. Pattern and path are both
 * anchored by a leading slash before they are compared, so `src/infra/` and
 * `/src/infra/` exclude the same files, and a relative path
 * (`src/infra/Db.java`) is excluded exactly as its absolute spelling is.
 *
 * Paths are compared after normalizing separators, so a Windows checkout
 * matches the same patterns as a POSIX one. A pattern that is empty, or that is
 * a bare `/`, matches nothing rather than everything: an exclusion list entry
 * that silently excluded the whole tree would make a rule look enforced while
 * it read nothing.
 */
export function matchesExcludePattern(filePath: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  const normalizedPath = filePath.replace(/\\/g, "/");

  if (!pattern.endsWith("/")) return normalizedPath.endsWith(pattern);

  const directory = withLeadingSlash(pattern);
  return directory !== "/" && withLeadingSlash(normalizedPath).includes(directory);
}

const withLeadingSlash = (path: string): string => (path.startsWith("/") ? path : `/${path}`);

/** Does any pattern exclude this file? False for an empty list. */
export function matchesAnyExcludePattern(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesExcludePattern(filePath, pattern));
}
