#!/usr/bin/env bun
/**
 * loom-lint — Run loom linter rules against a codebase.
 *
 * Generic runner that works in any project. Finds the project root and its rules
 * directory, and runs the full-tier linter across EVERY lintable file — tests
 * included — minus the project's explicit, reasoned `exclude` list in
 * config.json. Rules that do not apply to tests exclude them per rule.
 *
 * Usage:
 *   bun /path/to/loom/scripts/lint-project.ts [options] [file patterns...]
 *
 * Options:
 *   --init          Turn every rule family on: infer boundaries, the pure core,
 *                   governance and doc references from the layout into the
 *                   project's config.json (creating it; filling only families
 *                   neither configured nor declined), then baseline existing debt
 *   --tier=full     Run full tier (default: full)
 *   --tier=immediate  Run immediate tier only (regex rules, the import-boundary rules, switch-totality,
 *                   no-duplicate-block, no-wire-cast and no-dangling-doc-reference, fast)
 *   --no-baseline-check  Skip the staleness pass (grandfathered baselines and
 *                   scoping entries — exclusions, pure roots, shells, boundaries,
 *                   external names — that no longer name anything)
 *   --write-baseline  Record every pre-existing totality site, copied block, wire cast,
 *                   dangling doc reference and over-long function in the project's config.json
 *                   (switchTotalityBaseline, discriminantBranchingBaseline,
 *                   duplicateBlockBaseline, wireCastBaseline, docReferenceBaseline,
 *                   maxFunctionLinesBaseline), then exit
 *   --json          Output raw JSON violations
 *   --summary       Show only summary counts
 *   --fix-hints     Show fix hints (default: true)
 *   --no-fix-hints  Hide fix hints
 *
 * A full-tier run fails on a coverage gap: an opt-in rule family (boundaries,
 * pureModules, requireGovernance, docReferences) a set-up project has neither
 * configured nor declined in config.json's `declined` list. A project with no
 * rules directory is told so (stderr, or `coverage: "no-setup"` in --json)
 * without failing.
 *
 * Examples:
 *   bun lint-project.ts                    # Lint every lintable file in the project
 *   bun lint-project.ts packages/core/     # Lint specific directory (exclusions still apply)
 *   bun lint-project.ts --init             # Setup linter config
 *   bun lint-project.ts --write-baseline   # Grandfather existing unproven switches/chains and copied blocks
 *   bun lint-project.ts --summary          # Just counts
 */

import { resolve, join, extname, dirname, relative, sep } from "node:path";
import { statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
// The engine is loaded at runtime from THIS script's own loom installation, and
// typed from the same modules: a type-only import erases at runtime, so the
// shapes the script consumes (the baseline owner, the lint result) are the
// engine's own, checked by the compiler instead of mirrored by hand.
import type * as LinterIndex from "../engine/src/linter/index.ts";
import type * as LinterConfig from "../engine/src/linter/programmatic/config.ts";
import type * as ProjectRoot from "../engine/src/linter/project-root.ts";
import type * as LinterLoader from "../engine/src/linter/loader.ts";
import type * as ProjectScope from "../engine/src/linter/project-scope.ts";
import type * as ProjectWalk from "../engine/src/linter/project-walk.ts";
import type * as DocReferenceRule from "../engine/src/linter/programmatic/no-dangling-doc-reference.ts";
import type { ReasonedPath } from "../engine/src/linter/types.ts";
import type * as ProgrammaticRules from "../engine/src/linter/programmatic/index.ts";
import type * as Baselines from "../engine/src/linter/programmatic/baseline.ts";
import type * as BaselineConfig from "../engine/src/linter/programmatic/baseline-config.ts";
import type { BaselineOwner } from "../engine/src/linter/programmatic/baseline.ts";
import type * as StarterConfig from "../engine/src/linter/starter-config.ts";
import type * as BoundaryRule from "../engine/src/linter/programmatic/no-cross-boundary-imports.ts";

// ---------------------------------------------------------------------------
// Resolve loom installation
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const LOOM_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_RULES_DIR = join(LOOM_ROOT, "lint-rules");

if (!existsSync(DEFAULT_RULES_DIR)) {
  console.error(`ERROR: Cannot find loom default rules at ${DEFAULT_RULES_DIR}`);
  console.error("Ensure this script is located at <loom-root>/scripts/lint-project.ts");
  process.exit(2);
}

const { coverageGapLine, coverageGaps, lintCoverage, lintFiles }: typeof LinterIndex =
  await import(join(LOOM_ROOT, "engine/src/linter/index.ts"));
const { inferStarterConfig, parseStoredConfig, TYPESCRIPT_LAYERS }: typeof StarterConfig =
  await import(join(LOOM_ROOT, "engine/src/linter/starter-config.ts"));
const { extractImports }: typeof BoundaryRule =
  await import(join(LOOM_ROOT, "engine/src/linter/programmatic/no-cross-boundary-imports.ts"));
const { CLAUDE_PROJECT_RULES_DIR, PI_PROJECT_RULES_DIR, PROJECT_RULES_LAYOUTS, projectRulesLayout }: typeof LinterConfig =
  await import(join(LOOM_ROOT, "engine/src/linter/programmatic/config.ts"));
const { findProjectRoot }: typeof ProjectRoot = await import(join(LOOM_ROOT, "engine/src/linter/project-root.ts"));
const { authoritativeLintContext, loadProjectConfig }: typeof LinterLoader = await import(join(LOOM_ROOT, "engine/src/linter/loader.ts"));
const { scopeOf, scopeDrift }: typeof ProjectScope =
  await import(join(LOOM_ROOT, "engine/src/linter/project-scope.ts"));
const { lintedProjectFiles, walkLintableFiles }: typeof ProjectWalk =
  await import(join(LOOM_ROOT, "engine/src/linter/project-walk.ts"));
const { externalNameDrift, readingOf }: typeof DocReferenceRule =
  await import(join(LOOM_ROOT, "engine/src/linter/programmatic/no-dangling-doc-reference.ts"));
const { baselineOwners }: typeof ProgrammaticRules = await import(join(LOOM_ROOT, "engine/src/linter/programmatic/index.ts"));
const { staleBaselineEntries }: typeof Baselines = await import(join(LOOM_ROOT, "engine/src/linter/programmatic/baseline.ts"));
const { configWithBaselines, recordedBaselines }: typeof BaselineConfig =
  await import(join(LOOM_ROOT, "engine/src/linter/programmatic/baseline-config.ts"));

// ---------------------------------------------------------------------------
// Detect project root and rules directory
// ---------------------------------------------------------------------------

/**
 * The project root: the engine's `findProjectRoot` from the working directory
 * (the nearest directory holding a rules layout, else the nearest holding
 * `.git`), else the working directory itself. Running from a subdirectory such
 * as `engine/` — which has its own package.json — still finds the repository's
 * rules, and the edit hooks find a file's project by the same lookup, so the
 * runner and the hooks never disagree about which rules govern a file.
 */
const PROJECT_ROOT = findProjectRoot(resolve(process.cwd()), existsSync) ?? resolve(process.cwd());
const presentLayouts = PROJECT_RULES_LAYOUTS.filter((layout) => existsSync(join(PROJECT_ROOT, layout)));

/**
 * The project's ONE rules directory — the same one both harnesses' edit hooks
 * read (`projectRulesLayout`): the first layout present, else the layout
 * `--init` creates, the Pi one only in a project that has a `.pi` directory and
 * no `.claude` one. A project carrying more than one layout is refused before
 * anything runs: the hooks read only the first, so a second is a stale twin
 * that looks enforced and is not.
 */
function selectRulesDir(): string {
  const present = projectRulesLayout((layout) => presentLayouts.includes(layout));
  if (present !== null) return join(PROJECT_ROOT, present);
  const piOnly = existsSync(join(PROJECT_ROOT, ".pi")) && !existsSync(join(PROJECT_ROOT, ".claude"));
  return join(PROJECT_ROOT, piOnly ? PI_PROJECT_RULES_DIR : CLAUDE_PROJECT_RULES_DIR);
}

const RULES_DIR = selectRulesDir();

/** The rules directory when it exists, else null — decided once: the config
 *  loader, the rule loader and `--init` all read this one answer. */
const EXISTING_RULES_DIR: string | null = existsSync(RULES_DIR) ? RULES_DIR : null;

// ---------------------------------------------------------------------------
// File walker — everything lintable, minus the project's explicit exclusions
// ---------------------------------------------------------------------------

/** Project-relative, forward-slashed: the frame every config path is written in. */
const projectPath = (absolute: string): string => relative(PROJECT_ROOT, absolute).split(sep).join("/");

/** Every lintable file beneath `dir`, BEFORE exclusions — the engine's one
 *  project walk, which the clone corpus reads too. */
const walkLintable = (dir: string): readonly string[] => walkLintableFiles(dir).map((file) => file.absolute);

let projectTree: readonly string[] | undefined;

/**
 * Every lintable file in the project, BEFORE exclusions — the engine's
 * `lintedProjectFiles`, walked at most once per run. The lint set of a full
 * run, the scope-drift universe, `--init`'s starter roots and
 * `--write-baseline`'s sources all read this one walk, so they cannot disagree
 * about the tree, and a targeted run with the drift pass off never walks the
 * project at all. `--init` is the one run whose config changes mid-run; it
 * clears the walk before baselining under the new one.
 */
function projectFiles(config: LinterConfig.ProgrammaticConfig | null): readonly string[] {
  projectTree ??= lintedProjectFiles(PROJECT_ROOT, config);
  return projectTree;
}

type Scoped = Readonly<{ lint: readonly string[]; excluded: readonly Readonly<{ file: string; reason: string }>[] }>;

/** Split candidate files into those linted and those an exclusion entry removes, with its reason. */
function applyExclusions(files: readonly string[], exclusions: readonly ReasonedPath[]): Scoped {
  const decided = files.map((file) => ({ file, decision: scopeOf(projectPath(file), exclusions) }));
  return {
    lint: decided.filter(({ decision }) => decision.kind === "lint").map(({ file }) => file),
    excluded: decided.flatMap(({ file, decision }) => decision.kind === "excluded"
      ? [{ file: projectPath(file), reason: `${decision.exclusion.path} — ${decision.exclusion.reason}` }]
      : []),
  };
}

// ---------------------------------------------------------------------------
// Init command — scaffold linter config
// ---------------------------------------------------------------------------

/** The step a family `--init` could not infer adds: lint-project fails until it is decided. */
const DECIDE_UNINFERRED: readonly string[] = [
  "  - Decide every family listed above as not inferred: configure it in",
  "    config.json, or add { \"key\": \"<key>\", \"reason\": \"<why>\" } to its",
  "    'declined' list. lint-project fails until each one is decided.",
];

const INIT_NEXT_STEPS: readonly string[] = [
  "  - Run this script again: what it reports beyond the baselines is real",
  "    debt (import-boundary and purity violations are not baselined).",
  "  - Add regex rule overrides as .json files in rules/ if the project needs them.",
  "",
  "Available config fields:",
  "  declined      — [{ key, reason }] opt-in families left off on purpose",
  "  exclude       — [{ path, reason }] never linted (vendored, generated)",
  "  boundaries    — import direction rules per module",
  "  requireGovernance — roots where a file no boundary names is a violation",
  "  pureModules   — roots/files that must be side-effect free",
  "  impureModules — [{ path, reason }] shells inside the pure roots",
  "  maxFunctionLines — max function body length (default: 50)",
  "  maxFunctionLinesBaseline — grandfathered over-long functions",
  "  switchTotalityModules — narrow switch-totality to these path prefixes",
  "  switchTotalityBaseline / discriminantBranchingBaseline — grandfathered sites",
  "  duplicateBlockMinTokens / duplicateBlockMinLines — how long a copy is (default: 100 tokens, 8 lines)",
  "  duplicateBlockBaseline — grandfathered copies",
  "  wireCastBaseline — grandfathered JSON.parse / .json() casts (no-wire-cast)",
  "  docReferences — { govern, plans, exclude, sourceRoots, externalNames } whose references must resolve (no-dangling-doc-reference)",
  "  docReferenceBaseline — grandfathered dangling doc references",
  "",
  "See: lint-rules/README.md for full documentation",
];

/** The project's config as written, paired with its strict parse
 *  (`parseStoredConfig`), or null when there is none. A config that does not
 *  read or parse ends the run (exit 2), as the loader's refusal does. */
function readStoredConfig(): StarterConfig.StoredConfig | null {
  const path = join(RULES_DIR, "config.json");
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    console.error(`ERROR: Malformed linter config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const stored = parseStoredConfig(raw, path);
  if (!stored.ok) {
    console.error(`ERROR: ${stored.error}`);
    process.exit(2);
  }
  return stored.value;
}

/** What `--init` infers from: the tree, the languages, each layer file's imports. */
function projectLayout(config: LinterConfig.ProgrammaticConfig | null): StarterConfig.ProjectLayout {
  const files = projectFiles(config).map(projectPath);
  const inLayer = (file: string): boolean => TYPESCRIPT_LAYERS.some((layer) => file.startsWith(layer.dir)) && extname(file) !== ".md";
  return {
    files,
    languages: {
      typescript: ["tsconfig.json", "tsconfig.base.json"].some((name) => existsSync(join(PROJECT_ROOT, name))),
      java: ["pom.xml", "build.gradle", "build.gradle.kts"].some((name) => existsSync(join(PROJECT_ROOT, name))),
    },
    importsOf: new Map(files.filter(inLayer).map((file) =>
      [file, extractImports(readFileSync(join(PROJECT_ROOT, file), "utf-8")).map(({ specifier }) => specifier)])),
    hasPlans: existsSync(join(PROJECT_ROOT, ".claude", "plans")),
  };
}

/**
 * `--init`: turn on every rule family the project's layout allows, then
 * baseline what the baselined rules already flag. It fills only the families
 * the project has neither configured nor declined (`inferStarterConfig`), so a
 * re-run on a set-up project changes nothing it decided, and names each family
 * it could not infer for a decision.
 */
function initLinterConfig(): void {
  const stored = readStoredConfig();
  const inference = inferStarterConfig(stored, projectLayout(stored?.config ?? null));
  const path = join(RULES_DIR, "config.json");
  if (stored === null || inference.inferred.length > 0) {
    mkdirSync(RULES_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(inference.document, null, 2)}\n`);
    console.log(`✓ ${relative(PROJECT_ROOT, path)}: ${stored === null ? "created" : "updated"}`);
  }
  for (const key of inference.inferred) console.log(`  on: ${key}`);
  for (const note of inference.notes) console.log(`  note: ${note}`);
  for (const { key, why } of inference.uninferred) console.log(`  not inferred: ${key} — ${why}`);

  // The new config walks what it governs (plans), so the baseline reads a fresh walk.
  projectTree = undefined;
  writeBaseline(loadConfigOrExit(RULES_DIR));
  const steps = [...(inference.uninferred.length > 0 ? DECIDE_UNINFERRED : []), ...INIT_NEXT_STEPS];
  for (const line of ["", "Next steps:", ...steps]) console.log(line);
}

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

interface CliOpts {
  init: boolean;
  writeBaseline: boolean;
  tier: "immediate" | "full";
  json: boolean;
  summary: boolean;
  fixHints: boolean;
  baselineCheck: boolean;
  paths: string[];
}

function parseArgs(args: string[]): CliOpts {
  const opts: CliOpts = {
    init: false,
    writeBaseline: false,
    tier: "full",
    json: false,
    summary: false,
    fixHints: true,
    baselineCheck: true,
    paths: [],
  };

  for (const arg of args) {
    if (arg === "--init") opts.init = true;
    else if (arg === "--write-baseline") opts.writeBaseline = true;
    else if (arg === "--tier=full") opts.tier = "full";
    else if (arg === "--tier=immediate") opts.tier = "immediate";
    else if (arg === "--json") opts.json = true;
    else if (arg === "--summary") opts.summary = true;
    else if (arg === "--no-fix-hints") opts.fixHints = false;
    else if (arg === "--no-baseline-check") opts.baselineCheck = false;
    else if (!arg.startsWith("--")) opts.paths.push(arg);
    else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Baseline drift — a grandfathered list nobody re-checks rots silently
// ---------------------------------------------------------------------------

/** The config in `rulesDir`, parsed strictly; a refusal ends the run (exit 2). */
function loadConfigOrExit(rulesDir: string | null): LinterConfig.ProgrammaticConfig {
  try {
    return loadProjectConfig(rulesDir);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

/** The project's config, parsed strictly once. */
const projectConfig = (): LinterConfig.ProgrammaticConfig => loadConfigOrExit(EXISTING_RULES_DIR);

/** Every baselined rule of the project, each detecting against the project's
 *  own clone corpus, fingerprinted from the files' bytes as the full tier does. */
const owners = (config: LinterConfig.ProgrammaticConfig): readonly BaselineOwner[] =>
  baselineOwners(authoritativeLintContext(config, PROJECT_ROOT));

/**
 * A list that only ever suppresses violations cannot report its own decay: a
 * deleted, renamed or since-proven site costs nothing. So every rule that keeps
 * a grandfathered list registers as a baseline owner (`baselineOwners` in the
 * programmatic rule registry), and this pass asks each owner which entries no
 * live site consumes. `staleBaselineEntries` walks the BASELINE'S OWN paths, so a
 * targeted run does not call every other entry stale.
 *
 * Each line names the rule and what its entries excuse, so a stale chain entry
 * does not read as a missing switch.
 *
 * Runs against ANY project: the baselines are the project's own, read from its
 * config and keyed relative to its root, so the drift report means the same in
 * a target repository as in loom.
 */
function baselineDrift(config: LinterConfig.ProgrammaticConfig): string[] {
  const readSource = (path: string): string | null => {
    const absolute = join(PROJECT_ROOT, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf-8") : null;
  };
  return owners(config).flatMap((owner) =>
    staleBaselineEntries(owner, readSource).map((key) =>
      `${owner.rule}: ${key} (no ${owner.site} matches it any more — delete the baseline entry)`));
}

/**
 * Record every site each baselined rule flags today as that rule's baseline,
 * so a project adopts the totality rules, no-duplicate-block, no-wire-cast and
 * no-dangling-doc-reference without every pre-existing switch, copy, wire cast
 * or dangling reference blocking the next edit to its file. Written into the project's one
 * `config.json`, creating it when absent. Which sites are
 * recorded and what the next config holds are the engine's pure decision
 * (`recordedBaselines`, `configWithBaselines`: every other field kept, an
 * empty list removed rather than written); this shell only walks, reads and
 * writes. The walk is the lint walk — every lintable file minus the
 * exclusions — so a baseline never records a site the linter does not read.
 *
 * The detectors ignore the current baseline, so a re-run after converting a
 * site drops its entry — the baseline only ever shrinks under this command
 * unless new unproven code was added, which the diff makes visible.
 */
function writeBaseline(config: LinterConfig.ProgrammaticConfig): void {
  const projectOwners = owners(config);
  const extensions = new Set(projectOwners.flatMap((owner) => owner.extensions));
  const sources = applyExclusions(projectFiles(config), config.exclude ?? []).lint
    .filter((file) => extensions.has(extname(file)))
    .map((file) => ({ path: projectPath(file), content: readFileSync(file, "utf-8") }));
  const recorded = recordedBaselines(projectOwners, sources);

  mkdirSync(RULES_DIR, { recursive: true });
  const path = join(RULES_DIR, "config.json");
  // The config was already parsed through the engine's loader, so a malformed
  // one failed the run instead of being silently rewritten.
  writeFileSync(path, `${JSON.stringify(configWithBaselines(readStoredConfig()?.document ?? {}, recorded), null, 2)}\n`);
  console.log(`✓ ${relative(PROJECT_ROOT, path)}: ${recorded.map(({ configKey, keys }) => `${configKey} ${keys.length}`).join(", ")}`);
}

/**
 * The external names (`docReferences.externalNames`) that have decayed: a name
 * no governed file references, or one the source already resolves. Judged over
 * every governed file of the project, never a targeted run's subset, so a
 * name is not called unreferenced because its document was not named. Which
 * files are governed, and whether there is anything to judge at all, are the
 * engine's decision (`externalNameDrift`); this shell only lists the files the
 * run lints and reads the ones the engine asks for.
 */
function externalNamesDrift(config: LinterConfig.ProgrammaticConfig): readonly string[] {
  const paths = applyExclusions(projectFiles(config), config.exclude ?? []).lint.map(projectPath);
  const read = (path: string): string => readFileSync(join(PROJECT_ROOT, path), "utf-8");
  return externalNameDrift(config.docReferences ?? null, { paths, read }, authoritativeLintContext(config, PROJECT_ROOT).references);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));

if (presentLayouts.length > 1) {
  console.error(`ERROR: the project carries ${presentLayouts.join(" and ")} — keep one rules directory (both harnesses read ${presentLayouts[0]}); delete the other`);
  process.exit(2);
}

if (opts.init) {
  initLinterConfig();
  process.exit(0);
}

const config = projectConfig();

if (opts.writeBaseline) {
  writeBaseline(config);
  process.exit(0);
}

/**
 * Lint coverage (`linter/lint-coverage.ts`): in a set-up project every opt-in
 * rule family is configured or declined, and a gap fails a full-tier run, so
 * a family cannot be forgotten silently. A project with no rules directory is
 * told what it is missing, without failing: it never asked for Loom's linter.
 */
const coverage = lintCoverage(EXISTING_RULES_DIR === null ? null : config);
const gapLines = opts.tier === "full" ? coverageGaps(coverage).map(coverageGapLine) : [];
if (coverage.kind === "no-setup" && !opts.json) {
  console.error("note: no Loom lint setup — only the shipped rules run; `lint-project --init` turns every rule family on");
}

const exclusions = config.exclude ?? [];

/**
 * Candidate files: the explicit arguments (a file exactly; a directory walked),
 * or the whole project. The exclusion list applies to every candidate. A path
 * argument that does not exist ends the run (exit 2) before anything is linted:
 * a mistyped path must not pass as a clean one.
 */
function candidates(): readonly string[] {
  if (opts.paths.length === 0) return projectFiles(config);
  const missing = opts.paths.filter((pattern) => statSync(resolve(pattern), { throwIfNoEntry: false }) === undefined);
  if (missing.length > 0) {
    console.error(`ERROR: ${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist — nothing was linted`);
    process.exit(2);
  }
  return opts.paths.flatMap((pattern) => {
    const resolved = resolve(pattern);
    return statSync(resolved).isDirectory() ? walkLintable(resolved) : [resolved];
  });
}

/**
 * A Markdown file is linted only where the project governs its references:
 * no other rule reads one, so a docs folder in a project without
 * `docReferences` is a run that checked nothing, not a clean one.
 */
const readByARule = (file: string): boolean =>
  extname(file) !== ".md" || readingOf(projectPath(file), config.docReferences ?? null) !== null;

const scoped = applyExclusions(candidates().filter(readByARule), exclusions);
const files = scoped.lint;

if (!opts.json) {
  for (const { file, reason } of opts.paths.length > 0 ? scoped.excluded : []) {
    console.log(`  excluded: ${file} (${reason})`);
  }
}

if (files.length === 0) {
  // An empty project has nothing to lint. Paths that were named and yield no
  // file — every one excluded, or a directory with no lintable source — are a
  // run that checked nothing, and must not read as a pass.
  if (opts.paths.length > 0) {
    console.error(`ERROR: ${opts.paths.join(", ")} yielded no file to lint (${scoped.excluded.length} excluded by config) — nothing was linted`);
    process.exit(2);
  }
  console.log("No source files found to lint.");
  process.exit(0);
}

if (!opts.json && !opts.summary) {
  console.log(`Linting ${files.length} files (tier: ${opts.tier}, project: ${relative(process.cwd(), PROJECT_ROOT) || "."}, ${scoped.excluded.length} excluded by config)...\n`);
}

// ---------------------------------------------------------------------------
// Execute linting
// ---------------------------------------------------------------------------

interface ViolationRecord {
  file: string;
  line: number;
  rule: string;
  text: string;
  fixHint: string;
}

/** A batch audit, not a latency-bound hook: each file gets a generous budget,
 *  so a loaded host cannot turn a clean file into a lint error. */
const BATCH_TIMEOUT_MS = 10_000;

const allViolations: ViolationRecord[] = [];
let errorCount = 0;

for (const [file, result] of lintFiles(files, opts.tier, DEFAULT_RULES_DIR, EXISTING_RULES_DIR, BATCH_TIMEOUT_MS)) {
  if (result.kind === "violations" && result.violations.length > 0) {
    for (const v of result.violations) {
      allViolations.push({
        file: projectPath(file),
        line: v.line,
        rule: v.rule,
        text: v.text,
        fixHint: v.fixHint,
      });
    }
  } else if (result.kind === "error") {
    errorCount++;
    if (!opts.json) {
      console.error(`  ERROR: ${projectPath(file)}: ${result.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Drift is independent of violations: a baseline entry or a scoping entry can
// be stale while the tier is clean, which is exactly the case that used to go
// unnoticed. Scoping drift is judged against the whole project's files, never
// a targeted run's subset.
const driftLines = opts.baselineCheck && opts.tier === "full"
  ? [...baselineDrift(config), ...scopeDrift(config, projectFiles(config).map(projectPath)), ...externalNamesDrift(config)]
  : [];

// ONE failure predicate for every output mode. A file the linter could not read
// fails the run in each of them: the JSON and summary modes used to exit 0 on a
// lint error, so a machine caller read an unlinted file as a clean one.
const failed = allViolations.length > 0 || errorCount > 0 || driftLines.length > 0 || gapLines.length > 0;
const exitCode = failed ? 1 : 0;

if (opts.json) {
  console.log(JSON.stringify({
    violations: allViolations, errorCount, staleEntries: driftLines, coverage: coverage.kind, coverageGaps: gapLines, excluded: scoped.excluded,
  }, null, 2));
  process.exit(exitCode);
}

if (opts.summary) {
  // Group by rule
  const byRule = new Map<string, number>();
  for (const v of allViolations) {
    byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
  }
  const filesWithViolations = new Set(allViolations.map(v => v.file)).size;

  console.log(`Files scanned: ${files.length}`);
  console.log(`Files excluded by config: ${scoped.excluded.length}`);
  console.log(`Files with violations: ${filesWithViolations}`);
  console.log(`Total violations: ${allViolations.length}`);
  if (errorCount > 0) console.log(`Errors: ${errorCount}`);
  if (driftLines.length > 0) console.log(`Stale entries: ${driftLines.length}`);
  if (gapLines.length > 0) console.log(`Coverage gaps: ${gapLines.length}`);
  console.log("");
  if (byRule.size > 0) {
    console.log("By rule:");
    for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${rule}: ${count}`);
    }
  }
  process.exit(exitCode);
}

// Default: full output
for (const v of allViolations) {
  console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.text.trim()}`);
  if (opts.fixHints) {
    console.log(`    → ${v.fixHint}\n`);
  }
}
for (const line of [...driftLines, ...gapLines]) {
  console.log(`  ${line}`);
}

const filesWithViolations = new Set(allViolations.map(v => v.file)).size;
console.log("─".repeat(60));
if (!failed) {
  console.log("✓ No violations found");
} else {
  if (allViolations.length > 0) {
    console.log(`✗ ${allViolations.length} violation(s) in ${filesWithViolations} file(s)`);
  }
  if (driftLines.length > 0) {
    console.log(`✗ ${driftLines.length} stale entr${driftLines.length === 1 ? "y" : "ies"} (baselines or scoping)`);
  }
  if (gapLines.length > 0) {
    console.log(`✗ ${gapLines.length} rule famil${gapLines.length === 1 ? "y" : "ies"} neither configured nor declined`);
  }
  if (errorCount > 0) {
    console.log(`⚠ ${errorCount} file(s) had lint errors`);
  }
}
process.exit(exitCode);
