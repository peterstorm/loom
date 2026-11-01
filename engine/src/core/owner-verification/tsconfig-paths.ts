/**
 * A matrix test's tsconfig `paths`, made repository-relative (ADR-0035):
 * the input `siblingCoverage` resolves aliased imports with. Pure: both
 * effects are injected. Files are read through the same `ReadModule` port
 * coverage uses, so a config the filesystem refuses is that read's
 * infrastructure failure, never a config that is not there; `parseJsonc`
 * reads a config's JSONC text into a value, or says why it does not parse.
 * The shell (`orchestration/owner-verification-runner.ts`) adapts its total
 * repository read and `jsonc-parser`, the one module granted that package.
 */

import { failure, success, type DomainResult } from "../orchestration-contract/identity";
import { directoryOf, within } from "./repo-path";
import type { OwnerInfrastructureFailure, PathAlias, PathAliases, ReadModule } from "./types";

/** A config's JSONC text as a value, or why it does not parse. */
export type ParseJsonc = (text: string) => DomainResult<unknown, string>;

/**
 * Why the aliases are unknown: a config file the filesystem refused
 * (`unreadable`, carrying that read's failure; the first refusal stops the
 * resolution), or a config chain that does not resolve (`unresolvable`: a
 * parse error, a malformed `extends`, `baseUrl` or `paths`, a missing parent
 * or a cycle).
 */
export type AliasConfigError =
  | Readonly<{ kind: "unreadable"; failure: OwnerInfrastructureFailure }>
  | Readonly<{ kind: "unresolvable"; reason: string }>;

type Resolved<T> = DomainResult<T, AliasConfigError>;

const unresolvable = <T>(reason: string): Resolved<T> => failure({ kind: "unresolvable", reason });

type PathEntries = readonly (readonly [string, readonly string[]])[];

type CompilerPaths = Readonly<{
  /** The repository-relative directory `baseUrl` names, when a config in the chain declares one. */
  baseUrl: string | null;
  /** The declared `paths` and the directory of the config that declared them. */
  paths: Readonly<{ entries: PathEntries; declaredIn: string }> | null;
}>;

type ConfigRecord = Readonly<Record<string, unknown>>;

/** What a config chain reads: the files and the JSONC parser. */
type ConfigReader = Readonly<{ read: ReadModule; parseJsonc: ParseJsonc }>;

const NO_PATHS: CompilerPaths = Object.freeze({ baseUrl: null, paths: null });

/** The first candidate that is present, in order; null when none is; the first refused read stops the search. */
function firstPresent(candidates: readonly string[], read: ReadModule): Resolved<string | null> {
  for (const candidate of candidates) {
    const file = read(candidate);
    if (file.kind === "unreadable") return failure({ kind: "unreadable", failure: file.failure });
    if (file.kind === "text") return success(candidate);
  }
  return success(null);
}

/** The directories from `start` up to the repository root, nearest first. */
function upward(start: string): readonly string[] {
  const directories: string[] = [];
  for (let directory = start; ; directory = directoryOf(directory)) {
    directories.push(directory);
    if (directory === "") return directories;
  }
}

/** The nearest `tsconfig.json` from the matrix test's directory up to the repository root. */
export function nearestTsconfig(matrixTest: string, read: ReadModule): Resolved<string | null> {
  return firstPresent(upward(directoryOf(matrixTest)).map((directory) => directory === "" ? "tsconfig.json" : `${directory}/tsconfig.json`), read);
}

/** The config file an `extends` entry names: relative to the extending config, or a package beneath a `node_modules`. */
export function extendedConfig(from: string, specifier: string, read: ReadModule): Resolved<string | null> {
  const withJson = (path: string): readonly string[] => path.endsWith(".json") ? [path] : [path, `${path}.json`, `${path}/tsconfig.json`];
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const base = within(directoryOf(from), specifier);
    return base === null ? success(null) : firstPresent(withJson(base), read);
  }
  const candidates = upward(directoryOf(from)).flatMap((directory) => {
    const base = within(directory, `node_modules/${specifier}`);
    return base === null ? [] : withJson(base);
  });
  return firstPresent(candidates, read);
}

const isRecord = (value: unknown): value is ConfigRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** One config file read and parsed into its top-level object. */
function configRecord(config: string, reader: ConfigReader): Resolved<ConfigRecord> {
  const file = reader.read(config);
  if (file.kind === "unreadable") return failure({ kind: "unreadable", failure: file.failure });
  if (file.kind === "absent") return unresolvable(`tsconfig ${config} cannot be read`);
  const parsed = reader.parseJsonc(file.text);
  if (!parsed.ok) return unresolvable(`tsconfig ${config} does not parse: ${parsed.error}`);
  return isRecord(parsed.value) ? success(parsed.value) : unresolvable(`tsconfig ${config} is not an object`);
}

/** The `baseUrl` and `paths` the configs `config` extends contribute, the later overriding the earlier. */
function inheritedPaths(config: string, record: ConfigRecord, reader: ConfigReader, seen: ReadonlySet<string>): Resolved<CompilerPaths> {
  const extendsField = record.extends;
  const parents = extendsField === undefined ? [] : typeof extendsField === "string" ? [extendsField] : extendsField;
  if (!isStrings(parents)) return unresolvable(`tsconfig ${config} has an extends that is not a string or a string array`);
  let inherited = NO_PATHS;
  for (const parent of parents) {
    const file = extendedConfig(config, parent, reader.read);
    if (!file.ok) return file;
    if (file.value === null) return unresolvable(`tsconfig ${config} extends ${parent}, which cannot be found`);
    const parentPaths = compilerPaths(file.value, reader, new Set([...seen, config]));
    if (!parentPaths.ok) return parentPaths;
    inherited = { baseUrl: parentPaths.value.baseUrl ?? inherited.baseUrl, paths: parentPaths.value.paths ?? inherited.paths };
  }
  return success(inherited);
}

/** A declared `paths` object as its entries, each pattern with its string targets. */
function pathEntries(config: string, paths: unknown): Resolved<PathEntries> {
  if (!isRecord(paths)) return unresolvable(`tsconfig ${config} paths is not an object`);
  const entries: (readonly [string, readonly string[]])[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!isStrings(targets)) return unresolvable(`tsconfig ${config} paths.${pattern} is not a string array`);
    entries.push([pattern, targets]);
  }
  return success(entries);
}

/** The config's own `compilerOptions` over what it inherits. */
function ownPaths(config: string, options: unknown, inherited: CompilerPaths): Resolved<CompilerPaths> {
  if (options === undefined) return success(inherited);
  if (!isRecord(options)) return unresolvable(`tsconfig ${config} compilerOptions is not an object`);
  let baseUrl = inherited.baseUrl;
  if (options.baseUrl !== undefined) {
    if (typeof options.baseUrl !== "string") return unresolvable(`tsconfig ${config} baseUrl is not a string`);
    baseUrl = within(directoryOf(config), options.baseUrl);
    if (baseUrl === null) return unresolvable(`tsconfig ${config} baseUrl ${options.baseUrl} escapes the repository`);
  }
  if (options.paths === undefined) return success({ baseUrl, paths: inherited.paths });
  const entries = pathEntries(config, options.paths);
  return entries.ok ? success({ baseUrl, paths: { entries: entries.value, declaredIn: directoryOf(config) } }) : entries;
}

/** One config's `baseUrl` and `paths` over the configs it extends, the later overriding the earlier. */
function compilerPaths(config: string, reader: ConfigReader, seen: ReadonlySet<string>): Resolved<CompilerPaths> {
  if (seen.has(config)) return unresolvable(`tsconfig ${config} extends itself`);
  const record = configRecord(config, reader);
  if (!record.ok) return record;
  const inherited = inheritedPaths(config, record.value, reader, seen);
  return inherited.ok ? ownPaths(config, record.value.compilerOptions, inherited.value) : inherited;
}

/**
 * The matrix test's tsconfig `paths`, made repository-relative: targets resolve
 * against `baseUrl` when the chain declares one, otherwise against the
 * directory of the config that declared `paths`, as TypeScript resolves them.
 * Empty when no tsconfig governs the matrix test; refused when a config is
 * unreadable or the chain does not resolve, since its aliases would then be
 * unknown.
 */
export function pathAliasesOf(matrixTest: string, read: ReadModule, parseJsonc: ParseJsonc): Resolved<PathAliases> {
  const config = nearestTsconfig(matrixTest, read);
  if (!config.ok) return config;
  if (config.value === null) return success([]);
  const resolved = compilerPaths(config.value, { read, parseJsonc }, new Set());
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
