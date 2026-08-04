---
name: lint-project
version: "1.0.0"
description: "This skill should be used when the user asks to 'lint the project', 'run linter', 'check lint rules', 'setup linting', 'add lint rules', 'configure linter', 'check architecture boundaries', 'check purity', 'run boundary checks', or needs to set up or run loom's programmatic linter against their codebase. Handles both initial setup (creating rules/config) and execution (running the linter and reporting violations)."
---

# Lint Project

Set up and run loom's architectural linter against any codebase. Enforces FC/IS boundaries, import direction, purity constraints, and code quality rules at edit time and on demand.

**This is a SETUP + EXECUTION skill** — first ensure the project has lint rules configured, then run the linter and report findings.

## References

| Section | File | Purpose |
|---------|------|---------|
| TypeScript setup | `references/typescript.md` | TS/JS boundary patterns, pure modules, regex rules |
| Java setup | `references/java.md` | Java/Spring boundary patterns, purity, DDD rules |
| Runner script | `references/runner.md` | Inline bun script for running the linter |

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
   ls tsconfig.json package.json pom.xml build.gradle* settings.gradle* 2>/dev/null
   ```

2. **Identify module structure:**
   ```bash
   # TypeScript
   find . -name "package.json" -not -path "*/node_modules/*" | head -20
   # Java
   find . -name "pom.xml" -o -name "build.gradle*" | head -10
   find src/main/java -type d -maxdepth 4 2>/dev/null
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

Create the linter directory:

```bash
mkdir -p .claude/linter/rules
```

**Read the appropriate reference for the project's language:**
- TypeScript/JavaScript → read `references/typescript.md`
- Java/Kotlin/Spring → read `references/java.md`
- Both → read both

Generate `config.json` in the `rules/` directory with:
- `boundaries` — import direction enforcement per module
- `pureModules` — paths that must be side-effect free
- `maxFunctionLines` — max function body length
- `excludeFromMaxLines` — test file patterns to skip

Generate additional `.json` rule files in the same `rules/` directory for project-specific regex patterns.

**Key rules for config.json structure:**

```json
{
  "boundaries": [
    {
      "module": "<path-prefix-with-trailing-slash>/",
      "allow": ["./", "<allowed-import-prefixes>"],
      "deny": ["<forbidden-import-prefixes>"]
    }
  ],
  "pureModules": ["<paths-that-must-have-no-IO>/"],
  "maxFunctionLines": 50,
  "excludeFromMaxLines": [".test.ts", ".spec.ts", "Test.java"]
}
```

**To disable a default loom rule**, create a JSON override with the same `name` and `"enabled": false`:

```json
{
  "kind": "regex",
  "name": "no-todo-fixme",
  "description": "Disabled for this project",
  "extensions": [".ts"],
  "pattern": "x^",
  "flags": "",
  "fixHint": "disabled",
  "enabled": false
}
```

### Step 4: Run the Linter

Read `references/runner.md` for the inline script. Write it to a temp file and execute:

```bash
bun /tmp/loom-lint-run.ts
```

Or for a summary only:

```bash
bun /tmp/loom-lint-run.ts --summary
```

### Step 5: Report Results

Present findings grouped by severity:

```markdown
## Lint Results

### Boundary Violations (must fix)
Import direction breaks — domain importing infra, etc.

### Purity Violations (must fix)
I/O operations in declared-pure modules.

### Code Quality (advisory)
- max-function-lines — consider decomposing
- no-non-null-assertion — consider explicit guards
- no-unsafe-as-any / no-null-return — consider proper typing

### Summary
Files scanned: N | Violations: N (boundary: X, purity: Y, quality: Z)
```

### Step 6: Fix Violations (if requested)

- **Boundary violations**: Move the import to the correct layer, or introduce a port/interface
- **Purity violations**: Extract I/O to a parameter/callback, or remove the file from `pureModules`
- **Non-null assertions**: Add explicit null checks with error returns
- **Function length**: Extract helper functions

---

## Constraints

- MUST check for existing rules before creating new ones
- MUST ask user about their architecture before generating boundaries
- MUST place `config.json` inside the `rules/` directory (same dir as rule JSONs)
- MUST validate JSON syntax before writing rule files
- MUST NOT generate boundaries that conflict with the project's actual import graph
- Config location: `.claude/linter/rules/config.json` (Claude Code) or `.pi/linter/rules/config.json` (Pi)
- When running the linter, use `${CLAUDE_PLUGIN_ROOT}/lint-rules` as the default rules directory
- When running the linter, use `${CLAUDE_PLUGIN_ROOT}/engine/src/linter/index.ts` as the linter entry

---

## Troubleshooting

**"Rule file config.json: 'kind' must be a non-empty string"**
- The loom loader wasn't skipping `config.json` when scanning for rules. Fixed in loader.ts — `loadRulesFromDir` now filters out `config.json`.

**Boundary rule not firing:**
- Check that `module` path matches the file's repo-relative path (forward slashes)
- Check that the resolved import specifier starts with a `deny` entry
- Relative imports (`./foo`, `../bar`) are resolved against the importing file's directory

**Pure module false positive on `new Date(arg)`:**
- The purity checker flags `new Date(` unless followed by `"`, `'`, or a digit
- If your pure module legitimately constructs dates from stored strings, remove it from `pureModules`

**No violations found but architecture is wrong:**
- Boundaries use an allowlist — add explicit `deny` entries for forbidden patterns
- Ensure `module` paths have trailing `/` for directory prefix matching
