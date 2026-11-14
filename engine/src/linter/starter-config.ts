/**
 * The starter config `lint-project --init` writes: every opt-in rule family
 * (`OPT_IN_CONFIG_KEYS`) that the project's layout lets us infer, filled in
 * only where the project has neither configured nor declined it.
 *
 * The paths below are the TARGET project's, so they are written plain, not as
 * references into this repository.
 *
 * - `pureModules`: the conventional functional-core roots the project has
 *   (TYPESCRIPT_PURE_ROOTS, JAVA_PURE_ROOTS).
 * - `boundaries`: the layered TypeScript structure of `typescript-patterns.md`
 *   (TYPESCRIPT_LAYERS: domain, orchestrator, infra, api, routes and config
 *   under src/), when at least two of those layers exist. Each layer allows
 *   exactly what it imports today and denies the layers its dependency arrows
 *   must not reach. A deny an import already breaks is left out and reported:
 *   boundary violations are not baselined, so writing it would block the next
 *   edit to that file over old code.
 * - `requireGovernance`: src/, when the boundaries cover every source file
 *   beneath it.
 * - `docReferences`: the project's documents (GOVERNED_DOCUMENTS), its plans
 *   directory and src as a source root.
 *
 * A family that cannot be inferred stays a gap, returned with the reason, so
 * `--init` can name it for a decision. Pure: the shell walks the tree and reads
 * each layer file's imports.
 */

import { extname } from "node:path";
import { OPT_IN_CONFIG_KEYS, type OptInConfigKey, type ProgrammaticConfig } from "./programmatic/config";
import { resolveImportPath, underPrefix, type BoundaryRule } from "./programmatic/no-cross-boundary-imports";
import { matchesModulePath } from "./programmatic/no-io-in-pure-modules";
import type { ReasonedPath } from "./types";
import { coverageGaps, lintCoverage } from "./lint-coverage";

export type ProjectLanguages = Readonly<{ typescript: boolean; java: boolean }>;

/** What the shell observed about a project. Every path is project-relative and
 *  forward-slashed. */
export type ProjectLayout = Readonly<{
  /** Every lintable file, before exclusions. */
  files: readonly string[];
  languages: ProjectLanguages;
  /** The import specifiers of each file under a layer directory, as written. */
  importsOf: ReadonlyMap<string, readonly string[]>;
  /** Whether the project keeps plans in `.claude/plans/`, which the walk never enters. */
  hasPlans: boolean;
}>;

/** A family `--init` could not infer, and why. */
export type UninferredFamily = Readonly<{ key: OptInConfigKey; why: string }>;

export type StarterInference = Readonly<{
  /** The config document to write: the stored one with every inferred family added. */
  document: Readonly<Record<string, unknown>>;
  /** The families this inference turned on. */
  inferred: readonly OptInConfigKey[];
  /** The gaps it could not fill. */
  uninferred: readonly UninferredFamily[];
  /** What was deliberately left out of an inferred family, for the operator. */
  notes: readonly string[];
}>;

/** One layer of the TypeScript package structure and the layers it must not import. */
type Layer = Readonly<{ dir: string; description: string; deny: readonly string[] }>;

/** `typescript-patterns.md` → Package Structure: dependency arrows point inward. */
export const TYPESCRIPT_LAYERS: readonly Layer[] = Object.freeze([
  { dir: "src/domain/", description: "The pure functional core: it imports no shell layer.", deny: ["src/orchestrator/", "src/infra/", "src/api/", "src/routes/", "src/config/"] },
  { dir: "src/orchestrator/", description: "Shell orchestrators: they reach I/O through the domain's ports, never through infra or the API layer.", deny: ["src/infra/", "src/api/", "src/routes/"] },
  { dir: "src/infra/", description: "Adapters implement the domain's ports; they never call orchestrators or the API layer.", deny: ["src/orchestrator/", "src/api/", "src/routes/"] },
  { dir: "src/api/", description: "The outermost shell: it calls orchestrators and the domain, never infra.", deny: ["src/infra/"] },
  { dir: "src/routes/", description: "The outermost shell: it calls orchestrators and the domain, never infra.", deny: ["src/infra/"] },
  { dir: "src/config/", description: "Wiring: it may import every layer.", deny: [] },
].map((layer) => Object.freeze({ ...layer, deny: Object.freeze(layer.deny) })));

const TYPESCRIPT_PURE_ROOTS: readonly string[] = ["src/domain/", "src/types/"];
const JAVA_PURE_ROOTS: readonly string[] = ["domain/model/", "domain/service/"];

const GOVERNED_DOCUMENTS: readonly ReasonedPath[] = Object.freeze([
  { path: "docs/", reason: "the project's documentation describes the tree as it is" },
  { path: "README.md", reason: "the entry document names the commands and files a reader starts from" },
  { path: "CONTEXT.md", reason: "the ubiquitous language names the code that realizes each term" },
  { path: "CONTEXT-MAP.md", reason: "the context map names the context files and modules" },
  { path: "CLAUDE.md", reason: "agent instructions name the files and commands an agent acts on" },
  { path: "AGENTS.md", reason: "agent instructions name the files and commands an agent acts on" },
]);

const PLANS: ReasonedPath = Object.freeze({
  path: ".claude/plans/",
  reason: "a plan cites its spec's ids and ADRs; it names files not built yet, so only those are resolved",
});

const GOVERNANCE_ROOT = "src/";

/** A family's inferred value, or why the layout does not allow one. */
type Inferred<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; why: string }>;
const inferred = <T>(value: T): Inferred<T> => Object.freeze({ ok: true, value });
const notInferred = (why: string): Inferred<never> => Object.freeze({ ok: false, why });

/**
 * The prefix an import is allowed by: a builtin scheme (`node:`), the package
 * of a bare specifier (`zod`, `@scope/pkg`), the layer a relative import lands
 * in, or else its first two directories (src/shared/ for src/shared/ids).
 */
export function importPrefix(file: string, specifier: string, layerDirs: readonly string[]): string {
  const scheme = /^([a-z]+):/.exec(specifier);
  if (scheme !== null) return `${scheme[1]}:`;
  if (!specifier.startsWith(".")) {
    const segments = specifier.split("/");
    return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  }
  const resolved = resolveImportPath(file, specifier);
  const layer = layerDirs.find((dir) => underPrefix(resolved, dir));
  if (layer !== undefined) return layer;
  const segments = resolved.split("/");
  return segments.length > 2 ? `${segments.slice(0, 2).join("/")}/` : resolved;
}

type InferredBoundaries = Readonly<{ boundaries: readonly BoundaryRule[]; notes: readonly string[] }>;

/** The layered boundaries, or the reason there are none. */
function inferBoundaries(layout: ProjectLayout): Inferred<InferredBoundaries> {
  if (!layout.languages.typescript) return notInferred("boundaries are inferred for TypeScript's layered src/ structure only");
  const present = TYPESCRIPT_LAYERS.filter((layer) => layout.files.some((file) => file.startsWith(layer.dir)));
  if (present.length < 2) {
    return notInferred(`fewer than two of ${TYPESCRIPT_LAYERS.map((layer) => layer.dir).join(", ")} exist, so there is no dependency direction to infer`);
  }
  const dirs = present.map((layer) => layer.dir);
  const layers = present.map((layer) => {
    const imports = layout.files
      .filter((file) => file.startsWith(layer.dir))
      .flatMap((file) => (layout.importsOf.get(file) ?? []).map((specifier) => importPrefix(file, specifier, dirs)));
    const observed = new Set(imports);
    const broken = layer.deny.filter((denied) => dirs.includes(denied) && observed.has(denied));
    const rule: BoundaryRule = Object.freeze({
      module: layer.dir,
      description: layer.description,
      allow: Object.freeze([...new Set([layer.dir, ...imports])].sort()),
      deny: Object.freeze(layer.deny.filter((denied) => dirs.includes(denied) && !observed.has(denied))),
    });
    const notes = broken.map((denied) =>
      `boundaries: ${layer.dir} already imports ${denied}, so that deny is left out — move those imports behind a port, then add "${denied}" to its deny list`);
    return { rule, notes };
  });
  return inferred(Object.freeze({
    boundaries: Object.freeze(layers.map(({ rule }) => rule)),
    notes: Object.freeze(layers.flatMap(({ notes }) => notes)),
  }));
}

/** `requireGovernance` on `src/`, when `boundaries` govern every source file beneath it. */
function inferGovernance(files: readonly string[], boundaries: readonly BoundaryRule[]): Inferred<readonly string[]> {
  const source = files.filter((file) => file.startsWith(GOVERNANCE_ROOT) && extname(file) !== ".md");
  const governed = source.length > 0 && source.every((file) => boundaries.some((boundary) => underPrefix(file, boundary.module)));
  return governed
    ? inferred(Object.freeze([GOVERNANCE_ROOT]))
    : notInferred(`the boundaries do not govern every source file under ${GOVERNANCE_ROOT}`);
}

function inferPureModules(layout: ProjectLayout): Inferred<readonly string[]> {
  const candidates = [
    ...(layout.languages.typescript ? TYPESCRIPT_PURE_ROOTS : []),
    ...(layout.languages.java ? JAVA_PURE_ROOTS : []),
  ];
  const present = candidates.filter((root) => layout.files.some((file) => matchesModulePath(file, root)));
  return present.length > 0
    ? inferred(Object.freeze(present))
    : notInferred(`none of the conventional functional-core roots (${[...TYPESCRIPT_PURE_ROOTS, ...JAVA_PURE_ROOTS].join(", ")}) exists`);
}

function inferDocReferences(layout: ProjectLayout): Inferred<Readonly<Record<string, unknown>>> {
  const govern = GOVERNED_DOCUMENTS.filter(({ path }) =>
    path.endsWith("/") ? layout.files.some((file) => file.startsWith(path) && extname(file) === ".md") : layout.files.includes(path));
  if (govern.length === 0) return notInferred(`no document to govern (${GOVERNED_DOCUMENTS.map(({ path }) => path).join(", ")})`);
  return inferred(Object.freeze({
    govern,
    ...(layout.hasPlans ? { plans: [PLANS] } : {}),
    ...(layout.files.some((file) => file.startsWith(GOVERNANCE_ROOT)) ? { sourceRoots: ["src"] } : {}),
  }));
}

/** The fields only a brand-new config gets: the size limits of the language. */
function freshDefaults(languages: ProjectLanguages): Readonly<Record<string, unknown>> {
  if (languages.java) return { maxFunctionLines: 40, excludeFromMaxLines: [".test.java", "Test.java"] };
  if (languages.typescript) return { maxFunctionLines: 50, excludeFromMaxLines: [".test.ts", ".spec.ts"] };
  return {};
}

/**
 * Infer every gap family `layout` allows. `stored` is the project's config
 * document as written (null when there is none) and `config` the same document
 * parsed; a configured or declined family is never touched.
 */
export function inferStarterConfig(
  stored: Readonly<Record<string, unknown>> | null,
  config: ProgrammaticConfig | null,
  layout: ProjectLayout,
): StarterInference {
  const gaps = config === null ? OPT_IN_CONFIG_KEYS : coverageGaps(lintCoverage(config));
  const layered = inferBoundaries(layout);
  const added = gaps.includes("boundaries") && layered.ok ? layered.value : null;
  const families: Readonly<Record<OptInConfigKey, Inferred<unknown>>> = {
    pureModules: inferPureModules(layout),
    boundaries: layered.ok ? inferred(layered.value.boundaries) : layered,
    // Governance is judged against the boundaries the project will have: its
    // own, plus the ones inferred here.
    requireGovernance: inferGovernance(layout.files, [...(config?.boundaries ?? []), ...(added?.boundaries ?? [])]),
    docReferences: inferDocReferences(layout),
  };
  const fields = Object.fromEntries(gaps.flatMap((key) => {
    const family = families[key];
    return family.ok ? [[key, family.value]] : [];
  }));
  return Object.freeze({
    document: Object.freeze({ ...(stored ?? freshDefaults(layout.languages)), ...fields }),
    inferred: Object.freeze(gaps.filter((key) => families[key].ok)),
    uninferred: Object.freeze(gaps.flatMap((key) => {
      const family = families[key];
      return family.ok ? [] : [Object.freeze({ key, why: family.why })];
    })),
    notes: added?.notes ?? Object.freeze([]),
  });
}
