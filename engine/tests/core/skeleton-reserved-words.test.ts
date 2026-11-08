/**
 * Characterization of the two reserved-word predicates of the skeleton
 * pipeline: `skeletonLanguageOf` refuses a Java package segment or class name
 * that is a Java reserved word (`java-invalid-name`), and `parseIdentifier`
 * refuses a binding name or alias that is reserved in TypeScript or Java
 * (`reserved-word`). Java's keyword core has one owner (`language.ts`); the
 * binding grammar's list is its union with TypeScript's words and Java's
 * restricted identifiers. These rows pin both accept/refuse sets exactly.
 */

import { describe, expect, it } from "vitest";
import { parseIdentifier } from "../../src/core/skeleton/bindings";
import { skeletonLanguageOf } from "../../src/core/skeleton/language";

/** Java's keywords, literals and `_`: what a Java path segment may never spell. */
const JAVA_REFUSED = [
  "_", "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
  "continue", "default", "do", "double", "else", "enum", "extends", "false", "final", "finally",
  "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long",
  "native", "new", "null", "package", "private", "protected", "public", "return", "short", "static",
  "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "true",
  "try", "void", "volatile", "while",
] as const;

/** Java's restricted identifiers the binding grammar refuses besides its keywords. */
const JAVA_RESTRICTED_REFUSED = ["permits", "record", "sealed", "var", "yield"] as const;

/** TypeScript / JavaScript words Java does not reserve. */
const TYPESCRIPT_ONLY_REFUSED = [
  "arguments", "await", "debugger", "delete", "eval", "export", "function", "in", "let", "typeof",
  "undefined", "var", "with", "yield",
] as const;

/** Words neither predicate refuses, contextual keywords of either language among them. */
const ACCEPTED_BY_BOTH = [
  "module", "open", "requires", "exports", "to", "transitive", "when", "async", "of", "type",
  "namespace", "declare", "readonly", "any", "never", "unknown", "as", "is", "keyof", "infer",
  "Record", "String", "Var", "__", "_a", "priceOrder", "PriceOrderFn",
] as const;

const CANDIDATES = [...new Set([...JAVA_REFUSED, ...JAVA_RESTRICTED_REFUSED, ...TYPESCRIPT_ONLY_REFUSED, ...ACCEPTED_BY_BOTH])];

const javaRefuses = (word: string): boolean => {
  const asClass = skeletonLanguageOf(`src/main/java/com/acme/${word}.java`);
  const asPackage = skeletonLanguageOf(`src/main/java/com/${word}/Pricing.java`);
  const refused = (target: typeof asClass): boolean => target.kind === "unsupported" && target.reason === "java-invalid-name";
  expect(refused(asClass), `${word}: class and package segment agree`).toBe(refused(asPackage));
  return refused(asClass);
};

const bindingRefuses = (word: string): boolean => {
  const parsed = parseIdentifier(word);
  return !parsed.ok && parsed.error === "reserved-word";
};

const sorted = (words: readonly string[]): readonly string[] => [...new Set(words)].sort();

describe("reserved words of the skeleton pipeline", () => {
  it("a Java path refuses exactly Java's keywords, literals and `_`", () => {
    expect(sorted(CANDIDATES.filter(javaRefuses))).toEqual(sorted(JAVA_REFUSED));
  });

  it("a binding identifier refuses exactly Java's keywords, its restricted identifiers and TypeScript's words", () => {
    expect(sorted(CANDIDATES.filter(bindingRefuses)))
      .toEqual(sorted([...JAVA_REFUSED, ...JAVA_RESTRICTED_REFUSED, ...TYPESCRIPT_ONLY_REFUSED]));
  });

  it("every word a Java path refuses, a binding identifier refuses too", () => {
    expect(JAVA_REFUSED.filter((word) => !bindingRefuses(word))).toEqual([]);
  });
});
