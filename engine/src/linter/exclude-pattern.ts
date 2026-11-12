/**
 * The ONE matcher for a rule's `excludePatterns` — which files a single rule
 * does not read.
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
 * satisfied by `/src/infrastructure/Db.java`. A project-relative directory
 * pattern with no leading slash is anchored the same way, by prefixing one, so
 * the two spellings cannot disagree about what they exclude.
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

  const directory = pattern.startsWith("/") ? pattern : `/${pattern}`;
  return directory !== "/" && normalizedPath.includes(directory);
}

/** Does any pattern exclude this file? False for an empty list. */
export function matchesAnyExcludePattern(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesExcludePattern(filePath, pattern));
}
