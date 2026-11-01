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
 * `siblingCoverage` drives the traversal itself (#133): it pulls each file it
 * needs through the `ReadModule` port the shell adapts the filesystem to, so
 * no frontier state crosses the seam. `coverageOverFiles` is the same
 * decision over a file map.
 */

import type { NonEmpty } from "../orchestration-contract/identity";
import { moduleEdges, type EdgeKind, type ModuleEdges } from "./import-graph";
import { directoryOf, normalizeRepoPath, within } from "./repo-path";
import type {
  CoverageOverFilesFn,
  CoverageVerdict,
  ModuleRead,
  OwnerInfrastructureFailure,
  OwnerObligation,
  PathAlias,
  PathAliases,
  ReadModule,
  SiblingCoverageFn,
} from "./types";

/** The most present files the coverage walk may read before it is an infrastructure failure. */
export const COVERAGE_FRONTIER_BOUND = 512;

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
    if (isRelative(specifier)) return [within(directoryOf(from), specifier)];
    if (specifier.startsWith("/")) return [];
    const match = bestAlias(specifier, aliases);
    return match === null ? [] : match.alias.targets.map((target) => normalizeRepoPath(substitute(target, match.captured)));
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

/** The specifiers of the edges, of the given kinds, that load their module at runtime. */
const loadedSpecifiers = (edges: ModuleEdges, kinds: readonly EdgeKind[]): readonly string[] =>
  edges.filter((edge) => !edge.typeOnly && kinds.includes(edge.kind)).map((edge) => edge.specifier);

/**
 * The one reach traversal. `edgesOf` is a path's parsed edges, or undefined
 * when it is absent; each specifier follows its first present candidate, so
 * a lazy `edgesOf` is asked only for the ladder candidates up to that one.
 */
const walk = (
  matrixTest: string,
  edgesOf: (path: string) => ModuleEdges | undefined,
  aliases: PathAliases,
): ReadonlySet<string> => {
  const reached = new Set<string>();
  const matrixEdges = edgesOf(matrixTest);
  if (matrixEdges === undefined) return reached;
  const queue: string[] = [];
  const follow = (from: string, specifiers: readonly string[]): void => {
    for (const specifier of specifiers) {
      const target = resolutionCandidates(from, specifier, aliases).find((candidate) => edgesOf(candidate) !== undefined);
      if (target !== undefined && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  };

  follow(matrixTest, loadedSpecifiers(matrixEdges, ["import", "reexport"]));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const edges = edgesOf(next);
    if (edges !== undefined) follow(next, loadedSpecifiers(edges, ["reexport"]));
  }
  return reached;
};

/** The one `absent` read, shared by every adapter of the coverage port. */
export const MODULE_ABSENT: ModuleRead = Object.freeze({ kind: "absent" });

/** A file map as the coverage port: a mapped path is its text, any other path is absent. */
const readFromMap = (files: ReadonlyMap<string, string>): ReadModule => (path) => {
  const text = files.get(path);
  return text === undefined ? MODULE_ABSENT : { kind: "text", text };
};

/**
 * The port as the walk reads it: each path is read at most once and parsed
 * only when present. The first refused read, or the present file past
 * `bound`, becomes the infrastructure failure, and from then on every path
 * reads as absent so the walk winds down without reading further.
 */
function boundedEdges(matrixTest: string, read: ReadModule, bound: number) {
  const known = new Map<string, ModuleEdges | null>();
  let present = 0;
  let failure: OwnerInfrastructureFailure | null = null;
  const edgesOf = (path: string): ModuleEdges | undefined => {
    if (failure !== null) return undefined;
    const seen = known.get(path);
    if (seen !== undefined) return seen ?? undefined;
    const file = read(path);
    if (file.kind === "unreadable") {
      failure = file.failure;
      return undefined;
    }
    if (file.kind === "absent") {
      known.set(path, null);
      return undefined;
    }
    present += 1;
    if (present > bound) {
      failure = {
        kind: "coverage-bound-exceeded",
        detail: `the import frontier of ${matrixTest} exceeded ${bound} files (${present} gathered)`,
      };
      return undefined;
    }
    const edges = moduleEdges(path, file.text);
    known.set(path, edges);
    return edges;
  };
  return { edgesOf, failure: (): OwnerInfrastructureFailure | null => failure };
}

/** The files the matrix test imports or re-exports directly, closed under re-export edges only. */
export const reachedFiles = (matrixTest: string, files: ReadonlyMap<string, string>, aliases: PathAliases): ReadonlySet<string> =>
  walk(matrixTest, boundedEdges(matrixTest, readFromMap(files), Number.POSITIVE_INFINITY).edgesOf, aliases);

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** `covered`, or every declared path the reached files miss, in declared order with the owner first. */
export const decideCoverage = (
  reached: ReadonlySet<string>,
  obligation: OwnerObligation,
): Extract<CoverageVerdict, { kind: "covered" | "missing" }> => {
  const declared = [obligation.owner, ...obligation.siblings.map((sibling) => sibling.path)];
  const [first, ...rest] = declared.filter((path) => !reached.has(normalizeRepoPath(path) ?? path));
  if (first === undefined) return { kind: "covered" };
  const paths: NonEmpty<string> = [first, ...rest];
  return { kind: "missing", paths };
};

/** Coverage from `matrixTest` over the port, bounded at `COVERAGE_FRONTIER_BOUND` present files. */
function coverageThrough(matrixTest: string, obligation: OwnerObligation, aliases: PathAliases, read: ReadModule): CoverageVerdict {
  const reader = boundedEdges(matrixTest, read, COVERAGE_FRONTIER_BOUND);
  const reached = walk(matrixTest, reader.edgesOf, aliases);
  const failure = reader.failure();
  return failure === null ? decideCoverage(reached, obligation) : { kind: "infrastructure", failure };
}

/**
 * Sibling coverage, driving its own traversal (#133): it pulls each file it
 * needs through `read`, at most once and in resolution order, so it reads
 * exactly the matrix test, then for each specifier its ladder candidates up
 * to the first present one, closed under re-exports. A refused read stops the
 * walk as that read's infrastructure failure, never a missing path; more than
 * `COVERAGE_FRONTIER_BOUND` present files is `coverage-bound-exceeded`.
 */
export const siblingCoverage: SiblingCoverageFn = ({ obligation, aliases, read }) =>
  coverageThrough(obligation.matrixTest, obligation, aliases, read);

/** The same decision over a file map that holds every file there is: the whole-repository oracle. */
export const coverageOverFiles: CoverageOverFilesFn = ({ matrixTest, obligation, files, aliases }) =>
  coverageThrough(matrixTest, obligation, aliases, readFromMap(files));
