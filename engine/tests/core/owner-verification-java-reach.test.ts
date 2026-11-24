/**
 * Java's reach rule (issue #254): whether a Java matrix test reaches each due
 * family path. Java has no re-exports, so reach is decided by naming — the
 * test's package, its imports and the names it uses — and this suite pins each
 * way a test can name a file. Every path it is handed is a Java family path,
 * identity included, so a path it cannot read cannot reach it.
 */

import { describe, expect, it } from "vitest";
import { javaReachedDue } from "../../src/core/owner-verification/java-reach";
import { javaFileIdentityOf, type JavaFamilyPath } from "../../src/core/owner-verification/language";
import type { NonEmpty } from "../../src/core/orchestration-contract";

const OWNER = "src/main/java/p/q/C.java";
const SIBLING = "src/main/java/p/q/S.java";
/** A due family: the owner first, then the sibling. */
const DUE: NonEmpty<string> = [OWNER, SIBLING];

const MATRIX = "src/test/java/t/Matrix.java";

/** A Java family path as `obligationLanguageOf` reads it. */
const javaPath = (path: string): JavaFamilyPath => {
  const identity = javaFileIdentityOf(path);
  if (identity === null) throw new Error(`fixture path is not a Java source-root path: ${path}`);
  return { path, identity };
};

/** A Java test in package `t` with the given imports and body. */
const testIn = (body: string, imports: readonly string[] = [], packageName = "t"): string =>
  [`package ${packageName};`, "", ...imports, "", "final class Matrix {", "  void matrix() {", ...body.split("\n").map((line) => `    ${line}`), "  }", "}", ""].join("\n");

const reached = (matrixTestText: string, matrixTest = MATRIX, due: NonEmpty<string> = DUE): readonly string[] => {
  const result = javaReachedDue({ matrixTest: javaPath(matrixTest), matrixTestText, due: due.map(javaPath) });
  if (!result.ok) throw new Error(`the matrix test was refused: ${result.error.diagnostics.join("; ")}`);
  return [...result.value];
};

describe("javaReachedDue", () => {
  it("reaches a file its class is imported by, and a sibling imported beside it", () => {
    expect(reached(testIn('C.of("x");', ["import p.q.C;", "import p.q.S;"]))).toEqual([OWNER, SIBLING]);
  });

  it("reaches the enclosing file when a nested class is imported", () => {
    expect(reached(testIn("C.Nested.of();", ["import p.q.C.Nested;"]))).toEqual([OWNER]);
  });

  it("reaches a file whose static member, or all of whose static members, are imported", () => {
    expect(reached(testIn("of();", ["import static p.q.C.of;"]))).toEqual([OWNER]);
    expect(reached(testIn("new Object();", ["import static p.q.C.*;"]))).toEqual([OWNER]);
  });

  it("reaches a wildcard-imported package only when the simple name is used", () => {
    expect(reached(testIn("C.of();", ["import p.q.*;"]))).toEqual([OWNER]);
    expect(reached(testIn("S.of();", ["import p.q.*;"]))).toEqual([SIBLING]);
    expect(reached(testIn("new Object();", ["import p.q.*;"]))).toEqual([]);
    // A wildcard over the owner's own class imports its member types, so it names the owner.
    expect(reached(testIn("new Object();", ["import p.q.C.*;"]))).toEqual([OWNER]);
  });

  it("reaches a same-package file by its simple name, with no import at all", () => {
    const samePackage = "src/test/java/p/q/Matrix.java";
    expect(reached(testIn("C.of();", [], "p.q"), samePackage)).toEqual([OWNER]);
    expect(reached(testIn("new Object();", [], "p.q"), samePackage)).toEqual([]);
  });

  it("decides the same package by the declaration the test writes, not the directory it sits in", () => {
    // javac compiles a source into its declared package whatever directory holds it.
    expect(reached(testIn("C.of();", [], "p.q"), "src/test/java/t/Matrix.java")).toEqual([OWNER]);
    const looksSame = "src/test/java/p/q/Matrix.java";
    expect(reached(testIn("C.of();", [], "other"), looksSame)).toEqual([]);
    // With no declaration, the path's package is the one javac would name.
    expect(reached("final class Matrix { void matrix() { C.of(); } }\n", looksSame)).toEqual([OWNER]);
  });

  it("reaches a file whose fully-qualified name the test writes out without an import", () => {
    expect(reached(testIn('p.q.C.of("x");'))).toEqual([OWNER]);
    expect(reached(testIn('x.p.q.C.of("x");'))).toEqual([]);
  });

  it("reaches nothing a test neither imports, shares a package with, nor names", () => {
    expect(reached(testIn("new Object();", ["import java.util.List;"]))).toEqual([]);
  });

  it("reaches a file whose package has a contextual-keyword segment, through the import javac honours", () => {
    const owner = "src/main/java/p/record/C.java";
    expect(reached(testIn("C.of();", ["import p.record.C;"]), MATRIX, [owner])).toEqual([owner]);
    expect(reached(testIn("new p.module.D();"), MATRIX, ["src/main/java/p/module/D.java"])).toEqual(["src/main/java/p/module/D.java"]);
    // The truncated name `p.C` must not reach an unrelated `p.C` either.
    expect(reached(testIn("C.of();", ["import p.record.C;"]), MATRIX, ["src/main/java/p/C.java"])).toEqual([]);
  });

  it("refuses a matrix test the grammar cannot parse as owner-unparseable, never as unreached", () => {
    const refused = javaReachedDue({ matrixTest: javaPath(MATRIX), matrixTestText: "final class Matrix { void f() { if ( } }", due: DUE.map(javaPath) });
    expect(refused).toMatchObject({ ok: false, error: { kind: "owner-unparseable" } });
    if (!refused.ok) expect(refused.error.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps the declared order of the paths it reaches", () => {
    expect(reached(testIn('C.of("x");\nS.of("x");', ["import p.q.S;", "import p.q.C;"]))).toEqual([OWNER, SIBLING]);
  });
});
