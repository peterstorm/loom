# Lint Runner Script

Inline bun script for running the loom linter against a project. Write to a temp file and execute.

## Full Script

```typescript
#!/usr/bin/env bun
// loom-lint-run.ts — Run loom linter against the current project
// Usage: bun /tmp/loom-lint-run.ts [--summary] [--json] [--include-tests] [path...]

import { resolve, join, extname, dirname, relative } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";

// --- Resolve loom installation ---
const LOOM_ROOT = "${CLAUDE_PLUGIN_ROOT}/..";
const DEFAULT_RULES_DIR = join(LOOM_ROOT, "lint-rules");
const { lintFile } = await import(join(LOOM_ROOT, "engine/src/linter/index.ts"));

// --- Detect project ---
function findRoot(dir: string): string {
  let d = dir;
  while (d !== "/") {
    if (existsSync(join(d, ".git")) || existsSync(join(d, "package.json")) || existsSync(join(d, "pom.xml"))) return d;
    d = dirname(d);
  }
  return dir;
}

const ROOT = findRoot(process.cwd());
const RULES_DIR = existsSync(join(ROOT, ".claude/linter/rules")) ? join(ROOT, ".claude/linter/rules")
  : existsSync(join(ROOT, ".pi/linter/rules")) ? join(ROOT, ".pi/linter/rules") : null;

// --- Walk source files ---
const SKIP = new Set(["node_modules", ".git", ".claude", ".pi", "dist", "build", "out", ".next", "target", ".gradle", "__pycache__", ".direnv", ".devenv", ".nix-defexpr", "result", "vendor", "coverage", ".turbo", ".cache"]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".java", ".kt"]);

function walk(dir: string, includeTests: boolean): string[] {
  const r: string[] = [];
  try {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e)) continue;
      const f = join(dir, e);
      const s = statSync(f, { throwIfNoEntry: false });
      if (!s) continue;
      if (s.isDirectory()) r.push(...walk(f, includeTests));
      else if (EXTS.has(extname(e)) && !e.endsWith(".d.ts")) {
        if (!includeTests && (e.includes(".test.") || e.includes(".spec.") || e.endsWith("Test.java") || e.endsWith("IT.java"))) continue;
        r.push(f);
      }
    }
  } catch {}
  return r;
}

// --- Parse args ---
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const summaryMode = args.includes("--summary");
const includeTests = args.includes("--include-tests");
const paths = args.filter(a => !a.startsWith("--"));

// --- Collect files ---
let files: string[];
if (paths.length > 0) {
  files = paths.flatMap(p => {
    const resolved = resolve(p);
    const s = statSync(resolved, { throwIfNoEntry: false });
    if (!s) return [];
    return s.isDirectory() ? walk(resolved, includeTests) : [resolved];
  });
} else {
  files = walk(ROOT, includeTests);
}

if (files.length === 0) { console.log("No source files found."); process.exit(0); }
if (!jsonMode && !summaryMode) console.log(`Linting ${files.length} files...\n`);

// --- Run linter ---
interface V { file: string; line: number; rule: string; text: string; fixHint: string; }
const violations: V[] = [];
let errors = 0;

for (const file of files) {
  const result = lintFile(file, "full", DEFAULT_RULES_DIR, RULES_DIR);
  if (result.kind === "violations" && result.violations.length > 0) {
    for (const v of result.violations) {
      violations.push({ file: relative(ROOT, file), line: v.line, rule: v.rule, text: v.text, fixHint: v.fixHint });
    }
  } else if (result.kind === "error") {
    errors++;
    if (!jsonMode) console.error(`  ERROR: ${relative(ROOT, file)}: ${result.message}`);
  }
}

// --- Output ---
if (jsonMode) {
  console.log(JSON.stringify({ violations, errors, filesScanned: files.length }, null, 2));
  process.exit(violations.length > 0 ? 1 : 0);
}

if (summaryMode) {
  const byRule = new Map<string, number>();
  for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
  console.log(`Files: ${files.length} | Violations: ${violations.length} | Errors: ${errors}`);
  if (byRule.size > 0) {
    console.log("\nBy rule:");
    for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1]))
      console.log(`  ${rule}: ${count}`);
  }
  process.exit(violations.length > 0 ? 1 : 0);
}

// Full output
for (const v of violations) {
  console.log(`  ${v.file}:${v.line} [${v.rule}] ${v.text.trim()}`);
  console.log(`    → ${v.fixHint}\n`);
}
console.log("─".repeat(60));
console.log(violations.length === 0 ? "✓ No violations" : `✗ ${violations.length} violation(s) in ${new Set(violations.map(v => v.file)).size} file(s)`);
if (errors > 0) console.log(`⚠ ${errors} file(s) had lint errors`);
process.exit(violations.length > 0 ? 1 : 0);
```

## Usage

```bash
# Write script to temp and run
cat > /tmp/loom-lint-run.ts << 'EOF'
# ... paste script above ...
EOF
bun /tmp/loom-lint-run.ts

# Lint specific directory
bun /tmp/loom-lint-run.ts packages/core/src

# Summary only
bun /tmp/loom-lint-run.ts --summary

# JSON output (for CI)
bun /tmp/loom-lint-run.ts --json

# Include test files
bun /tmp/loom-lint-run.ts --include-tests
```

## Important Notes

- Replace `${CLAUDE_PLUGIN_ROOT}` with the actual resolved path to the loom skills directory at runtime
- The script auto-detects project root by walking up to find `.git`, `package.json`, or `pom.xml`
- The script auto-detects rules directory (`.claude/linter/rules/` or `.pi/linter/rules/`)
- If no rules directory exists, only loom's default rules fire (which is still useful)
- Exit code 1 = violations found, 0 = clean
