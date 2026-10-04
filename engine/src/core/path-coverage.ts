/**
 * Repository path coverage — the one rule for "is this path inside that
 * declared artifact". Dependency-free so the artifact baseline and the Review
 * Packet core can share it without importing each other.
 */

/** A declared artifact covers its own canonical path and, when it is a
 *  directory, every path below it. A file artifact has nothing below it, so
 *  for files this is exact equality. */
export function artifactCovers(artifact: string, path: string): boolean {
  return path === artifact || path.startsWith(`${artifact}/`);
}

/** A path is inside a declared scope when any scoped artifact covers it, so a
 *  location below a directory artifact is in scope. */
export function scopeCovers(scope: readonly string[], path: string): boolean {
  return scope.some((artifact) => artifactCovers(artifact, path));
}
