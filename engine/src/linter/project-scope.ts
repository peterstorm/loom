/**
 * What the project linter reads: EVERYTHING with a lintable extension, minus
 * one explicit, reasoned exclusion list (`exclude` in the project's
 * `config.json`).
 *
 * The pure half of `scripts/lint-project.ts`: the walk (a shell) asks this
 * module which directories hold no source, which names are lintable, which
 * project paths are excluded and why, and which scoping entries have stopped
 * naming anything. Every answer is a function of strings in, data out.
 *
 * Test files are linted too. A rule that does not apply to tests says so
 * itself (`isTestFile`, a regex rule's `excludePatterns`) — the walk never
 * decides for every rule at once.
 */

import { extname } from "node:path";
import type { ProgrammaticConfig } from "./programmatic/config";
import type { ReasonedPath } from "./types";
import { underPrefix } from "./programmatic/no-cross-boundary-imports";
import { classifyPurity, matchesModulePath, type PurityScope } from "./programmatic/no-io-in-pure-modules";

/** Every extension some rule may read. A file with any other extension holds
 *  nothing to lint. Markdown is read by no-dangling-doc-reference alone. */
export const LINTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".java", ".kt", ".scala",
  ".md",
]);

/**
 * Directory names that never hold a project's own source — dependencies, VCS
 * metadata, harness state and build or tool output. Not an exclusion list:
 * nothing in them is the project's code to lint, in any project. A project's
 * own vendored or generated code that lives elsewhere is excluded explicitly,
 * with its reason, in `config.json`.
 */
export const NEVER_SOURCE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".claude", ".pi", "dist", "build", "out",
  ".next", "target", ".gradle", "__pycache__",
  ".direnv", ".devenv", ".nix-defexpr", "result",
  // A Python virtualenv: `nix develop`/direnv shells create one at the project
  // root, so it exists on one developer's machine and not on CI's. A project
  // `exclude` entry for it is stale exactly where it is absent.
  ".venv",
  "vendor", "coverage", ".turbo", ".cache",
]);

/** Does a file name carry a lintable extension? */
export const isLintableName = (name: string): boolean => LINTABLE_EXTENSIONS.has(extname(name));

/** Does a directory name hold no project source? */
export const isNeverSourceDirectory = (name: string): boolean => NEVER_SOURCE_DIRECTORIES.has(name);

/**
 * The paths a project's config governs that the walk never enters: a
 * `docReferences` entry beneath a directory that never holds source, such as
 * `.claude/plans/`. `lint-project` walks each of them besides the project, so
 * a governed plan is linted in the full tier, not only when it is edited.
 */
export function walkedBesides(config: ProgrammaticConfig): readonly string[] {
  const scope = config.docReferences;
  if (scope === undefined) return [];
  return [...scope.govern, ...scope.plans]
    .map(({ path }) => path)
    .filter((path) => path.split("/").some(isNeverSourceDirectory));
}

/** One project path's place in the lint scope. */
export type ScopeDecision =
  | Readonly<{ kind: "lint" }>
  | Readonly<{ kind: "excluded"; exclusion: ReasonedPath }>;

/**
 * A project's `exclude` list as the scope reads it. Named here so a reader of
 * the scope (the clone corpus) depends on this module alone, not on the config
 * schema under `programmatic/`.
 */
export type Exclusions = readonly ReasonedPath[];

/**
 * Is this project-relative path under an exclusion entry? Anchored: an entry
 * names a path from the project root, never a suffix that might recur deeper.
 */
export const isUnderEntry = (relativePath: string, entry: string): boolean =>
  entry.endsWith("/") ? relativePath.startsWith(entry) : relativePath === entry;

/** Where one project-relative file stands: linted, or excluded with its reason. */
export function scopeOf(relativePath: string, exclusions: Exclusions): ScopeDecision {
  const normalized = relativePath.replace(/\\/g, "/");
  const exclusion = exclusions.find(({ path }) => isUnderEntry(normalized, path));
  return exclusion === undefined ? { kind: "lint" } : { kind: "excluded", exclusion };
}

/**
 * Every scoping entry that no longer names anything in the project — the decay
 * a list that only subtracts cannot report on its own. `files` is every
 * lintable project-relative path BEFORE exclusions.
 *
 * - an exclusion that matches no file excludes nothing;
 * - a pure root, a boundary module or a governance root that matches no file
 *   is a typo or a moved directory, so its rule checks nothing there;
 * - a declared shell (`impureModules`) is stale unless it names a file that a
 *   pure root would otherwise hold to purity;
 * - a per-file capability grant is stale when its file is gone;
 * - a doc-reference scope entry or source root that matches no file governs,
 *   carves out or frames nothing.
 */
export function scopeDrift(config: ProgrammaticConfig, files: readonly string[]): readonly string[] {
  const none = (matches: (file: string) => boolean): boolean => !files.some(matches);
  const pure: PurityScope = { pureModules: config.pureModules ?? [], impureModules: [] };
  return [
    ...(config.exclude ?? [])
      .filter(({ path }) => none((file) => isUnderEntry(file, path)))
      .map(({ path }) => `exclude: ${path} (matches no file — delete the exclusion)`),
    ...(config.pureModules ?? [])
      .filter((entry) => none((file) => matchesModulePath(file, entry)))
      .map((entry) => `pureModules: ${entry} (matches no file — fix or delete the root)`),
    ...(config.impureModules ?? [])
      .filter(({ path }) => none((file) => matchesModulePath(file, path) && classifyPurity(file, pure).kind === "pure"))
      .map(({ path }) => `impureModules: ${path} (names no file under a pure root — delete the entry)`),
    ...(config.requireGovernance ?? [])
      .filter((root) => none((file) => underPrefix(file, root)))
      .map((root) => `requireGovernance: ${root} (matches no file — fix or delete the root)`),
    ...(config.boundaries ?? []).flatMap((boundary) => [
      ...(none((file) => underPrefix(file, boundary.module))
        ? [`boundaries: ${boundary.module} (governs no file — fix or delete the boundary)`]
        : []),
      ...[...Object.keys(boundary.perFileAllow ?? {}), ...Object.keys(boundary.perFileExactAllow ?? {})]
        .filter((granted) => !files.includes(granted))
        .map((granted) => `boundaries: ${boundary.module} grants ${granted} (no such file — delete the grant)`),
    ]),
    ...docReferenceDrift(config, none),
  ];
}

/** The doc-reference scope entries and source roots that match no file. */
function docReferenceDrift(config: ProgrammaticConfig, none: (matches: (file: string) => boolean) => boolean): readonly string[] {
  const scope = config.docReferences;
  if (scope === undefined) return [];
  const lists = [["govern", scope.govern], ["plans", scope.plans], ["exclude", scope.exclude]] as const;
  return [
    ...lists.flatMap(([key, entries]) => entries
      .filter(({ path }) => none((file) => isUnderEntry(file, path)))
      .map(({ path }) => `docReferences.${key}: ${path} (matches no file — fix or delete the entry)`)),
    ...scope.sourceRoots
      .filter((root) => none((file) => file.startsWith(`${root}/`)))
      .map((root) => `docReferences.sourceRoots: ${root} (holds no file — fix or delete the root)`),
  ];
}
