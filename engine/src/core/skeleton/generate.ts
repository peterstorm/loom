/**
 * Canonical TypeScript and Java skeleton bytes (AD-8, AD-7; FR-006..FR-010).
 *
 * The bytes are a pure function of the input — target, frozen surface,
 * contract, resolved exports and (TypeScript) specifier style — so the same
 * input always yields the same bytes (FR-009), and regenerating from an
 * untouched skeleton's inputs reproduces it (FR-010). No formatter ever runs.
 *
 * Common to both languages: LF line endings, one trailing newline, no
 * timestamps; one header comment naming the types file and the contract;
 * exports in plan order; imports sorted (code-unit order, never a locale) and
 * unique. A skeleton holds exactly the bound exports and the imports they
 * need, nothing else (FR-008). Every spliced name is an `Identifier` and every
 * Java package and class name was proved valid by `skeletonLanguageOf`.
 *
 * - TypeScript: one `import type` of the bound aliases from the types file,
 *   the specifier relative to the skeleton's directory in the frozen
 *   acceptance tests' style (extensionless when null); then per export
 *   `export const name: Alias = () => { throw … }`. A zero-parameter throwing
 *   arrow is assignable to any non-generic function type, and stage two
 *   refuses generic aliases. The imported aliases and the declared names
 *   never share a name: the binding grammar refuses a name equal to an alias
 *   of its line (`name-collides-with-alias`), so the import cannot conflict
 *   with a declaration (TS2440).
 * - Java: one `public final class <FileBasename>` with a private constructor
 *   and per export a `public static final Alias name` lambda whose arity is
 *   the single abstract method's. Each alias is imported as
 *   `<package>.<Holder>.<Alias>`; a holder in the default package cannot be
 *   imported (JLS 7.5), so there each member is typed `Holder.Alias` instead.
 *
 * The input correlates target and surface by language, and the skeleton's
 * path is the target's own, so generation is total. Pure.
 */

import { match } from "ts-pattern";
import { sha256Hex } from "../digest";
import { directoryOf } from "../owner-verification/repo-path";
import type { GenerateSkeletonFn, JavaSkeletonInput, SpecifierStyle, TsSkeletonInput } from "./types";

const header = (typesPath: string, contract: string): string =>
  `// Skeleton written by Loom from ${typesPath} (${contract}). Make these signatures work; keep each name and its type.`;

const sortedUnique = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

/** Lines joined with LF, ending in exactly one newline. */
const fileOf = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

/** Each TypeScript module extension and the runtime extension a `.js`-style
 *  specifier names it by (longest first, so `.tsx` never reads as `.ts`). */
const RUNTIME_EXTENSIONS: readonly (readonly [string, string])[] = [
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".ts", ".js"],
];

/** The repository path the specifier names: the types file in the given style. */
function importedModulePath(typesPath: string, style: SpecifierStyle | null): string {
  const extensions = RUNTIME_EXTENSIONS.find(([extension]) => typesPath.endsWith(extension));
  if (extensions === undefined) return typesPath;
  const [extension, runtimeExtension] = extensions;
  const stem = typesPath.slice(0, -extension.length);
  return match(style ?? "extensionless")
    .with("extensionless", () => stem)
    .with(".js", () => `${stem}${runtimeExtension}`)
    .with(".ts", () => typesPath)
    .exhaustive();
}

const segmentsOf = (path: string): readonly string[] => (path === "" ? [] : path.split("/"));

/** A `./`- or `../`-relative specifier from a file's directory to a repository path. */
function relativeSpecifier(fromFile: string, toPath: string): string {
  const from = segmentsOf(directoryOf(fromFile));
  const to = segmentsOf(toPath);
  // Shared leading directories; the target's basename is never shared.
  const firstDifferent = from.findIndex((segment, at) => at >= to.length - 1 || to[at] !== segment);
  const shared = firstDifferent < 0 ? from.length : firstDifferent;
  const up = from.length - shared;
  return `${up === 0 ? "./" : "../".repeat(up)}${to.slice(shared).join("/")}`;
}

function typescriptBytes({ target, surface, contract, exports, specifierStyle }: TsSkeletonInput): string {
  const aliases = sortedUnique(exports.map(({ alias }) => alias));
  const specifier = relativeSpecifier(target.path, importedModulePath(surface.path, specifierStyle));
  return fileOf([
    header(surface.path, contract),
    `import type { ${aliases.join(", ")} } from "${specifier}";`,
    ...exports.flatMap(({ name, alias }) => [
      "",
      `export const ${name}: ${alias} = () => {`,
      `  throw new Error("unimplemented: ${name}");`,
      "};",
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const lambdaParameters = (count: number): string => Array.from({ length: count }, (_, at) => `p${at}`).join(", ");

function javaBytes({ target, surface, contract, exports }: JavaSkeletonInput): string {
  const typesPackage = surface.package;
  const imports = typesPackage === null
    ? []
    : sortedUnique(exports.map(({ alias }) => `import ${typesPackage}.${surface.holder}.${alias};`));
  const typeOf = (alias: string): string => (typesPackage === null ? `${surface.holder}.${alias}` : alias);
  return fileOf([
    header(surface.path, contract),
    ...(target.package === null ? [] : [`package ${target.package};`]),
    ...(imports.length === 0 ? [] : ["", ...imports]),
    "",
    `public final class ${target.className} {`,
    `    private ${target.className}() {}`,
    ...exports.flatMap(({ name, alias, parameterCount }) => [
      "",
      `    public static final ${typeOf(alias)} ${name} = (${lambdaParameters(parameterCount)}) -> {`,
      `        throw new UnsupportedOperationException("unimplemented: ${name}");`,
      "    };",
    ]),
    "}",
  ]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const generateSkeleton: GenerateSkeletonFn = (input) => {
  const bytes = match(input)
    .with({ language: "typescript" }, typescriptBytes)
    .with({ language: "java" }, javaBytes)
    .exhaustive();
  return Object.freeze({ path: input.target.path, language: input.language, bytes, sha256: sha256Hex(bytes) });
};
