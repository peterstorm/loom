/**
 * `skeletonLanguageOf` (AD-15): unit rows for the Java package and class
 * derivation, and properties over generated paths — every path gets exactly
 * one target or unsupported verdict carrying that path, the verdict depends
 * only on the path, and a Java target's package and class always spell the
 * path after its `src/main/java/` root.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";

const JAVA_KEYWORDS = ["class", "enum", "package", "public", "static", "void", "int", "true", "null", "_"] as const;

/** Capitalized, so never a Java keyword or literal; `_` alone is the one reserved identifier of that shape. */
const javaName = fc.stringMatching(/^[A-Z_$][A-Za-z0-9_$]{0,8}$/).filter((name) => name !== "_");
const segment = fc.stringMatching(/^[A-Za-z0-9_.$-]{1,8}$/);
const extension = fc.constantFrom(".ts", ".tsx", ".mts", ".cts", ".d.ts", ".java", ".kt", ".kts", ".scala", ".rs", ".js", ".md", "");
const anyPath = fc.tuple(fc.array(fc.oneof(segment, fc.constantFrom("src", "main", "java", "test")), { maxLength: 6 }), segment, extension)
  .map(([dirs, base, ext]) => [...dirs, `${base}${ext}`].join("/"));

describe("skeletonLanguageOf: unit rows", () => {
  it("reads a deep package and the class from the basename", () => {
    expect(skeletonLanguageOf("services/billing/src/main/java/com/acme/billing/v2/InvoiceRun.java")).toEqual({
      kind: "supported",
      language: "java",
      path: "services/billing/src/main/java/com/acme/billing/v2/InvoiceRun.java",
      package: "com.acme.billing.v2",
      className: "InvoiceRun",
    });
  });

  it("keeps the path it was given on every verdict", () => {
    for (const path of ["src/a.ts", "src/main/java/a/A.java", "lib/A.java", "a.kt", "README"]) {
      expect(skeletonLanguageOf(path).path).toBe(path);
    }
  });

  it("a Java class or package segment that is a reserved word is an invalid name", () => {
    for (const word of JAVA_KEYWORDS) {
      expect(skeletonLanguageOf(`src/main/java/com/${word}/A.java`)).toMatchObject({ kind: "unsupported", reason: "java-invalid-name" });
      expect(skeletonLanguageOf(`src/main/java/com/${word}.java`)).toMatchObject({ kind: "unsupported", reason: "java-invalid-name" });
    }
  });
});

describe("skeletonLanguageOf: properties", () => {
  it("every path gets exactly one verdict, for that path, and the same one every time", () => {
    fc.assert(fc.property(anyPath, (path) => {
      const verdict = skeletonLanguageOf(path);
      expect(verdict.path).toBe(path);
      expect(["supported", "unsupported"]).toContain(verdict.kind);
      expect(skeletonLanguageOf(path)).toEqual(verdict);
    }), { numRuns: 500 });
  });

  it("only the four TypeScript extensions, outside declaration files, are TypeScript targets", () => {
    fc.assert(fc.property(anyPath, (path) => {
      const verdict = skeletonLanguageOf(path);
      const isTs = verdict.kind === "supported" && verdict.language === "typescript";
      const base = path.split("/").at(-1)!;
      const tsExtension = /^.+\.(?:ts|tsx|mts|cts)$/.test(base) && !/\.d\.(?:ts|mts|cts)$/.test(base);
      expect(isTs).toBe(tsExtension);
    }), { numRuns: 500 });
  });

  it("a Java target under src/main/java has the package and class its path spells", () => {
    const javaPath = fc.tuple(fc.array(segment, { maxLength: 3 }), fc.array(javaName, { maxLength: 4 }), javaName);
    fc.assert(fc.property(javaPath, ([prefix, packageSegments, className]) => {
      fc.pre(!prefix.some((part, i) => part === "src" && prefix[i + 1] === "main"));
      const path = [...prefix, "src", "main", "java", ...packageSegments, `${className}.java`].join("/");
      expect(skeletonLanguageOf(path)).toEqual({
        kind: "supported",
        language: "java",
        path,
        package: packageSegments.length === 0 ? null : packageSegments.join("."),
        className,
      });
    }), { numRuns: 500 });
  });

  it("a .java path with no src/main/java root is outside the main root", () => {
    const outside = fc.tuple(fc.array(segment, { maxLength: 5 }), javaName)
      .map(([dirs, className]) => [...dirs, `${className}.java`].join("/"))
      .filter((path) => !`/${path}`.includes("/src/main/java/"));
    fc.assert(fc.property(outside, (path) => {
      expect(skeletonLanguageOf(path)).toEqual({ kind: "unsupported", path, reason: "java-outside-main-root" });
    }), { numRuns: 500 });
  });
});
