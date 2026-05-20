---
name: lint-project
version: "1.0.0"
description: "This skill should be used when the user asks to 'lint the project', 'run linter', 'check lint rules', 'setup linting', 'add lint rules', 'configure linter', 'check architecture boundaries', 'check purity', 'run boundary checks', or needs to set up or run loom's programmatic linter against their codebase. Handles both initial setup (creating rules/config) and execution (running the linter and reporting violations)."
---

# Lint Project

Set up and run loom's architectural linter against any codebase. Enforces FC/IS boundaries, import direction, purity constraints, and code quality rules at edit time and on demand.

**This is a SETUP + EXECUTION skill** — first ensure the project has lint rules configured, then run the linter and report findings.

---

## Workflow

### Step 1: Check for Existing Configuration

Check if the project already has linter rules:

```bash
ls .claude/linter/rules/ 2>/dev/null || ls .pi/linter/rules/ 2>/dev/null || echo "NO_RULES"
```

- If rules exist → skip to **Step 4** (Run Linter)
- If no rules → proceed to **Step 2** (Setup)

### Step 2: Analyze Project Architecture

Before creating rules, understand the codebase:

1. **Detect language/framework:**
   ```bash
   ls tsconfig.json package.json pom.xml build.gradle* 2>/dev/null
   ```

2. **Identify module structure:**
   ```bash
   # TypeScript monorepo
   find . -name "package.json" -not -path "*/node_modules/*" | head -20
   # Or flat src/ layout
   ls src/ 2>/dev/null
   ```

3. **Identify architectural layers** — look for patterns:
   - `domain/`, `types/`, `models/` → pure core
   - `infra/`, `adapters/`, `repository/` → I/O boundary
   - `api/`, `controllers/`, `handlers/` → entry points
   - `shared/`, `utils/`, `common/` → shared utilities

4. **Ask the user:**
   - "What are your architectural layers and their allowed dependencies?"
   - "Which modules should be side-effect free (functional core)?"
   - "Are there any specific import patterns you want to forbid?"

### Step 3: Generate Configuration

Create the linter directory and config:

```bash
mkdir -p .claude/linter/rules
```

**Generate `config.json`** in the rules directory with these sections:

#### Boundaries (import direction enforcement)

Map project layers to boundary rules. Each rule specifies:
- `module`: path prefix identifying the module (with trailing `/`)
- `allow`: import prefixes this module MAY use (allowlist)
- `deny`: import prefixes this module MUST NOT use (denylist, takes priority)

Template:
```json
{
  "boundaries": [
    {
      "module": "<pure-core-path>/",
      "allow": ["./", "<pure-core-path>/"],
      "deny": ["<infra-path>/", "<api-path>/", "<external-io-packages>"]
    },
    {
      "module": "<infra-path>/",
      "allow": ["./", "<infra-path>/", "<pure-core-path>/"],
      "deny": ["<api-path>/"]
    }
  ]
}
```

#### Pure Modules (no-I/O enforcement)

List paths that must be side-effect free — no filesystem, network, `Math.random()`, `new Date()` without args, `process.env`, `console.log`:

```json
{
  "pureModules": [
    "src/domain/",
    "src/types/",
    "packages/core/src/types/"
  ]
}
```

#### Function Length

```json
{
  "maxFunctionLines": 50,
  "excludeFromMaxLines": [".test.ts", ".spec.ts"]
}
```

**Generate regex rules** as individual `.json` files for project-specific patterns:

Common rules to consider:
- `no-unsafe-as-any.json` — block `as any` casts
- `no-non-null-assertion.json` — block `!.` assertions
- `no-catch-ignore.json` — block empty catch blocks
- `no-console-log.json` — override/disable depending on project convention

Each rule file format:
```json
{
  "kind": "regex",
  "name": "rule-name",
  "description": "What it catches",
  "extensions": [".ts", ".tsx"],
  "pattern": "regex-pattern",
  "flags": "",
  "fixHint": "Actionable fix suggestion",
  "enabled": true
}
```

To **disable a default loom rule** (e.g., `no-todo-fixme`):
```json
{
  "kind": "regex",
  "name": "no-todo-fixme",
  "description": "Disabled for this project",
  "extensions": [".ts"],
  "pattern": "x]^",
  "flags": "",
  "fixHint": "disabled",
  "enabled": false
}
```

### Step 4: Run the Linter

Execute the loom linter against the project using this inline script:

```typescript
// Run with: bun <this-script>
import { resolve, join, extname, dirname, relative } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";

const LOOM_ROOT = "${CLAUDE_PLUGIN_ROOT}";
const DEFAULT_RULES_DIR = join(LOOM_ROOT, "..", "lint-rules");
const { lintFile } = await import(join(LOOM_ROOT, "..", "engine/src/linter/index.ts"));

const PROJECT_ROOT = resolve(".");
const RULES_DIR = existsSync(".claude/linter/rules") ? resolve(".claude/linter/rules")
  : existsSync(".pi/linter/rules") ? resolve(".pi/linter/rules") : null;

const SKIP = new Set(["node_modules", ".git", ".claude", ".pi", "dist", "build"]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".java"]);

function walk(dir: string): string[] {
  const r: string[] = [];
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const f = join(dir, e);
    const s = statSync(f, { throwIfNoEntry: false });
    if (!s) continue;
    if (s.isDirectory()) r.push(...walk(f));
    else if (EXTS.has(extname(e)) && !e.endsWith(".d.ts") && !e.includes(".test.") && !e.includes(".spec.")) r.push(f);
  }
  return r;
}

const files = walk(PROJECT_ROOT);
let violations = 0;
for (const file of files) {
  const result = lintFile(file, "full", DEFAULT_RULES_DIR, RULES_DIR);
  if (result.kind === "violations") {
    for (const v of result.violations) {
      violations++;
      console.log(`  ${relative(PROJECT_ROOT, file)}:${v.line} [${v.rule}] ${v.text.trim()}`);
      console.log(`    → ${v.fixHint}\n`);
    }
  } else if (result.kind === "error") {
    console.error(`  ERROR: ${relative(PROJECT_ROOT, file)}: ${result.message}`);
  }
}
console.log(violations === 0 ? "✓ No violations" : `✗ ${violations} violation(s)`);
```

Write this to a temp file and run it:
```bash
bun /tmp/loom-lint-run.ts
```

### Step 5: Report Results

Present findings grouped by severity:

```markdown
## Lint Results

### Boundary Violations (must fix)
These indicate architectural layer breaks — domain importing infra, etc.

### Purity Violations (must fix)
I/O operations in declared-pure modules.

### Code Quality (advisory)
- `max-function-lines` — consider decomposing
- `no-non-null-assertion` — consider explicit guards
- `no-unsafe-as-any` — consider proper typing

### Summary
- Files scanned: N
- Violations: N (boundary: X, purity: Y, quality: Z)
```

### Step 6: Fix Violations (if requested)

For each violation category, offer to fix:

- **Boundary violations**: Move the import to the correct layer, or introduce a port/interface
- **Purity violations**: Extract I/O to a parameter/callback, or remove the file from `pureModules`
- **Non-null assertions**: Add explicit null checks with error returns
- **Function length**: Extract helper functions

---

## Available Rules Reference

### Default Regex Rules (from loom)

| Rule | What it catches | Default |
|------|-----------------|---------|
| `no-any-type` | `: any` annotations | enabled |
| `no-console-log` | `console.log()` calls | enabled |
| `no-todo-fixme` | `// TODO` / `// FIXME` | enabled |
| `prefer-ts-pattern` | `switch()` statements | disabled |

### Programmatic Rules (from config.json)

| Rule | What it enforces |
|------|-----------------|
| `no-cross-boundary-imports` | Import direction between modules |
| `no-io-in-pure-modules` | No side effects in functional core |
| `max-function-lines` | Function body length limit |

---

## Constraints

- MUST check for existing rules before creating new ones
- MUST ask user about their architecture before generating boundaries
- MUST place config.json inside the `rules/` directory (same dir as rule JSONs)
- MUST validate JSON syntax before writing rule files
- MUST NOT generate boundaries that conflict with the project's actual import graph
- Config placement: `.claude/linter/rules/config.json` (Claude Code) or `.pi/linter/rules/config.json` (Pi)
- Rule JSONs go in the same `rules/` directory
- When running the linter, use `${CLAUDE_PLUGIN_ROOT}/../lint-rules` as default rules dir
- When running the linter, use `${CLAUDE_PLUGIN_ROOT}/../engine/src/linter/index.ts` as linter entry

---

## Troubleshooting

**"Rule file config.json: 'kind' must be a non-empty string"**
- The loom loader was reading `config.json` as a rule file. Ensure you're using the patched loader that skips `config.json` in `loadRulesFromDir`.

**Boundary rule not firing:**
- Check that `module` path matches the file's repo-relative path (use forward slashes)
- Check that the import specifier, once resolved, starts with a `deny` entry
- Relative imports are resolved against the file's directory

**Pure module false positive on `new Date(arg)`:**
- The purity checker flags `new Date(` unless followed by `"`, `'`, or a digit
- If your pure module legitimately constructs dates from stored strings, remove it from `pureModules`

**No violations found but architecture is wrong:**
- Boundaries are an allowlist — add explicit `deny` entries for the patterns you want to catch
- Check `module` paths have trailing `/` for directory matching
