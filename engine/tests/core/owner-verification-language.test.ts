/**
 * The one owner-verification language predicate (issue #254): which reader a
 * family path needs, what a Java path's package and fully-qualified name are,
 * and the one refusal a family mixing languages gets. Path-only and pure.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  javaFileIdentityOf,
  javaSourceRootOf,
  obligationLanguageOf,
  ownerLanguageOf,
  UNSUPPORTED_SOURCE_REASON_TEXT,
} from "../../src/core/owner-verification/language";

const languageOf = (path: string): string => {
  const source = ownerLanguageOf(path);
  return source.kind === "supported" ? source.language : `unsupported:${source.reason}`;
};

describe("ownerLanguageOf", () => {
  it.each([
    ["src/a.ts", "typescript"], ["src/a.tsx", "typescript"], ["src/a.mts", "typescript"], ["src/a.cts", "typescript"],
    ["src/a.js", "typescript"], ["src/a.jsx", "typescript"], ["src/a.mjs", "typescript"], ["src/a.cjs", "typescript"],
    ["src/main/java/p/C.java", "java"], ["src/test/java/p/C.java", "java"], ["billing/src/main/java/p/C.java", "java"],
  ])("reads %s with the %s reader", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });

  it.each([
    ["src/a.d.ts", "unsupported:declaration-file"], ["src/a.d.mts", "unsupported:declaration-file"], ["src/a.d.cts", "unsupported:declaration-file"],
    ["src/main/kotlin/p/C.kt", "unsupported:jvm-non-java"], ["src/main/scala/p/C.scala", "unsupported:jvm-non-java"],
    ["src/main/rust/lib.rs", "unsupported:other-extension"], ["pom.xml", "unsupported:other-extension"], ["Makefile", "unsupported:other-extension"],
    // A Java file outside src/main/java or src/test/java has no package to derive: no reader reads it.
    ["p/C.java", "unsupported:java-outside-source-root"], ["src/java/p/C.java", "unsupported:java-outside-source-root"],
    ["src/main/java", "unsupported:other-extension"], ["src/main/java/", "unsupported:other-extension"],
  ])("refuses %s as %s, never as a parse error", (path, refusal) => {
    expect(languageOf(path)).toBe(refusal);
  });

  it("names each refusal in the line an infrastructure diagnostic carries", () => {
    for (const [reason, text] of Object.entries(UNSUPPORTED_SOURCE_REASON_TEXT)) {
      expect(text, reason).not.toBe("");
    }
  });
});

describe("javaFileIdentityOf", () => {
  it("derives the package, simple name and fully-qualified name from a source-root path", () => {
    expect(javaFileIdentityOf("src/main/java/p/q/C.java")).toEqual({
      root: { modulePrefix: "", sourceRoot: "main" },
      packageName: "p.q",
      simpleName: "C",
      fqn: "p.q.C",
    });
    expect(javaFileIdentityOf("billing/src/test/java/p/C.java")).toEqual({
      root: { modulePrefix: "billing", sourceRoot: "test" },
      packageName: "p",
      simpleName: "C",
      fqn: "p.C",
    });
  });

  it("reads the default package as an empty package and a bare simple name", () => {
    expect(javaFileIdentityOf("src/main/java/C.java")).toMatchObject({ packageName: "", simpleName: "C", fqn: "C" });
  });

  it("has no identity for a path no source root holds", () => {
    expect(javaFileIdentityOf("p/C.java")).toBeNull();
    expect(javaFileIdentityOf("src/main/java/C.kt")).toBeNull();
    expect(javaSourceRootOf("src/main/java/C.kt")).toBeNull();
  });

  it("property: a Java path's fully-qualified name is its package, a dot and its file name", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/);
    fc.assert(fc.property(fc.array(segment, { maxLength: 4 }), segment, (packageSegments, simpleName) => {
      const path = ["billing", "src", "main", "java", ...packageSegments, `${simpleName}.java`].join("/");
      const identity = javaFileIdentityOf(path);
      if (identity === null) throw new Error(`a Java path under a source root has no identity: ${path}`);
      expect(identity.packageName).toBe(packageSegments.join("."));
      expect(identity.simpleName).toBe(simpleName);
      expect(identity.fqn).toBe([...packageSegments, simpleName].join("."));
    }));
  });

  it("property: the language decision is total and never throws, whatever the path", () => {
    fc.assert(fc.property(fc.string(), (path) => {
      expect(["supported", "unsupported"]).toContain(ownerLanguageOf(path).kind);
    }));
  });
});

describe("obligationLanguageOf", () => {
  const OWNER = "billing/src/main/java/p/q/C.java";
  const MATRIX = "billing/src/test/java/p/q/CTest.java";

  it("reads a family whose every path needs the same reader", () => {
    expect(obligationLanguageOf({ owner: OWNER, matrixTest: MATRIX, due: [OWNER] })).toEqual({ ok: true, value: "java" });
    expect(obligationLanguageOf({ owner: "src/a.ts", matrixTest: "tests/a.test.ts", due: ["src/a.ts", "src/b.ts"] }))
      .toEqual({ ok: true, value: "typescript" });
  });

  it("refuses a family that mixes languages, naming both", () => {
    const refused = obligationLanguageOf({ owner: OWNER, matrixTest: "tests/a.test.ts", due: [OWNER] });
    expect(refused).toMatchObject({ ok: false, error: { kind: "unsupported-language" } });
    if (refused.ok) throw new Error("a mixed family was read");
    expect(refused.error.detail).toContain(OWNER);
    expect(refused.error.detail).toContain("tests/a.test.ts");
  });

  it("refuses a path no reader reads, whatever its role", () => {
    for (const paths of [
      { owner: "src/main/kotlin/C.kt", matrixTest: "src/main/kotlin/CTest.kt", due: ["src/main/kotlin/C.kt"] },
      { owner: "src/a.ts", matrixTest: "tests/a.spec.rs", due: ["src/a.ts"] },
      { owner: "src/a.ts", matrixTest: "tests/a.test.ts", due: ["src/a.ts", "src/main/kotlin/S.kt"] },
    ]) {
      const refused = obligationLanguageOf(paths);
      expect(refused, paths.owner).toMatchObject({ ok: false, error: { kind: "unsupported-language" } });
      if (!refused.ok) expect(refused.error.detail).toContain("which owner verification cannot read");
    }
  });
});
