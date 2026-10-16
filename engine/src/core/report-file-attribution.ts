/**
 * The one reported-file to declared-file attribution (INV-5). A structured
 * report names a test file by an identity of its own: a path relative to the
 * runner's cwd (Vitest JUnit `classname`), an absolute path (Vitest JSON
 * `testResults[].name`), or a JVM class (Surefire). This module maps that
 * identity to one declared repository path, or to none, for the Wave Gate's
 * acceptance attribution, the I6 judge and the I7 failure renderer alike.
 *
 * A neutral leaf: it imports only the path-normalization leaf, so the
 * acceptance-contract barrel can import it without a cycle (AD-3).
 */

import { normalizePlanPath } from "./plan-path-match";

const JVM_CLASS = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/;

/**
 * An absolute identity as a repository-relative path, or null when it is
 * absolute but not strictly inside `repositoryRoot` (or no root is known). A
 * relative identity is returned unchanged.
 */
function repositoryRelative(reported: string, repositoryRoot: string | null): string | null {
  if (!ABSOLUTE.test(reported)) return reported;
  if (repositoryRoot === null) return null;
  const root = normalizePlanPath(repositoryRoot).replace(/\/+$/, "");
  const prefix = `${root}/`;
  return reported.startsWith(prefix) && reported.length > prefix.length ? reported.slice(prefix.length) : null;
}

/**
 * The declared repository path a reported file identity belongs to, or null.
 *
 * An absolute identity is first made relative to `repositoryRoot` (null when
 * no root is known, which leaves absolute identities unattributed). Then an
 * exact path wins; otherwise a whole-segment suffix match (the runner's cwd
 * lies beneath the repository root) or a JVM class match (`com.acme.FooTest`,
 * or `com.acme.FooTest$Nested`, to `…/com/acme/FooTest.java|.kt`) attributes
 * it only when exactly one declared file matches. An ambiguous identity is
 * left unattributed, which fails closed rather than crediting the wrong file.
 * Matching is by whole path segments, never by suffix text.
 */
export function attributeReportedFile(
  declared: readonly string[],
  reported: string,
  repositoryRoot: string | null,
): string | null {
  const relative = repositoryRelative(normalizePlanPath(reported), repositoryRoot);
  if (relative === null) return null;
  const exact = declared.find((file) => normalizePlanPath(file) === relative);
  if (exact !== undefined) return exact;
  const jvmClass = !relative.includes("/") && JVM_CLASS.test(relative)
    ? relative.split("$")[0]!.replace(/\./g, "/")
    : null;
  const matches = declared.filter((file) => {
    const path = normalizePlanPath(file);
    if (path.endsWith(`/${relative}`)) return true;
    if (jvmClass === null) return false;
    const withoutExtension = path.replace(/\.[^./]+$/, "");
    return withoutExtension === jvmClass || withoutExtension.endsWith(`/${jvmClass}`);
  });
  return matches.length === 1 ? matches[0]! : null;
}
