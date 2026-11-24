/**
 * The one owner-verification source-language predicate (issue #254), modelled
 * on `core/skeleton/language.ts` (AD-15). Pure: a function of the path only,
 * never of the file's bytes.
 *
 * - **TypeScript**: `.ts`, `.tsx`, `.mts`, `.cts` and the JavaScript sources
 *   the compiler seam already parses (`.js`, `.jsx`, `.mjs`, `.cjs`), never a
 *   declaration file (`.d.ts`, `.d.mts`, `.d.cts`).
 * - **Java**: a `.java` file under a src/main/java or src/test/java root (a
 *   module prefix is allowed). The root is also the one place a Java path's
 *   package and fully-qualified name come from: `javaFileIdentityOf` derives
 *   both from the path, as javac's source-path layout does.
 * - **Unsupported**, with one reason: Kotlin and Scala are `jvm-non-java`, a
 *   `.java` path outside a source root `java-outside-source-root`, a
 *   declaration file `declaration-file`, and everything else
 *   `other-extension`.
 *
 * One Owner Obligation reads one language: its owner, matrix test and due
 * siblings must all classify the same way (TypeScript sources and JavaScript
 * sources are the same language family). A mixed or unsupported obligation is
 * the `unsupported-language` infrastructure failure, never
 * `owner-unparseable`: the check refuses a language it cannot read instead of
 * reporting a parse error for one it never tried to parse.
 */

import { failure, success, type DomainResult } from "../orchestration-contract/identity";
import type { OwnerInfrastructureFailure } from "./types";

// ---------------------------------------------------------------------------
// The classification
// ---------------------------------------------------------------------------

/** The two languages owner verification reads. */
export type OwnerLanguage = "typescript" | "java";

/** Why a path is outside both languages. */
export type UnsupportedSourceReason =
  | "declaration-file"
  | "jvm-non-java"
  | "java-outside-source-root"
  | "other-extension";

export type SourceLanguage =
  | Readonly<{ kind: "supported"; language: OwnerLanguage }>
  | Readonly<{ kind: "unsupported"; reason: UnsupportedSourceReason }>;

const TYPESCRIPT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];
const JAVASCRIPT_EXTENSIONS: readonly string[] = [".js", ".jsx", ".mjs", ".cjs"];
const JVM_NON_JAVA_EXTENSIONS: readonly string[] = [".kt", ".kts", ".scala"];
const DECLARATION_FILE = /\.d\.[mc]?ts$/;
const JAVA_EXTENSION = ".java";

/** How each unsupported reason reads in an infrastructure diagnostic. */
export const UNSUPPORTED_SOURCE_REASON_TEXT: Readonly<Record<UnsupportedSourceReason, string>> = Object.freeze({
  "declaration-file": "a TypeScript declaration file",
  "jvm-non-java": "Kotlin or Scala",
  "java-outside-source-root": "a Java file outside a src/main/java or src/test/java root",
  "other-extension": "neither a TypeScript source nor a Java source",
});

/** How each language reads in an infrastructure diagnostic. */
export const OWNER_LANGUAGE_TEXT: Readonly<Record<OwnerLanguage, string>> = Object.freeze({
  typescript: "TypeScript",
  java: "Java",
});

const basenameOf = (path: string): string => path.split("/").at(-1) ?? path;

const extensionOf = (basename: string): string => {
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot) : "";
};

const supported = (language: OwnerLanguage): SourceLanguage => Object.freeze({ kind: "supported", language });

/**
 * The language that reads `path`, or why none does. Path-only, total, and the
 * one decision every reader of a family path asks: the mutation plan, sibling
 * coverage, and the obligation check that refuses a mixed family.
 */
export const ownerLanguageOf = (path: string): SourceLanguage => {
  const basename = basenameOf(path);
  const extension = extensionOf(basename);
  if (DECLARATION_FILE.test(basename)) return Object.freeze({ kind: "unsupported", reason: "declaration-file" });
  if (TYPESCRIPT_EXTENSIONS.includes(extension) || JAVASCRIPT_EXTENSIONS.includes(extension)) return supported("typescript");
  if (JVM_NON_JAVA_EXTENSIONS.includes(extension)) return Object.freeze({ kind: "unsupported", reason: "jvm-non-java" });
  if (extension === JAVA_EXTENSION) {
    return javaSourceRootOf(path) === null
      ? Object.freeze({ kind: "unsupported", reason: "java-outside-source-root" })
      : supported("java");
  }
  return Object.freeze({ kind: "unsupported", reason: "other-extension" });
};

// ---------------------------------------------------------------------------
// Java source roots and file identity
// ---------------------------------------------------------------------------

/**
 * The Java source root a path sits under: the segments before src/main/java or
 * src/test/java are the module prefix (`""` at the repository root), and the
 * root kind says which one it is. Null for any path outside both roots, a path
 * that is not a file beneath one, or a root with no file after it.
 */
export type JavaSourceRoot = Readonly<{
  modulePrefix: string;
  sourceRoot: "main" | "test";
}>;

type JavaSplit = Readonly<{
  root: JavaSourceRoot;
  /** The package segments between the root and the file, in order. */
  packageSegments: readonly string[];
  /** The file's class name: its basename without `.java`. */
  simpleName: string;
}>;

const ROOT_PARTS = 3;

const sourceRootAt = (segments: readonly string[], at: number): "main" | "test" | null => {
  const kind = segments[at + 1];
  return segments[at] === "src" && (kind === "main" || kind === "test") && segments[at + 2] === "java" ? kind : null;
};

/** The first src/main/java or src/test/java split of a path, or null. */
function javaSplit(path: string): JavaSplit | null {
  const segments = path.split("/");
  for (let at = 0; at + ROOT_PARTS < segments.length; at += 1) {
    const sourceRoot = sourceRootAt(segments, at);
    if (sourceRoot === null) continue;
    const afterRoot = segments.slice(at + ROOT_PARTS);
    const basename = afterRoot.at(-1);
    if (basename === undefined || !basename.endsWith(JAVA_EXTENSION) || basename.length === JAVA_EXTENSION.length) return null;
    return Object.freeze({
      root: Object.freeze({ modulePrefix: segments.slice(0, at).join("/"), sourceRoot }),
      packageSegments: Object.freeze(afterRoot.slice(0, -1)),
      simpleName: basename.slice(0, -JAVA_EXTENSION.length),
    });
  }
  return null;
}

export const javaSourceRootOf = (path: string): JavaSourceRoot | null => javaSplit(path)?.root ?? null;

/**
 * A Java file's identity as its path declares it: the module root it sits
 * under, its package (`""` for the default package), its simple class name and
 * its fully-qualified name. Java resolves a class by fully-qualified name, so
 * this is what an import's qualified name is compared against.
 */
export type JavaFileIdentity = Readonly<{
  root: JavaSourceRoot;
  packageName: string;
  simpleName: string;
  fqn: string;
}>;

export const javaFileIdentityOf = (path: string): JavaFileIdentity | null => {
  const split = javaSplit(path);
  if (split === null) return null;
  const packageName = split.packageSegments.join(".");
  return Object.freeze({
    root: split.root,
    packageName,
    simpleName: split.simpleName,
    fqn: packageName === "" ? split.simpleName : `${packageName}.${split.simpleName}`,
  });
};

// ---------------------------------------------------------------------------
// One obligation's language
// ---------------------------------------------------------------------------

/**
 * One obligation's family paths: its owner, its matrix test, and the family
 * paths due by the Wave (the owner first, as `duePaths` orders them).
 */
export type ObligationLanguagePaths = Readonly<{
  owner: string;
  matrixTest: string;
  due: readonly string[];
}>;

/**
 * How a path no reader reads reads in an infrastructure diagnostic. The one
 * wording both the obligation check and the mutation plan use.
 */
export const unsupportedPathText = (path: string, reason: UnsupportedSourceReason): string =>
  `${path} is ${UNSUPPORTED_SOURCE_REASON_TEXT[reason]}, which owner verification cannot read`;

/** The one refusal the obligation check reports: a path neither reader reads, or a mixed family. */
const languageFailure = (detail: string): DomainResult<never, OwnerInfrastructureFailure> =>
  failure(Object.freeze({ kind: "unsupported-language" as const, detail }));

/**
 * The one language an obligation's family reads, or the `unsupported-language`
 * failure that refuses it: a path neither reader reads, or a family whose
 * paths do not all read the same way. Path-only and pure; the caller decides
 * what to do with the refusal, never a parse.
 */
export const obligationLanguageOf = ({ owner, matrixTest, due }: ObligationLanguagePaths): DomainResult<OwnerLanguage, OwnerInfrastructureFailure> => {
  const ownerSource = ownerLanguageOf(owner);
  if (ownerSource.kind === "unsupported") {
    return languageFailure(`the owner ${owner} is ${UNSUPPORTED_SOURCE_REASON_TEXT[ownerSource.reason]}, which owner verification cannot read`);
  }
  for (const path of [matrixTest, ...due.filter((candidate) => candidate !== owner)]) {
    const source = ownerLanguageOf(path);
    if (source.kind === "unsupported") {
      return languageFailure(`${path} is ${UNSUPPORTED_SOURCE_REASON_TEXT[source.reason]}, which owner verification cannot read; it reads TypeScript sources and Java sources under a src/main/java or src/test/java root`);
    }
    if (source.language !== ownerSource.language) {
      return languageFailure(`the owner ${owner} is ${OWNER_LANGUAGE_TEXT[ownerSource.language]} but ${path} is ${OWNER_LANGUAGE_TEXT[source.language]}; owner verification reads one language per obligation`);
    }
  }
  return success(ownerSource.language);
};
