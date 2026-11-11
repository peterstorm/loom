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
 *   --init          Create .claude/linter/rules/ with starter config (interactive)
 *   --tier=full     Run full tier (default: full)
 *   --tier=immediate  Run immediate tier only (regex rules, the import-boundary rules, switch-totality and
 *                   no-duplicate-block, fast)
 *   --no-baseline-check  Skip the staleness pass (grandfathered baselines and
 *                   scoping entries — exclusions, pure roots, shells, boundaries —
 *                   that no longer name anything)
 *   --write-baseline  Record every pre-existing totality site and copied block in the
 *                   project's config.json (switchTotalityBaseline,
 *                   discriminantBranchingBaseline, duplicateBlockBaseline), then exit
 *   --json          Output raw JSON violations
 *   --summary       Show only summary counts
 *   --fix-hints     Show fix hints (default: true)
 *   --no-fix-hints  Hide fix hints
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
import type * as LinterLoader from "../engine/src/linter/loader.ts";
import type * as ProjectScope from "../engine/src/linter/project-scope.ts";
import type * as ProjectWalk from "../engine/src/linter/project-walk.ts";
import type * as PurityRule from "../engine/src/linter/programmatic/no-io-in-pure-modules.ts";
import type { ReasonedPath } from "../engine/src/linter/programmatic/config.ts";
import type * as ProgrammaticRules from "../engine/src/linter/programmatic/index.ts";
import type * as Baselines from "../engine/src/linter/programmatic/baseline.ts";
import type * as BaselineConfig from "../engine/src/linter/programmatic/baseline-config.ts";
import type { BaselineOwner } from "../engine/src/linter/programmatic/baseline.ts";

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

const { lintFiles }: typeof LinterIndex = await import(join(LOOM_ROOT, "engine/src/linter/index.ts"));
const { CLAUDE_PROJECT_RULES_DIR, PI_PROJECT_RULES_DIR, PROJECT_RULES_LAYOUTS, projectRulesLayout }: typeof LinterConfig =
  await import(join(LOOM_ROOT, "engine/src/linter/programmatic/config.ts"));
const { authoritativeLintContext, loadProjectConfig }: typeof LinterLoader = await import(join(LOOM_ROOT, "engine/src/linter/loader.ts"));
const { scopeOf, scopeDrift }: typeof ProjectScope =
  await import(join(LOOM_ROOT, "engine/src/linter/project-scope.ts"));
const { walkLintableFiles }: typeof ProjectWalk = await import(join(LOOM_ROOT, "engine/src/linter/project-walk.ts"));
const { matchesModulePath }: typeof PurityRule =
  await import(join(LOOM_ROOT, "engine/src/linter/programmatic/no-io-in-pure-modules.ts"));
const { baselineOwners }: typeof ProgrammaticRules = await import(join(LOOM_ROOT, "engine/src/linter/programmatic/index.ts"));
const { staleBaselineEntries }: typeof Baselines = await import(join(LOOM_ROOT, "engine/src/linter/programmatic/baseline.ts"));
const { configWithBaselines, recordedBaselines }: typeof BaselineConfig =
  await import(join(LOOM_ROOT, "engine/src/linter/programmatic/baseline-config.ts"));

// ---------------------------------------------------------------------------
// Detect project root and rules directory
// ---------------------------------------------------------------------------

/**
 * The project root: the nearest ancestor holding a linter rules directory
 * (`.claude/linter/rules` or `.pi/linter/rules`), else the nearest ancestor
 * holding `.git` (the repository root), else the starting directory. Running
 * from a subdirectory such as `engine/` — which has its own package.json —
 * still finds the repository's rules, so the same command lints the same tree
 * wherever it is started.
 */
function findProjectRoot(startDir: string): string {
  const ancestors = (dir: string): string[] => dir === dirname(dir) ? [dir] : [dir, ...ancestors(dirname(dir))];
  const chain = ancestors(resolve(startDir));
  return chain.find((dir) => PROJECT_RULES_LAYOUTS.some((layout) => existsSync(join(dir, layout))))
    ?? chain.find((dir) => existsSync(join(dir, ".git")))
    ?? resolve(startDir);
}

const PROJECT_ROOT = findProjectRoot(process.cwd());
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

let projectWalk: readonly string[] | undefined;

/**
 * Every lintable file in the project, BEFORE exclusions — walked at most once
 * per run. The lint set of a full run, the scope-drift universe, `--init`'s
 * starter roots and `--write-baseline`'s sources all read this one walk, so
 * they cannot disagree about the tree, and a targeted run with the drift pass
 * off never walks the project at all.
 */
function projectFiles(): readonly string[] {
  projectWalk ??= walkLintable(PROJECT_ROOT);
  return projectWalk;
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

/** The starter programmatic config for a project's detected languages; Java's
 *  settings win where both are present. Each pure root is a candidate, kept
 *  only when it names a file in the project (`present`): a root that matches
 *  nothing is stale scoping, which fails the very next run. */
function starterLinterConfig(hasTs: boolean, hasJava: boolean, present: (root: string) => boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (hasTs) {
    // Directory roots (trailing `/`): every non-test file beneath is pure
    // unless `impureModules` names it with its reason. No globs — a glob is
    // refused, because it used to match nothing silently.
    config.pureModules = [
      "src/domain/",
      "src/types/",
    ].filter(present);
    config.boundaries = [];
    config.maxFunctionLines = 50;
    config.excludeFromMaxLines = [".test.ts", ".spec.ts"];
  }
  if (hasJava) {
    // Directory patterns match at any path boundary (`isPureModule`), so these
    // cover every package's domain model and services. Glob segments (`**`)
    // are not supported — a starter written with them matched nothing.
    config.pureModules = [
      "domain/model/",
      "domain/service/",
    ].filter(present);
    config.boundaries = [];
    config.maxFunctionLines = 40;
    config.excludeFromMaxLines = [".test.java", "Test.java"];
  }
  return config;
}

const INIT_NEXT_STEPS: readonly string[] = [
  "",
  "Next steps:",
  "  1. Edit config.json to define your architectural boundaries and the",
  "     functional core (pureModules lists only the starter roots this",
  "     project already has)",
  "  2. Add regex rule overrides as .json files in rules/",
  "  3. Run with --write-baseline to grandfather pre-existing unproven",
  "     switches and if-chains, and blocks already written twice",
  "     (switch-totality applies to every non-test TypeScript file and",
  "     no-duplicate-block to every TypeScript and JavaScript file, tests",
  "     included, by default; new sites must prove totality, new copies",
  "     are refused)",
  "  4. Run this script again to lint your codebase",
  "",
  "Available config fields:",
  "  exclude       — [{ path, reason }] never linted (vendored, generated)",
  "  boundaries    — import direction rules per module",
  "  requireGovernance — roots where a file no boundary names is a violation",
  "  pureModules   — roots/files that must be side-effect free",
  "  impureModules — [{ path, reason }] shells inside the pure roots",
  "  maxFunctionLines — max function body length (default: 50)",
  "  switchTotalityModules — narrow switch-totality to these path prefixes",
  "  switchTotalityBaseline / discriminantBranchingBaseline — grandfathered sites",
  "  duplicateBlockMinTokens / duplicateBlockMinLines — how long a copy is (default: 100 tokens, 8 lines)",
  "  duplicateBlockBaseline — grandfathered copies",
  "",
  "See: lint-rules/README.md for full documentation",
];

function initLinterConfig(): void {
  if (EXISTING_RULES_DIR !== null) {
    console.log(`Linter rules directory already exists: ${relative(PROJECT_ROOT, RULES_DIR)}`);
    console.log("To add rules, create .json files there. See loom lint-rules/README.md.");
    return;
  }

  mkdirSync(RULES_DIR, { recursive: true });

  // Detect project language
  const hasTs = existsSync(join(PROJECT_ROOT, "tsconfig.json")) ||
    existsSync(join(PROJECT_ROOT, "tsconfig.base.json"));
  const hasJava = existsSync(join(PROJECT_ROOT, "pom.xml")) ||
    existsSync(join(PROJECT_ROOT, "build.gradle")) ||
    existsSync(join(PROJECT_ROOT, "build.gradle.kts"));

  const files = projectFiles().map(projectPath);
  const hasFileUnder = (root: string): boolean => files.some((file) => matchesModulePath(file, root));
  writeFileSync(
    join(RULES_DIR, "config.json"),
    JSON.stringify(starterLinterConfig(hasTs, hasJava, hasFileUnder), null, 2) + "\n",
  );

  console.log(`✓ Created ${relative(PROJECT_ROOT, RULES_DIR)}/`);
  console.log(`  └── config.json (starter programmatic config)`);
  for (const line of INIT_NEXT_STEPS) console.log(line);
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

/** The project's config, parsed strictly once; a refusal ends the run (exit 2). */
function projectConfig(): LinterConfig.ProgrammaticConfig {
  try {
    return loadProjectConfig(EXISTING_RULES_DIR);
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

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
 * so a project adopts the totality rules and no-duplicate-block without every
 * pre-existing switch or copy blocking the next edit to its file. Written into the project's one
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
  const sources = applyExclusions(projectFiles(), config.exclude ?? []).lint
    .filter((file) => extensions.has(extname(file)))
    .map((file) => ({ path: projectPath(file), content: readFileSync(file, "utf-8") }));
  const recorded = recordedBaselines(projectOwners, sources);

  mkdirSync(RULES_DIR, { recursive: true });
  const path = join(RULES_DIR, "config.json");
  // The config was already parsed through the engine's loader (`projectConfig`),
  // so a malformed one failed the run instead of being silently rewritten.
  const existing: Record<string, unknown> = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  writeFileSync(path, `${JSON.stringify(configWithBaselines(existing, recorded), null, 2)}\n`);
  console.log(`✓ ${relative(PROJECT_ROOT, path)}: ${recorded.map(({ configKey, keys }) => `${configKey} ${keys.length}`).join(", ")}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));

if (opts.init) {
  initLinterConfig();
  process.exit(0);
}

if (presentLayouts.length > 1) {
  console.error(`ERROR: the project carries ${presentLayouts.join(" and ")} — keep one rules directory (both harnesses read ${presentLayouts[0]}); delete the other`);
  process.exit(2);
}

const config = projectConfig();

if (opts.writeBaseline) {
  writeBaseline(config);
  process.exit(0);
}

const exclusions = config.exclude ?? [];

/**
 * Candidate files: the explicit arguments (a file exactly; a directory walked),
 * or the whole project. The exclusion list applies to every candidate. A path
 * argument that does not exist ends the run (exit 2) before anything is linted:
 * a mistyped path must not pass as a clean one.
 */
function candidates(): readonly string[] {
  if (opts.paths.length === 0) return projectFiles();
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

const scoped = applyExclusions(candidates(), exclusions);
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
  ? [...baselineDrift(config), ...scopeDrift(config, projectFiles().map(projectPath))]
  : [];

// ONE failure predicate for every output mode. A file the linter could not read
// fails the run in each of them: the JSON and summary modes used to exit 0 on a
// lint error, so a machine caller read an unlinted file as a clean one.
const failed = allViolations.length > 0 || errorCount > 0 || driftLines.length > 0;
const exitCode = failed ? 1 : 0;

if (opts.json) {
  console.log(JSON.stringify({ violations: allViolations, errorCount, staleEntries: driftLines, excluded: scoped.excluded }, null, 2));
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
for (const line of driftLines) {
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
  if (errorCount > 0) {
    console.log(`⚠ ${errorCount} file(s) had lint errors`);
  }
}
process.exit(exitCode);
