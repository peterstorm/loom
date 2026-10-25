/**
 * A matrix test's tsconfig `paths`, made repository-relative (ADR-0035):
 * the input `coverageFrontier` and `coverageOverFiles` resolve aliased
 * imports with. Pure: both effects are injected. `read` returns a
 * repository-relative file's text, or null when it is not there; `parseJsonc`
 * reads a config's JSONC text into a value, or says why it does not parse.
 * The shell (`orchestration/owner-verification-runner.ts`) adapts its total
 * repository read and `jsonc-parser`, the one module granted that package.
 */

import { failure, success, type DomainResult } from "../orchestration-contract/identity";
import type { PathAlias, PathAliases } from "./types";

/** A repository-relative file's text, or null when it is not there. */
export type ReadRepositoryFile = (path: string) => string | null;

/** A config's JSONC text as a value, or why it does not parse. */
export type ParseJsonc = (text: string) => DomainResult<unknown, string>;

type PathEntries = readonly (readonly [string, readonly string[]])[];

type CompilerPaths = Readonly<{
  /** The repository-relative directory `baseUrl` names, when a config in the chain declares one. */
  baseUrl: string | null;
  /** The declared `paths` and the directory of the config that declared them. */
  paths: Readonly<{ entries: PathEntries; declaredIn: string }> | null;
}>;

type ConfigRecord = Readonly<Record<string, unknown>>;

/** What a config chain reads: the files and the JSONC parser. */
type ConfigReader = Readonly<{ read: ReadRepositoryFile; parseJsonc: ParseJsonc }>;

const NO_PATHS: CompilerPaths = Object.freeze({ baseUrl: null, paths: null });

// Repository-relative path arithmetic (no `node:path`: this module is pure).

/** The directory of a repository-relative file path; "" at the repository root. */
export const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** A repository-relative join that collapses `.`, `..` and empty segments; null when it escapes the repository. */
export function within(directory: string, relative: string): string | null {
  const segments = `${directory}/${relative}`.split("/").reduce<readonly string[] | null>((kept, segment) => {
    if (kept === null || segment === "" || segment === ".") return kept;
    if (segment === "..") return kept.length === 0 ? null : kept.slice(0, -1);
    return [...kept, segment];
  }, []);
  return segments === null ? null : segments.join("/");
}

/** The nearest `tsconfig.json` from the matrix test's directory up to the repository root. */
export function nearestTsconfig(matrixTest: string, read: ReadRepositoryFile): string | null {
  for (let directory = directoryOf(matrixTest); ; directory = directoryOf(directory)) {
    const candidate = directory === "" ? "tsconfig.json" : `${directory}/tsconfig.json`;
    if (read(candidate) !== null) return candidate;
    if (directory === "") return null;
  }
}

/** The config file an `extends` entry names: relative to the extending config, or a package beneath a `node_modules`. */
export function extendedConfig(from: string, specifier: string, read: ReadRepositoryFile): string | null {
  const withJson = (path: string): readonly string[] => path.endsWith(".json") ? [path] : [path, `${path}.json`, `${path}/tsconfig.json`];
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = within(directoryOf(from), specifier);
    return base === null ? null : withJson(base).find((candidate) => read(candidate) !== null) ?? null;
  }
  for (let directory = directoryOf(from); ; directory = directoryOf(directory)) {
    const base = within(directory, `node_modules/${specifier}`);
    const found = base === null ? undefined : withJson(base).find((candidate) => read(candidate) !== null);
    if (found !== undefined) return found;
    if (directory === "") return null;
  }
}

const isRecord = (value: unknown): value is ConfigRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** One config file read and parsed into its top-level object. */
function configRecord(config: string, reader: ConfigReader): DomainResult<ConfigRecord, string> {
  const text = reader.read(config);
  if (text === null) return failure(`tsconfig ${config} cannot be read`);
  const parsed = reader.parseJsonc(text);
  if (!parsed.ok) return failure(`tsconfig ${config} does not parse: ${parsed.error}`);
  return isRecord(parsed.value) ? success(parsed.value) : failure(`tsconfig ${config} is not an object`);
}

/** The `baseUrl` and `paths` the configs `config` extends contribute, the later overriding the earlier. */
function inheritedPaths(config: string, record: ConfigRecord, reader: ConfigReader, seen: ReadonlySet<string>): DomainResult<CompilerPaths, string> {
  const extendsField = record.extends;
  const parents = extendsField === undefined ? [] : typeof extendsField === "string" ? [extendsField] : extendsField;
  if (!isStrings(parents)) return failure(`tsconfig ${config} has an extends that is not a string or a string array`);
  let inherited = NO_PATHS;
  for (const parent of parents) {
    const file = extendedConfig(config, parent, reader.read);
    if (file === null) return failure(`tsconfig ${config} extends ${parent}, which cannot be found`);
    const parentPaths = compilerPaths(file, reader, new Set([...seen, config]));
    if (!parentPaths.ok) return parentPaths;
    inherited = { baseUrl: parentPaths.value.baseUrl ?? inherited.baseUrl, paths: parentPaths.value.paths ?? inherited.paths };
  }
  return success(inherited);
}

/** A declared `paths` object as its entries, each pattern with its string targets. */
function pathEntries(config: string, paths: unknown): DomainResult<PathEntries, string> {
  if (!isRecord(paths)) return failure(`tsconfig ${config} paths is not an object`);
  const entries: (readonly [string, readonly string[]])[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!isStrings(targets)) return failure(`tsconfig ${config} paths.${pattern} is not a string array`);
    entries.push([pattern, targets]);
  }
  return success(entries);
}

/** The config's own `compilerOptions` over what it inherits. */
function ownPaths(config: string, options: unknown, inherited: CompilerPaths): DomainResult<CompilerPaths, string> {
  if (options === undefined) return success(inherited);
  if (!isRecord(options)) return failure(`tsconfig ${config} compilerOptions is not an object`);
  let baseUrl = inherited.baseUrl;
  if (options.baseUrl !== undefined) {
    if (typeof options.baseUrl !== "string") return failure(`tsconfig ${config} baseUrl is not a string`);
    baseUrl = within(directoryOf(config), options.baseUrl);
    if (baseUrl === null) return failure(`tsconfig ${config} baseUrl ${options.baseUrl} escapes the repository`);
  }
  if (options.paths === undefined) return success({ baseUrl, paths: inherited.paths });
  const entries = pathEntries(config, options.paths);
  return entries.ok ? success({ baseUrl, paths: { entries: entries.value, declaredIn: directoryOf(config) } }) : entries;
}

/** One config's `baseUrl` and `paths` over the configs it extends, the later overriding the earlier. */
function compilerPaths(config: string, reader: ConfigReader, seen: ReadonlySet<string>): DomainResult<CompilerPaths, string> {
  if (seen.has(config)) return failure(`tsconfig ${config} extends itself`);
  const record = configRecord(config, reader);
  if (!record.ok) return record;
  const inherited = inheritedPaths(config, record.value, reader, seen);
  return inherited.ok ? ownPaths(config, record.value.compilerOptions, inherited.value) : inherited;
}

/**
 * The matrix test's tsconfig `paths`, made repository-relative: targets resolve
 * against `baseUrl` when the chain declares one, otherwise against the
 * directory of the config that declared `paths`, as TypeScript resolves them.
 * Empty when no tsconfig governs the matrix test; refused when one does not
 * parse, since its aliases would then be unknown.
 */
export function pathAliasesOf(matrixTest: string, read: ReadRepositoryFile, parseJsonc: ParseJsonc): DomainResult<PathAliases, string> {
  const config = nearestTsconfig(matrixTest, read);
  if (config === null) return success([]);
  const resolved = compilerPaths(config, { read, parseJsonc }, new Set());
  if (!resolved.ok) return resolved;
  const { baseUrl, paths } = resolved.value;
  if (paths === null) return success([]);
  const base = baseUrl ?? paths.declaredIn;
  return success(paths.entries.map(([pattern, targets]): PathAlias => ({
    pattern,
    targets: targets.flatMap((target) => {
      const joined = within(base, target);
      return joined === null ? [] : [joined];
    }),
  })));
}
