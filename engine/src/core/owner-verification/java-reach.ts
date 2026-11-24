/**
 * Java's reach rule (issue #254): whether a Java matrix test reaches each due
 * family path. The TypeScript walk (`coverage.ts`) cannot apply here: Java has
 * no re-exports, so a file is reached by naming it, and naming it is decided
 * from the test's package, its imports and the names it uses — never by
 * walking edges.
 *
 * A due file is reached when the matrix test, written in Java, does one of:
 * - imports the file's class or a nested class of it (`import p.C;`,
 *   `import p.C.N;`) — a compiled class file is one unit, so importing a
 *   nested class loads the enclosing one;
 * - imports one of its static members or all of them
 *   (`import static p.C.m;`, `import static p.C.*;`), which loads `p.C`;
 * - imports its package as a wildcard and uses its simple name
 *   (`import p.*;` with `C` used);
 * - sits in the same package and uses its simple name (Java needs no import
 *   for that);
 * - writes its fully-qualified name without an import.
 *
 * A name the test uses is an identifier outside its `package` and `import`
 * declarations, or a dotted chain that spells the qualified name: both come
 * from the one seam (`parseJava`), so the rule has no second Java reader.
 *
 * Pure: the test's text and the due paths in, the due paths reached out. No
 * directory is listed and no file beyond the test is read, so the reach
 * cannot be widened by a package with a thousand classes.
 */

import { match } from "ts-pattern";
import { failure, success, type DomainResult } from "../orchestration-contract/identity";
import { javaFileIdentityOf, type JavaFileIdentity } from "./language";
import { parseJava, type JavaFile } from "./java-syntax";
import { normalizeRepoPath } from "./repo-path";
import type { OwnerUnparseable } from "./types";

export type JavaReachInput = Readonly<{
  /** The matrix test's repository-relative path: its package comes from it. */
  matrixTest: string;
  /** The matrix test's bytes, already read. */
  matrixTestText: string;
  /** The due family paths (the owner first). */
  due: readonly string[];
}>;

/** Whether `owner`'s file is loaded by the test's imports, package or qualified names. */
const reachedBy = (owner: JavaFileIdentity, test: JavaFile, testIdentity: JavaFileIdentity | null): boolean => {
  const ownerOrNested = (name: string): boolean => name === owner.fqn || name.startsWith(`${owner.fqn}.`);
  const wildcardImports = test.imports.some(
    (entry) => entry.kind === "class-wildcard" && entry.packageName === owner.packageName,
  );
  const samePackage = testIdentity !== null && testIdentity.packageName === owner.packageName;
  if ((samePackage || wildcardImports) && test.identifiers.has(owner.simpleName)) return true;
  if ([...test.qualifiedNames].some(ownerOrNested)) return true;
  return test.imports.some((entry) =>
    match(entry)
      .with({ kind: "class" }, ({ name }) => ownerOrNested(name))
      .with({ kind: "static-member" }, ({ owner: named }) => ownerOrNested(named))
      .with({ kind: "static-wildcard" }, ({ owner: named }) => ownerOrNested(named))
      .with({ kind: "class-wildcard" }, () => false)
      .exhaustive());
};

/**
 * The due paths the matrix test reaches, in the order given. A due path whose
 * language is not Java is never reached here; the coverage decision refuses a
 * mixed family before asking (`language.ts`).
 */
export const javaReachedDue = ({ matrixTest, matrixTestText, due }: JavaReachInput): DomainResult<ReadonlySet<string>, OwnerUnparseable> => {
  const parsed = parseJava(matrixTestText);
  if (!parsed.ok) return failure({ kind: "owner-unparseable", diagnostics: parsed.error.diagnostics });
  const test = parsed.value;
  const testIdentity = javaFileIdentityOf(matrixTest);
  const reached = new Set<string>();
  for (const path of due) {
    const owner = javaFileIdentityOf(path);
    if (owner === null || !reachedBy(owner, test, testIdentity)) continue;
    reached.add(normalizeRepoPath(path) ?? path);
  }
  return success(reached as ReadonlySet<string>);
};
