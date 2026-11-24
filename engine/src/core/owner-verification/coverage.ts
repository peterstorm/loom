/**
 * Sibling coverage (AD-5; FR-005..FR-007): whether a matrix test's import
 * graph reaches every family path due by the Wave: its owned Invariant's
 * owner and each sibling entry point `duePaths` holds due. Pure: every
 * function here is a function of file text already read, the matrix test's
 * tsconfig `paths` and the due paths.
 *
 * - Resolution: a relative specifier tries the extension ladder (TypeScript
 *   sources, then JavaScript ones for an allowJs project) against the
 *   importing file's directory; a specifier matching a `paths` alias tries the
 *   same ladder on each substituted target, in order; a bare package or an
 *   absolute specifier is external and reaches nothing.
 * - Reach: the files the matrix test imports or re-exports directly, closed
 *   under re-export edges only. A plain import chain is never followed past
 *   its first hop: siblings import the owner, so a transitive closure would
 *   make the owner "reached" through any sibling and empty AS-003. A
 *   type-only edge is erased at runtime and never loads its module, so it is
 *   never followed: coverage means the module is loaded, not merely named.
 * - Decision: `covered`, or `missing` with every unreached due path in
 *   declared order, the owner first. Which paths are due is the family
 *   schedule's decision (`obligations.ts`), never this module's.
 *
 * One obligation reads one language (`language.ts`). A TypeScript matrix test
 * reaches its due paths through the import graph above; a Java one through
 * Java's own reach rule (`java-reach.ts`), which names files instead of
 * walking edges because Java has no re-exports. A due path no reader reads, or
 * a family mixing languages, is the `unsupported-language` infrastructure
 * failure, never a missing path.
 *
 * `siblingCoverage` drives the traversal itself (#133): it pulls each file it
 * needs through the `ReadModule` port the shell adapts the filesystem to, so
 * no traversal state crosses the seam, and loads the matrix test's tsconfig
 * aliases through the `LoadAliases` port only once the family is known to be
 * TypeScript. `coverageOverFiles` is the same decision over a file map.
 */

import { success, type NonEmpty } from "../orchestration-contract/identity";
import { moduleEdges, type EdgeKind, type ModuleEdges } from "./import-graph";
import { javaReachedDue } from "./java-reach";
import { obligationLanguageOf, type ObligationReading } from "./language";
import { directoryOf, normalizeRepoPath, within } from "./repo-path";
import type {
  CoverageOverFilesFn,
  CoverageVerdict,
  LoadAliases,
  ModuleRead,
  OwnerInfrastructureFailure,
  PathAlias,
  PathAliases,
  ReadModule,
  SiblingCoverageFn,
} from "./types";

/** The most present files the coverage walk may read before it is an infrastructure failure. */
export const COVERAGE_READ_BOUND = 512;

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

/**
 * TypeScript sources first, then JavaScript ones: a project with allowJs
 * imports a `.js` module by an extensionless specifier, and TypeScript tries
 * them in this order, so a TypeScript file still wins over a JavaScript one.
 */
const DIRECT_EXTENSIONS: readonly string[] = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** A JavaScript extension names its TypeScript source, as TypeScript resolves it. */
const SOURCE_FOR_EMITTED: readonly (readonly [string, readonly string[]])[] = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];
const INDEX_FILES: readonly string[] = ["index.ts", "index.tsx", "index.js", "index.jsx"];

/**
 * The files a resolved base path may name, in the order they are tried. A
 * specifier spelled with an emitted extension tries its TypeScript source
 * before the file it spells, as TypeScript does.
 */
const extensionLadder = (base: string): readonly string[] => {
  if (base === "") return INDEX_FILES;
  const sources = SOURCE_FOR_EMITTED.flatMap(([emitted, sourceExtensions]) =>
    base.endsWith(emitted) ? sourceExtensions.map((source) => `${base.slice(0, -emitted.length)}${source}`) : []);
  const direct = DIRECT_EXTENSIONS.map((extension) => `${base}${extension}`);
  const indexes = INDEX_FILES.map((index) => `${base}/${index}`);
  return [...new Set([...sources, ...direct, ...indexes])];
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
        detail: `the import walk of ${matrixTest} read more than ${bound} files (${present} present)`,
      };
      return undefined;
    }
    const edges = moduleEdges(path, file.text);
    known.set(path, edges);
    return edges;
  };
  return { edgesOf, failure: (): OwnerInfrastructureFailure | null => failure };
}

/**
 * The files the matrix test imports or re-exports directly, closed under
 * re-export edges only: the reach itself, unbounded, as a diagnostic. The
 * coverage decision (`siblingCoverage`, `coverageOverFiles`) adds the
 * `COVERAGE_READ_BOUND`.
 */
export const reachedFiles = (matrixTest: string, files: ReadonlyMap<string, string>, aliases: PathAliases): ReadonlySet<string> =>
  walk(matrixTest, boundedEdges(matrixTest, readFromMap(files), Number.POSITIVE_INFINITY).edgesOf, aliases);

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** `covered`, or every due path the reached files miss, in the order given (declared, the owner first). */
export const decideCoverage = (
  reached: ReadonlySet<string>,
  due: NonEmpty<string>,
): Extract<CoverageVerdict, { kind: "covered" | "missing" }> => {
  const [first, ...rest] = due.filter((path) => !reached.has(normalizeRepoPath(path) ?? path));
  if (first === undefined) return { kind: "covered" };
  const paths: NonEmpty<string> = [first, ...rest];
  return { kind: "missing", paths };
};

/** Coverage of the due paths from `matrixTest` over the port, bounded at `COVERAGE_READ_BOUND` present files. */
function typescriptCoverage(matrixTest: string, due: NonEmpty<string>, aliases: PathAliases, read: ReadModule): CoverageVerdict {
  const reader = boundedEdges(matrixTest, read, COVERAGE_READ_BOUND);
  const reached = walk(matrixTest, reader.edgesOf, aliases);
  const failure = reader.failure();
  return failure === null ? decideCoverage(reached, due) : { kind: "infrastructure", failure };
}

/**
 * A Java matrix test's coverage: the test's bytes decide reach by names
 * (`java-reach.ts`), so no import walk runs and the read bound does not apply.
 * The due paths themselves are still read, once each: a path that is not there
 * cannot be reached, and one the filesystem refuses is that read's
 * infrastructure failure — a family path is never reported covered on the
 * strength of a name alone. An absent test reaches nothing; an unreadable or
 * unparseable one is the infrastructure failure its read or parse is.
 */
function javaCoverage(family: JavaReading, due: NonEmpty<string>, read: ReadModule): CoverageVerdict {
  const matrixTest = family.matrixTest.path;
  const test = read(matrixTest);
  if (test.kind === "unreadable") return { kind: "infrastructure", failure: test.failure };
  if (test.kind === "absent") return decideCoverage(new Set(), due);
  const absent = new Set<string>();
  for (const path of due) {
    const file = read(path);
    if (file.kind === "unreadable") return { kind: "infrastructure", failure: file.failure };
    if (file.kind === "absent") absent.add(normalizeRepoPath(path) ?? path);
  }
  const reached = javaReachedDue({ matrixTest: family.matrixTest, matrixTestText: test.text, due: family.due });
  if (!reached.ok) {
    return {
      kind: "infrastructure",
      failure: {
        kind: "owner-unparseable",
        detail: `the matrix test ${matrixTest} does not parse, so the paths it reaches cannot be read: ${reached.error.diagnostics.join("; ")}`,
      },
    };
  }
  return decideCoverage(new Set([...reached.value].filter((path) => !absent.has(path))), due);
}

type JavaReading = Extract<ObligationReading, { language: "java" }>;

/**
 * The coverage decision for one obligation: its language (`language.ts`) picks
 * the reader, once; a family no reader reads is `unsupported-language`, never
 * a missing path. Only a TypeScript family loads its aliases, so a tsconfig
 * can neither mask a language refusal nor block a Java family.
 */
function coverageThrough(matrixTest: string, due: NonEmpty<string>, aliases: LoadAliases, read: ReadModule): CoverageVerdict {
  const reading = obligationLanguageOf({ matrixTest, due });
  if (!reading.ok) return { kind: "infrastructure", failure: reading.error };
  if (reading.value.language === "java") return javaCoverage(reading.value, due, read);
  const loaded = aliases();
  return loaded.ok ? typescriptCoverage(matrixTest, due, loaded.value, read) : { kind: "infrastructure", failure: loaded.error };
}

/**
 * Sibling coverage, driving its own traversal (#133): it pulls each file it
 * needs through `read`, at most once and in resolution order, so it reads
 * exactly the matrix test, then for each specifier its ladder candidates up
 * to the first present one, closed under re-exports. A refused read stops the
 * walk as that read's infrastructure failure, never a missing path; more than
 * `COVERAGE_READ_BOUND` present files is `coverage-bound-exceeded`. The
 * aliases are loaded through their port only for a TypeScript family.
 */
export const siblingCoverage: SiblingCoverageFn = ({ matrixTest, due, aliases, read }) =>
  coverageThrough(matrixTest, due, aliases, read);

/**
 * The production walk over a file map that holds every file there is, the
 * `COVERAGE_READ_BOUND` included: a map with more present files in reach
 * than the bound decides `coverage-bound-exceeded`, exactly as the gate
 * would. `reachedFiles` is the unbounded reach.
 */
export const coverageOverFiles: CoverageOverFilesFn = ({ matrixTest, due, files, aliases }) =>
  coverageThrough(matrixTest, due, () => success(aliases), readFromMap(files));
