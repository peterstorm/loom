/**
 * Sibling coverage (AD-5; FR-005..FR-007): whether a matrix test's import
 * graph reaches its owned Invariant's owner and every declared sibling entry
 * point. Pure: every function here is a function of file text already read,
 * the matrix test's tsconfig `paths` and the declared paths.
 *
 * - Resolution: a relative specifier tries the extension ladder against the
 *   importing file's directory; a specifier matching a `paths` alias tries the
 *   same ladder on each substituted target, in order; a bare package or an
 *   absolute specifier is external and reaches nothing.
 * - Reach: the files the matrix test imports or re-exports directly, closed
 *   under re-export edges only. A plain import chain is never followed past
 *   its first hop: siblings import the owner, so a transitive closure would
 *   make the owner "reached" through any sibling and empty AS-003. A
 *   type-only edge is erased at runtime and never loads its module, so it is
 *   never followed: coverage means the module is loaded, not merely named.
 * - Decision: `covered`, or `missing` with every unreached declared path in
 *   declared order, the owner first.
 *
 * The shell gathers the files with `coverageFrontier`, a bounded step it
 * drives until `complete`, then decides with `coverageOverFiles` over the
 * gathered files.
 */

import type { NonEmpty } from "../orchestration-contract/identity";
import { moduleEdges, type EdgeKind, type ModuleEdges } from "./import-graph";
import type {
  CoverageOverFilesFn,
  CoverageVerdict,
  OwnerInfrastructureFailure,
  OwnerObligation,
  PathAlias,
  PathAliases,
} from "./types";

/** The most files the coverage frontier may gather before it is an infrastructure failure. */
export const COVERAGE_FRONTIER_BOUND = 512;

// ---------------------------------------------------------------------------
// Repository-relative path arithmetic (no `node:path`: this module is pure)
// ---------------------------------------------------------------------------

/** Collapses `.`, `..` and empty segments; null when the path escapes the repository root. */
const normalizePath = (path: string): string | null => {
  const segments = path.split("/").reduce<readonly string[] | null>((kept, segment) => {
    if (kept === null || segment === "" || segment === ".") return kept;
    if (segment === "..") return kept.length === 0 ? null : kept.slice(0, -1);
    return [...kept, segment];
  }, []);
  return segments === null ? null : segments.join("/");
};

const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

const DIRECT_EXTENSIONS: readonly string[] = ["", ".ts", ".tsx", ".mts", ".cts"];
/** A JavaScript extension names its TypeScript source, as TypeScript resolves it. */
const SOURCE_FOR_EMITTED: readonly (readonly [string, readonly string[]])[] = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];
const INDEX_FILES: readonly string[] = ["index.ts", "index.tsx"];

/** The files a resolved base path may name, in the order they are tried. */
const extensionLadder = (base: string): readonly string[] => {
  if (base === "") return INDEX_FILES;
  const direct = DIRECT_EXTENSIONS.map((extension) => `${base}${extension}`);
  const sources = SOURCE_FOR_EMITTED.flatMap(([emitted, sourceExtensions]) =>
    base.endsWith(emitted) ? sourceExtensions.map((source) => `${base.slice(0, -emitted.length)}${source}`) : []);
  const indexes = INDEX_FILES.map((index) => `${base}/${index}`);
  return [...new Set([...direct, ...sources, ...indexes])];
};

const isRelative = (specifier: string): boolean =>
  specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");

type AliasMatch = Readonly<{ alias: PathAlias; captured: string; prefixLength: number }>;

const matchAlias = (specifier: string, alias: PathAlias): AliasMatch | null => {
  const star = alias.pattern.indexOf("*");
  if (star < 0) return alias.pattern === specifier ? { alias, captured: "", prefixLength: Number.POSITIVE_INFINITY } : null;
  const prefix = alias.pattern.slice(0, star);
  const suffix = alias.pattern.slice(star + 1);
  const fits = specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix);
  return fits ? { alias, captured: specifier.slice(prefix.length, specifier.length - suffix.length), prefixLength: prefix.length } : null;
};

/** TypeScript's `paths` choice: an exact pattern wins, then the longest wildcard prefix, then declared order. */
const bestAlias = (specifier: string, aliases: PathAliases): AliasMatch | null =>
  aliases.reduce<AliasMatch | null>((best, alias) => {
    const match = matchAlias(specifier, alias);
    return match !== null && (best === null || match.prefixLength > best.prefixLength) ? match : best;
  }, null);

const substitute = (target: string, captured: string): string => {
  const star = target.indexOf("*");
  return star < 0 ? target : `${target.slice(0, star)}${captured}${target.slice(star + 1)}`;
};

/** Every file a specifier may resolve to, in resolution order; empty for an external specifier. */
const resolutionCandidates = (from: string, specifier: string, aliases: PathAliases): readonly string[] => {
  const bases = (): readonly (string | null)[] => {
    if (isRelative(specifier)) return [normalizePath(`${directoryOf(from)}/${specifier}`)];
    if (specifier.startsWith("/")) return [];
    const match = bestAlias(specifier, aliases);
    return match === null ? [] : match.alias.targets.map((target) => normalizePath(substitute(target, match.captured)));
  };
  return [...new Set(bases().flatMap((base) => (base === null ? [] : extensionLadder(base))))];
};

/**
 * The repository file a specifier written in `from` names among the `known`
 * files, or null when it names none (external, escaping or unresolved).
 */
export const resolveSpecifier = (
  from: string,
  specifier: string,
  aliases: PathAliases,
  known: ReadonlySet<string>,
): string | null => resolutionCandidates(from, specifier, aliases).find((candidate) => known.has(candidate)) ?? null;

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

type Walk = Readonly<{ reached: ReadonlySet<string>; undecided: readonly string[] }>;

/** The specifiers of the edges, of the given kinds, that load their module at runtime. */
const loadedSpecifiers = (edges: ModuleEdges, kinds: readonly EdgeKind[]): readonly string[] =>
  edges.filter((edge) => !edge.typeOnly && kinds.includes(edge.kind)).map((edge) => edge.specifier);

/**
 * The one reach traversal both the decision and the frontier use. `decided`
 * says whether a path's existence is known (present in `edges` or known
 * absent); a specifier with an undecided candidate ahead of its first present
 * one is not followed, and those candidates are reported as `undecided`.
 */
const walk = (
  matrixTest: string,
  edgesOf: (path: string) => ModuleEdges | undefined,
  aliases: PathAliases,
  decided: (path: string) => boolean,
): Walk => {
  const matrixEdges = edgesOf(matrixTest);
  if (matrixEdges === undefined) return { reached: new Set(), undecided: decided(matrixTest) ? [] : [matrixTest] };

  const reached = new Set<string>();
  const undecided = new Set<string>();
  const queue: string[] = [];
  const follow = (from: string, specifiers: readonly string[]): void => {
    for (const specifier of specifiers) {
      const candidates = resolutionCandidates(from, specifier, aliases);
      const firstPresent = candidates.findIndex((candidate) => edgesOf(candidate) !== undefined);
      const ahead = firstPresent < 0 ? candidates : candidates.slice(0, firstPresent);
      const pending = ahead.filter((candidate) => !decided(candidate));
      pending.forEach((candidate) => undecided.add(candidate));
      const target = pending.length === 0 && firstPresent >= 0 ? candidates[firstPresent]! : null;
      if (target !== null && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  };

  follow(matrixTest, loadedSpecifiers(matrixEdges, ["import", "reexport"]));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) follow(next, loadedSpecifiers(edgesOf(next)!, ["reexport"]));
  return { reached, undecided: [...undecided].sort() };
};

/** Memoized edges over a file map: a file is parsed only when the walk reaches it. */
const edgesOver = (files: ReadonlyMap<string, string>): ((path: string) => ModuleEdges | undefined) => {
  const parsed = new Map<string, ModuleEdges>();
  return (path) => {
    const text = files.get(path);
    if (text === undefined) return undefined;
    const known = parsed.get(path) ?? moduleEdges(path, text);
    parsed.set(path, known);
    return known;
  };
};

/** The files the matrix test imports or re-exports directly, closed under re-export edges only. */
export const reachedFiles = (matrixTest: string, files: ReadonlyMap<string, string>, aliases: PathAliases): ReadonlySet<string> =>
  walk(matrixTest, edgesOver(files), aliases, () => true).reached;

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** `covered`, or every declared path the reached files miss, in declared order with the owner first. */
export const decideCoverage = (
  reached: ReadonlySet<string>,
  obligation: OwnerObligation,
): Extract<CoverageVerdict, { kind: "covered" | "missing" }> => {
  const declared = [obligation.owner, ...obligation.siblings.map((sibling) => sibling.path)];
  const [first, ...rest] = declared.filter((path) => !reached.has(normalizePath(path) ?? path));
  if (first === undefined) return { kind: "covered" };
  const paths: NonEmpty<string> = [first, ...rest];
  return { kind: "missing", paths };
};

export const coverageOverFiles: CoverageOverFilesFn = ({ matrixTest, obligation, files, aliases }) =>
  decideCoverage(reachedFiles(matrixTest, files, aliases), obligation);

// ---------------------------------------------------------------------------
// The bounded frontier the shell drives
// ---------------------------------------------------------------------------

/**
 * What the shell has gathered: every file read (`files`) with its parsed
 * edges, and every path requested so far. A requested path missing from
 * `files` is known absent; the shell reports a directory or an unreadable
 * candidate path as absent by leaving it out of the read.
 */
export type CoverageGraphState = Readonly<{
  matrixTest: string;
  aliases: PathAliases;
  files: ReadonlyMap<string, string>;
  edges: ReadonlyMap<string, ModuleEdges>;
  requested: ReadonlySet<string>;
}>;

/**
 * One frontier step: `read` names the paths the shell reads next (each
 * either present with its text, or absent); `complete` means `state.files`
 * now decides coverage exactly as the whole repository would;
 * `bound-exceeded` is the `coverage-bound-exceeded` infrastructure failure.
 */
export type CoverageFrontierStep =
  | Readonly<{ kind: "read"; next: NonEmpty<string>; state: CoverageGraphState }>
  | Readonly<{ kind: "complete"; state: CoverageGraphState }>
  | Readonly<{ kind: "bound-exceeded"; failure: OwnerInfrastructureFailure }>;

export const initialCoverageState = (matrixTest: string, aliases: PathAliases): CoverageGraphState => ({
  matrixTest,
  aliases,
  files: new Map(),
  edges: new Map(),
  requested: new Set(),
});

/**
 * Folds the files the shell just read (those of the last `next` that exist)
 * into the state and names what to read next, refusing to gather more than
 * `COVERAGE_FRONTIER_BOUND` files.
 */
export const coverageFrontier = (state: CoverageGraphState, read: ReadonlyMap<string, string>): CoverageFrontierStep => {
  const files = new Map([...state.files, ...read]);
  if (files.size > COVERAGE_FRONTIER_BOUND) {
    return {
      kind: "bound-exceeded",
      failure: {
        kind: "coverage-bound-exceeded",
        detail: `the import frontier of ${state.matrixTest} exceeded ${COVERAGE_FRONTIER_BOUND} files (${files.size} gathered)`,
      },
    };
  }
  const edges = new Map([...state.edges, ...[...read].map(([path, text]) => [path, moduleEdges(path, text)] as const)]);
  const requested = new Set([...state.requested, ...read.keys()]);
  const { undecided } = walk(state.matrixTest, (path) => edges.get(path), state.aliases, (path) => requested.has(path));
  const next: CoverageGraphState = { ...state, files, edges, requested: new Set([...requested, ...undecided]) };
  const [first, ...rest] = undecided;
  return first === undefined ? { kind: "complete", state: next } : { kind: "read", next: [first, ...rest], state: next };
};
