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
 *   package and fully-qualified name come from: the classification carries the
 *   file's identity, derived from the path as javac's source-path layout does,
 *   so no reader splits the path a second time.
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
 * reporting a parse error for one it never tried to parse. A Java obligation's
 * reading carries every family path's identity, so the Java reach rule is
 * handed only paths it can read.
 */

import { failure, nonEmptyOf, success, type DomainResult, type NonEmpty } from "../orchestration-contract/identity";
import type { OwnerInfrastructureFailure } from "./types";

// ---------------------------------------------------------------------------
// Java source roots and file identity
// ---------------------------------------------------------------------------

/**
 * The Java source root a path sits under: the segments before src/main/java or
 * src/test/java are the module prefix (`""` at the repository root), and the
 * root kind says which one it is.
 */
export type JavaSourceRoot = Readonly<{
  modulePrefix: string;
  sourceRoot: "main" | "test";
}>;

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

const JAVA_EXTENSION = ".java";
const ROOT_PARTS = 3;

const sourceRootAt = (segments: readonly string[], at: number): "main" | "test" | null => {
  const kind = segments[at + 1];
  return segments[at] === "src" && (kind === "main" || kind === "test") && segments[at + 2] === "java" ? kind : null;
};

/**
 * The identity of the `.java` file a path names under its first src/main/java
 * or src/test/java root. Null for any path outside both roots, a path that is
 * not a `.java` file beneath one, or a root with no file after it.
 */
export function javaFileIdentityOf(path: string): JavaFileIdentity | null {
  const segments = path.split("/");
  for (let at = 0; at + ROOT_PARTS < segments.length; at += 1) {
    const sourceRoot = sourceRootAt(segments, at);
    if (sourceRoot === null) continue;
    const afterRoot = segments.slice(at + ROOT_PARTS);
    const basename = afterRoot.at(-1);
    if (basename === undefined || !basename.endsWith(JAVA_EXTENSION) || basename.length === JAVA_EXTENSION.length) return null;
    const packageName = afterRoot.slice(0, -1).join(".");
    const simpleName = basename.slice(0, -JAVA_EXTENSION.length);
    return Object.freeze({
      root: Object.freeze({ modulePrefix: segments.slice(0, at).join("/"), sourceRoot }),
      packageName,
      simpleName,
      fqn: packageName === "" ? simpleName : `${packageName}.${simpleName}`,
    });
  }
  return null;
}

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

/** A path a reader reads; a Java path carries the identity its source root gives it. */
export type SupportedSource =
  | Readonly<{ kind: "supported"; language: "typescript" }>
  | Readonly<{ kind: "supported"; language: "java"; identity: JavaFileIdentity }>;

export type SourceLanguage = SupportedSource | Readonly<{ kind: "unsupported"; reason: UnsupportedSourceReason }>;

const TYPESCRIPT_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];
const JAVASCRIPT_EXTENSIONS: readonly string[] = [".js", ".jsx", ".mjs", ".cjs"];
const JVM_NON_JAVA_EXTENSIONS: readonly string[] = [".kt", ".kts", ".scala"];
const DECLARATION_FILE = /\.d\.[mc]?ts$/;

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

const unsupported = (reason: UnsupportedSourceReason): SourceLanguage => Object.freeze({ kind: "unsupported", reason });

const TYPESCRIPT_SOURCE: SourceLanguage = Object.freeze({ kind: "supported", language: "typescript" });

/**
 * The language that reads `path`, or why none does. Path-only, total, and the
 * one decision every reader of a family path asks: the mutation plan, sibling
 * coverage, the Task mutation check, and the obligation check that refuses a
 * mixed family.
 */
export const ownerLanguageOf = (path: string): SourceLanguage => {
  const basename = basenameOf(path);
  const extension = extensionOf(basename);
  if (DECLARATION_FILE.test(basename)) return unsupported("declaration-file");
  if (TYPESCRIPT_EXTENSIONS.includes(extension) || JAVASCRIPT_EXTENSIONS.includes(extension)) return TYPESCRIPT_SOURCE;
  if (JVM_NON_JAVA_EXTENSIONS.includes(extension)) return unsupported("jvm-non-java");
  if (extension === JAVA_EXTENSION) {
    const identity = javaFileIdentityOf(path);
    return identity === null ? unsupported("java-outside-source-root") : Object.freeze({ kind: "supported", language: "java", identity });
  }
  return unsupported("other-extension");
};

// ---------------------------------------------------------------------------
// One obligation's language
// ---------------------------------------------------------------------------

/**
 * One obligation's family paths: its matrix test, and the family paths due by
 * the Wave, the owner first (`duePaths` orders them so; the owner is the head
 * of the list, never a second field that could disagree with it).
 */
export type ObligationLanguagePaths = Readonly<{
  matrixTest: string;
  due: NonEmpty<string>;
}>;

/** One Java family path with the identity its source root gives it. */
export type JavaFamilyPath = Readonly<{ path: string; identity: JavaFileIdentity }>;

/**
 * How an obligation's family reads: a TypeScript family through the import
 * graph, a Java family through its paths' identities, the owner first.
 */
export type ObligationReading =
  | Readonly<{ language: "typescript" }>
  | Readonly<{ language: "java"; matrixTest: JavaFamilyPath; due: NonEmpty<JavaFamilyPath> }>;

const TYPESCRIPT_READING: ObligationReading = Object.freeze({ language: "typescript" });

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
 * One family path read in the owner's language: `pick` takes it when its
 * language is the owner's and returns null otherwise, which is the mixed-family
 * refusal.
 */
function inOwnerLanguage<T>(
  owner: string,
  ownerLanguage: OwnerLanguage,
  path: string,
  pick: (path: string, source: SupportedSource) => T | null,
): DomainResult<T, OwnerInfrastructureFailure> {
  const source = ownerLanguageOf(path);
  if (source.kind === "unsupported") {
    return languageFailure(`${unsupportedPathText(path, source.reason)}; it reads TypeScript sources and Java sources under a src/main/java or src/test/java root`);
  }
  const picked = pick(path, source);
  return picked === null
    ? languageFailure(`the owner ${owner} is ${OWNER_LANGUAGE_TEXT[ownerLanguage]} but ${path} is ${OWNER_LANGUAGE_TEXT[source.language]}; owner verification reads one language per obligation`)
    : success(picked);
}

/** Every path read in the owner's language, in order, or the first refusal. */
function allInOwnerLanguage<T>(
  owner: string,
  ownerLanguage: OwnerLanguage,
  paths: readonly string[],
  pick: (path: string, source: SupportedSource) => T | null,
): DomainResult<readonly T[], OwnerInfrastructureFailure> {
  const picked: T[] = [];
  for (const path of paths) {
    const read = inOwnerLanguage(owner, ownerLanguage, path, pick);
    if (!read.ok) return read;
    picked.push(read.value);
  }
  return success(picked);
}

const pickTypescript = (_path: string, source: SupportedSource): true | null => (source.language === "typescript" ? true : null);

const pickJava = (path: string, source: SupportedSource): JavaFamilyPath | null =>
  source.language === "java" ? Object.freeze({ path, identity: source.identity }) : null;

/**
 * How an obligation's family reads, or the `unsupported-language` failure that
 * refuses it: a path neither reader reads, or a family whose paths do not all
 * read the same way. The owner is classified first, then the matrix test,
 * then the siblings in declared order. Path-only and pure; the caller decides what to do with the
 * refusal, never a parse.
 */
export const obligationLanguageOf = ({ matrixTest, due }: ObligationLanguagePaths): DomainResult<ObligationReading, OwnerInfrastructureFailure> => {
  const [owner, ...siblings] = due;
  const ownerSource = ownerLanguageOf(owner);
  if (ownerSource.kind === "unsupported") {
    return languageFailure(`the owner ${unsupportedPathText(owner, ownerSource.reason)}`);
  }
  if (ownerSource.language === "typescript") {
    const family = allInOwnerLanguage(owner, "typescript", [matrixTest, ...siblings], pickTypescript);
    return family.ok ? success(TYPESCRIPT_READING) : family;
  }
  const test = inOwnerLanguage(owner, "java", matrixTest, pickJava);
  if (!test.ok) return test;
  const siblingPaths = allInOwnerLanguage(owner, "java", siblings, pickJava);
  if (!siblingPaths.ok) return siblingPaths;
  return success(Object.freeze({
    language: "java",
    matrixTest: test.value,
    due: nonEmptyOf(Object.freeze({ path: owner, identity: ownerSource.identity }), ...siblingPaths.value),
  }));
};
