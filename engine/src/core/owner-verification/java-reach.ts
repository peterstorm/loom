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
 * - imports its member types (`import p.C.*;`), which names `p.C` itself;
 * - imports its package as a wildcard and uses its simple name
 *   (`import p.*;` with `C` used);
 * - sits in the same package and uses its simple name (Java needs no import
 *   for that), where the test's package is the one it declares, or the one its
 *   path names when it declares none;
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
import type { JavaFamilyPath, JavaFileIdentity } from "./language";
import { parseJava, type JavaFile } from "./java-syntax";
import { normalizeRepoPath } from "./repo-path";
import type { OwnerUnparseable } from "./types";

/**
 * The reach rule's input. Every path is a Java family path, identity included
 * (`obligationLanguageOf` reads them), so a path this rule cannot read cannot
 * be handed to it.
 */
export type JavaReachInput = Readonly<{
  /** The matrix test: its package comes from its declaration, else its path. */
  matrixTest: JavaFamilyPath;
  /** The matrix test's bytes, already read. */
  matrixTestText: string;
  /** The due family paths (the owner first). */
  due: readonly JavaFamilyPath[];
}>;

/**
 * The package the test compiles into: the `package` declaration it writes,
 * else the directory its path names. javac reads the declaration, so a file
 * that sits in one directory and declares another compiles into the declared
 * one, and its same-package reach follows that.
 */
const testPackageOf = (test: JavaFile, testIdentity: JavaFileIdentity): string => test.packageName ?? testIdentity.packageName;

/** Whether `owner`'s file is loaded by the test's imports, package or qualified names. */
const reachedBy = (owner: JavaFileIdentity, test: JavaFile, testPackage: string): boolean => {
  const ownerOrNested = (name: string): boolean => name === owner.fqn || name.startsWith(`${owner.fqn}.`);
  const wildcardImports = test.imports.some(
    (entry) => entry.kind === "class-wildcard" && entry.packageName === owner.packageName,
  );
  const samePackage = testPackage === owner.packageName;
  if ((samePackage || wildcardImports) && test.identifiers.has(owner.simpleName)) return true;
  if ([...test.qualifiedNames].some(ownerOrNested)) return true;
  return test.imports.some((entry) =>
    match(entry)
      .with({ kind: "class" }, ({ name }) => ownerOrNested(name))
      .with({ kind: "static-member" }, ({ owner: named }) => ownerOrNested(named))
      .with({ kind: "static-wildcard" }, ({ owner: named }) => ownerOrNested(named))
      // `import p.C.*;` imports C's member types: it names the class file it loads.
      .with({ kind: "class-wildcard" }, ({ packageName }) => ownerOrNested(packageName))
      .exhaustive());
};

/**
 * The due paths the matrix test reaches, in the order given, each normalized
 * as `decideCoverage` looks it up.
 */
export const javaReachedDue = ({ matrixTest, matrixTestText, due }: JavaReachInput): DomainResult<ReadonlySet<string>, OwnerUnparseable> => {
  const parsed = parseJava(matrixTestText);
  if (!parsed.ok) return failure({ kind: "owner-unparseable", diagnostics: parsed.error.diagnostics });
  const test = parsed.value;
  const testPackage = testPackageOf(test, matrixTest.identity);
  const reached = new Set<string>();
  for (const { path, identity } of due) {
    if (reachedBy(identity, test, testPackage)) reached.add(normalizeRepoPath(path) ?? path);
  }
  return success(reached);
};
