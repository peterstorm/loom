#!/usr/bin/env bun
/**
 * loom-lint — Run loom linter rules against a codebase.
 *
 * Generic runner that works in any project. Detects project type (Claude Code / Pi),
 * locates rules, and runs the full-tier linter across source files.
 *
 * Usage:
 *   bun /path/to/loom/scripts/lint-project.ts [options] [file patterns...]
 *
 * Options:
 *   --init          Create .claude/linter/rules/ with starter config (interactive)
 *   --tier=full     Run full tier (default: full)
 *   --tier=immediate  Run immediate tier only (regex rules, fast)
 *   --json          Output raw JSON violations
 *   --summary       Show only summary counts
 *   --fix-hints     Show fix hints (default: true)
 *   --no-fix-hints  Hide fix hints
 *
 * Examples:
 *   bun lint-project.ts                    # Lint all source files
 *   bun lint-project.ts packages/core/     # Lint specific directory
 *   bun lint-project.ts --init             # Setup linter config
 *   bun lint-project.ts --summary          # Just counts
 */

import { resolve, join, extname, dirname, relative } from "node:path";
import { readdirSync, statSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

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

const { lintFile } = await import(join(LOOM_ROOT, "engine/src/linter/index.ts"));

// ---------------------------------------------------------------------------
// Detect project root and harness type
// ---------------------------------------------------------------------------

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== "/") {
    if (existsSync(join(dir, "package.json")) ||
        existsSync(join(dir, ".git")) ||
        existsSync(join(dir, ".claude")) ||
        existsSync(join(dir, ".pi"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

function detectHarness(root: string): "claude" | "pi" {
  if (existsSync(join(root, ".pi"))) return "pi";
  return "claude";
}

const PROJECT_ROOT = findProjectRoot(process.cwd());
const HARNESS = detectHarness(PROJECT_ROOT);
const LINTER_DIR = join(PROJECT_ROOT, HARNESS === "pi" ? ".pi/linter" : ".claude/linter");
const RULES_DIR = join(LINTER_DIR, "rules");

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".claude", ".pi", "dist", "build", "out",
  ".next", "target", ".gradle", "__pycache__",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".scala",
]);

function walkSource(dir: string, opts: { includeTests: boolean }): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        results.push(...walkSource(full, opts));
      } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
        if (entry.endsWith(".d.ts")) continue;
        if (!opts.includeTests && (entry.includes(".test.") || entry.includes(".spec."))) continue;
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

// ---------------------------------------------------------------------------
// Init command — scaffold linter config
// ---------------------------------------------------------------------------

function initLinterConfig(): void {
  if (existsSync(RULES_DIR)) {
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

  // Create starter config.json
  const config: Record<string, unknown> = {};

  if (hasTs) {
    config.pureModules = [
      "src/domain/",
      "src/types/",
      "packages/*/src/types/",
    ];
    config.boundaries = [];
    config.maxFunctionLines = 50;
    config.excludeFromMaxLines = [".test.ts", ".spec.ts"];
  }
  if (hasJava) {
    config.pureModules = [
      "src/main/java/**/domain/model/",
      "src/main/java/**/domain/service/",
    ];
    config.boundaries = [];
    config.maxFunctionLines = 40;
    config.excludeFromMaxLines = [".test.java", "Test.java"];
  }

  writeFileSync(
    join(RULES_DIR, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );

  console.log(`✓ Created ${relative(PROJECT_ROOT, RULES_DIR)}/`);
  console.log(`  └── config.json (starter programmatic config)`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit config.json to define your architectural boundaries");
  console.log("  2. Add regex rule overrides as .json files in rules/");
  console.log("  3. Run this script again to lint your codebase");
  console.log("");
  console.log("Available boundary config fields:");
  console.log("  boundaries    — import direction rules per module");
  console.log("  pureModules   — paths that must be side-effect free");
  console.log("  maxFunctionLines — max function body length (default: 50)");
  console.log("");
  console.log("See: lint-rules/README.md for full documentation");
}

// ---------------------------------------------------------------------------
// Parse arguments
// ---------------------------------------------------------------------------

interface CliOpts {
  init: boolean;
  tier: "immediate" | "full";
  json: boolean;
  summary: boolean;
  fixHints: boolean;
  includeTests: boolean;
  paths: string[];
}

function parseArgs(args: string[]): CliOpts {
  const opts: CliOpts = {
    init: false,
    tier: "full",
    json: false,
    summary: false,
    fixHints: true,
    includeTests: false,
    paths: [],
  };

  for (const arg of args) {
    if (arg === "--init") opts.init = true;
    else if (arg === "--tier=full") opts.tier = "full";
    else if (arg === "--tier=immediate") opts.tier = "immediate";
    else if (arg === "--json") opts.json = true;
    else if (arg === "--summary") opts.summary = true;
    else if (arg === "--no-fix-hints") opts.fixHints = false;
    else if (arg === "--include-tests") opts.includeTests = true;
    else if (!arg.startsWith("--")) opts.paths.push(arg);
    else {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));

if (opts.init) {
  initLinterConfig();
  process.exit(0);
}

// Resolve project rules dir (null if doesn't exist — lintFile handles gracefully)
const projectRulesDir = existsSync(RULES_DIR) ? RULES_DIR : null;

// Collect files to lint
let files: string[];
if (opts.paths.length > 0) {
  files = opts.paths.flatMap(pattern => {
    const resolved = resolve(pattern);
    const stat = statSync(resolved, { throwIfNoEntry: false });
    if (!stat) {
      console.error(`WARNING: ${pattern} does not exist, skipping`);
      return [];
    }
    if (stat.isDirectory()) return walkSource(resolved, { includeTests: opts.includeTests });
    return [resolved];
  });
} else {
  files = walkSource(PROJECT_ROOT, { includeTests: opts.includeTests });
}

if (files.length === 0) {
  console.log("No source files found to lint.");
  process.exit(0);
}

if (!opts.json && !opts.summary) {
  console.log(`Linting ${files.length} files (tier: ${opts.tier}, project: ${relative(process.cwd(), PROJECT_ROOT) || "."})...\n`);
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

const allViolations: ViolationRecord[] = [];
let errorCount = 0;

for (const file of files) {
  const result = lintFile(file, opts.tier, DEFAULT_RULES_DIR, projectRulesDir);

  if (result.kind === "violations" && result.violations.length > 0) {
    for (const v of result.violations) {
      allViolations.push({
        file: relative(PROJECT_ROOT, file),
        line: v.line,
        rule: v.rule,
        text: v.text,
        fixHint: v.fixHint,
      });
    }
  } else if (result.kind === "error") {
    errorCount++;
    if (!opts.json) {
      console.error(`  ERROR: ${relative(PROJECT_ROOT, file)}: ${result.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (opts.json) {
  console.log(JSON.stringify({ violations: allViolations, errorCount }, null, 2));
  process.exit(allViolations.length > 0 ? 1 : 0);
}

if (opts.summary) {
  // Group by rule
  const byRule = new Map<string, number>();
  for (const v of allViolations) {
    byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
  }
  const filesWithViolations = new Set(allViolations.map(v => v.file)).size;

  console.log(`Files scanned: ${files.length}`);
  console.log(`Files with violations: ${filesWithViolations}`);
  console.log(`Total violations: ${allViolations.length}`);
  if (errorCount > 0) console.log(`Errors: ${errorCount}`);
  console.log("");
  if (byRule.size > 0) {
    console.log("By rule:");
    for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${rule}: ${count}`);
    }
  }
  process.exit(allViolations.length > 0 ? 1 : 0);
}

// Default: full output
for (const v of allViolations) {
  console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.text.trim()}`);
  if (opts.fixHints) {
    console.log(`    → ${v.fixHint}\n`);
  }
}

const filesWithViolations = new Set(allViolations.map(v => v.file)).size;
console.log("─".repeat(60));
if (allViolations.length === 0 && errorCount === 0) {
  console.log("✓ No violations found");
} else {
  if (allViolations.length > 0) {
    console.log(`✗ ${allViolations.length} violation(s) in ${filesWithViolations} file(s)`);
  }
  if (errorCount > 0) {
    console.log(`⚠ ${errorCount} file(s) had lint errors`);
  }
}
process.exit(allViolations.length > 0 || errorCount > 0 ? 1 : 0);
