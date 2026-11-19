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
const JVM_SIMPLE_CLASS = /^[A-Za-z_$][\w$]*$/;
const JVM_SOURCE = /\.(?:java|kt|groovy|scala)$/;
const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/;

/**
 * An absolute path as a repository-relative one, or null when it is absolute
 * but not strictly inside `repositoryRoot` (or no root is known). A relative
 * path is returned unchanged. `reported` must already be normalized
 * (`normalizePlanPath`). This is the one absolute-to-relative rule: the I6
 * judge maps a written FileWrite path through it too.
 */
export function repositoryRelative(reported: string, repositoryRoot: string | null): string | null {
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
 * it only when exactly one declared file matches. A simple JVM class name
 * (FooTest, or FooTest$Nested) is what Surefire writes for an engine whose
 * class reporting name is not qualified (jqwik); it matches a declared JVM
 * source file (.java, .kt, .groovy, .scala) named FooTest, under the same
 * exactly-one rule. An ambiguous identity is left unattributed,
 * which fails closed rather than crediting the wrong file. Matching is by
 * whole path segments, never by suffix text.
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
  const jvmClass = reportedJvmClass(relative);
  const matches = declared.filter((file) => {
    const path = normalizePlanPath(file);
    return path.endsWith(`/${relative}`) || (jvmClass !== null && isJvmClassSource(path, jvmClass));
  });
  return matches.length === 1 ? matches[0] : null;
}

/** A reported JVM class, outer class only: qualified, as its package path
 *  (com/acme/FooTest), or simple, as its bare name (FooTest). */
type ReportedJvmClass =
  | Readonly<{ kind: "qualified"; packagePath: string }>
  | Readonly<{ kind: "simple"; name: string }>;

/** The JVM class a reported identity names, or null for any other identity. */
function reportedJvmClass(relative: string): ReportedJvmClass | null {
  if (relative.includes("/")) return null;
  const outer = relative.split("$")[0];
  if (JVM_CLASS.test(relative)) return { kind: "qualified", packagePath: outer.replace(/\./g, "/") };
  return JVM_SIMPLE_CLASS.test(relative) && outer !== "" ? { kind: "simple", name: outer } : null;
}

/** Whether a declared path is the source file of a reported JVM class. A
 *  simple name matches only a JVM source file, so a bare word never credits a
 *  file of another language whose stem happens to equal it. */
function isJvmClassSource(path: string, jvmClass: ReportedJvmClass): boolean {
  const withoutExtension = path.replace(/\.[^./]+$/, "");
  const classPath = jvmClass.kind === "qualified" ? jvmClass.packagePath : jvmClass.name;
  if (jvmClass.kind === "simple" && !JVM_SOURCE.test(path)) return false;
  return withoutExtension === classPath || withoutExtension.endsWith(`/${classPath}`);
}
