---
name: lint-project
version: "1.0.0"
description: "This skill should be used when the user asks to 'lint the project', 'run linter', 'check lint rules', 'setup linting', 'add lint rules', 'configure linter', 'check architecture boundaries', 'check purity', 'run boundary checks', or needs to set up or run loom's programmatic linter against their codebase. Handles both initial setup (creating rules/config) and execution (running the linter and reporting violations)."
---

# Lint Project

Set up and run loom's architectural linter against any codebase. Enforces FC/IS boundaries, import direction, purity constraints, and code quality rules at edit time and on demand.

**This is a SETUP + EXECUTION skill** — first ensure the project has lint rules configured, then run the linter and report findings.

**The scoping model: everything is linted; exclusions are explicit and reasoned.**
The runner reads every file with a lintable extension — tests, `.mts`/`.cts`/`.mjs`/`.cjs`
modules and declaration files included — minus one `exclude` list in `config.json`
whose every entry states why that path must not be checked. The functional core is
pure by default inside its roots (`pureModules`), minus declared shells
(`impureModules`, each with the I/O it does). Under `requireGovernance`, a file no
boundary names is a violation, not an allow. Every list that subtracts from the
linter's reach is checked for staleness on every full run.

## References

| Section | File | Purpose |
|---------|------|---------|
| TypeScript setup | `references/typescript.md` | TS/JS boundary patterns, pure modules, regex rules |
| Java setup | `references/java.md` | Java/Spring boundary patterns, purity, DDD rules |
| Runner | `references/runner.md` | `scripts/lint-project.ts`: scope, options, exit codes |

---

## Workflow

### Step 1: Check for Existing Configuration

Check if the project already has linter rules:

```bash
ls .claude/linter/rules/ 2>/dev/null || ls .pi/linter/rules/ 2>/dev/null || echo "NO_RULES"
```

The first directory found is the project's one rules directory — both Claude Code and Pi read it. `.pi/linter/rules/` is used only by a Pi-only project that has no `.claude/linter/rules/`; a project carrying both is refused by `lint-project` (delete one).

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
- `boundaries` — import direction enforcement per module (optional `description`, and per-file
  capability grants `perFileAllow` / `perFileExactAllow`, each `{ "allow": [...], "reason": "..." }`)
- `requireGovernance` — path roots inside which every file must belong to a boundary
- `pureModules` — the functional core's roots (`dir/`) and single files: every non-test file beneath is pure
- `impureModules` — `[{ "path", "reason" }]` — the shells inside those roots, each with the I/O it does
- `exclude` — `[{ "path", "reason" }]` — paths the linter must never read (vendored, generated)
- `maxFunctionLines` — max function body length
- `excludeFromMaxLines` — test file patterns to skip

The parse is strict: an unknown key, a glob, an absolute path, or an exemption without a
reason is refused by name — a typo never silently falls back to "check nothing".

Generate additional `.json` rule files in the same `rules/` directory for project-specific regex patterns.

**Key rules for config.json structure:**

```json
{
  "exclude": [
    { "path": "<vendored-or-generated-path>/", "reason": "<why it must not be checked>" }
  ],
  "requireGovernance": ["<source-root>/"],
  "boundaries": [
    {
      "module": "<path-prefix-with-trailing-slash>/",
      "description": "<what the module is and which way its imports point>",
      "allow": ["./", "<allowed-import-prefixes>"],
      "deny": ["<forbidden-import-prefixes>"]
    }
  ],
  "pureModules": ["<functional-core-root>/"],
  "impureModules": [
    { "path": "<functional-core-root>/<shell>.ts", "reason": "<the I/O it does>" }
  ],
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

**Grandfather pre-existing totality sites and copied blocks.** `switch-totality`
applies to every TypeScript file without configuration, and `no-duplicate-block`
to every TypeScript and JavaScript file, so an existing codebase's unproven
switches and already-duplicated blocks would block the next agent edit to each file. Record them once, after
`config.json` exists:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts --write-baseline
```

Show the user the counts it prints; the lists are debt that only shrinks.

### Step 4: Run the Linter

Run the shipped runner (see `references/runner.md` for its scope, options and exit codes):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts
```

Or for a summary only:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts --summary
```

### Step 5: Report Results

Present findings grouped by severity:

```markdown
## Lint Results

### Boundary Violations (must fix)
Import direction breaks — domain importing infra, etc.

### Purity Violations (must fix)
I/O operations in the functional core (under a pure root, not a declared shell).

### Code Quality
- max-function-lines — decompose
- no-non-null-assertion — prove the value exists (production code; tests are exempt)
- no-unsafe-as-any — type the value instead of switching the checker off
- no-catch-ignore — handle or rethrow; never an empty catch
- no-null-return (Java) — Optional or an empty collection

### Summary
Files scanned: N | Violations: N (boundary: X, purity: Y, quality: Z)
```

### Step 6: Fix Violations (if requested)

- **Boundary violations**: Move the import to the correct layer, or introduce a port/interface
- **Purity violations**: Extract the I/O to a shell and inject it as a parameter/port; only a module whose JOB is the I/O belongs in `impureModules`, with its reason
- **Ungoverned module**: Add the boundary its directory needs, stating which way its imports point
- **Non-null assertions**: Add explicit null checks with error returns
- **Function length**: Extract helper functions

---

## Constraints

- MUST check for existing rules before creating new ones
- MUST ask user about their architecture before generating boundaries
- MUST place `config.json` inside the `rules/` directory (same dir as rule JSONs)
- MUST validate JSON syntax before writing rule files
- MUST NOT generate boundaries that conflict with the project's actual import graph
- Config location: `.claude/linter/rules/config.json`, read by both harnesses (`.pi/linter/rules/config.json` only in a Pi-only project without `.claude/linter/rules/`; never both)
- When running the linter, use `${CLAUDE_PLUGIN_ROOT}/lint-rules` as the default rules directory
- When running the linter, use `${CLAUDE_PLUGIN_ROOT}/engine/src/linter/index.ts` as the linter entry

---

## Editing the linter itself

When the linter is what you are changing, two things behave differently from
editing ordinary code:

**The edit-time hook reads the INSTALLED plugin's rules, not your checkout.**
`lintFile` resolves `lint-rules/` and `engine/src/linter/` from the loom
installation the hook was loaded from, so a rule you just wrote in a worktree —
or a `perFileExactAllow` grant you just added to a worktree's config — is
invisible to the hook until it loads your build. A new rule therefore proves
itself with `bun scripts/lint-project.ts` (which lints the checkout it lives in)
plus its own test, never with "the hook stayed quiet".

**A newer `config.json` can outrun the installed engine.** The strict parser
refuses unknown keys, but only from the version that knows them: an older
installed plugin reading a config that uses `exclude`, `impureModules`,
`requireGovernance` or reasoned capability grants may misread it until the
installed plugin is updated. Prove config changes with `bun scripts/lint-project.ts`
from the checkout, as above.

### Baselines: a rule that only subtracts violations silently stops applying

Grandfathered baselines (`switch-totality`,
`exhaustive-discriminant-branching`, `no-duplicate-block`) excuse sites that predate the rule, and
their failure mode is silence: a renamed scrutinee or a deleted switch leaves an
entry protecting nothing. The lists are project data in `config.json`
(`switchTotalityBaseline`, `discriminantBranchingBaseline`, `duplicateBlockBaseline`), keyed relative to
the project root and written by `scripts/lint-project.ts --write-baseline`.
`scripts/lint-project.ts` reports stale entries in any project and exits
non-zero on them; loom asserts its own lists against its live tree in
`tests/linter/programmatic/totality-baseline.test.ts`. A baseline-backed rule
registers in `baselineOwners` (`engine/src/linter/programmatic/index.ts`) and
joins both the drift report and `--write-baseline`.

---

## Troubleshooting

**"Rule file config.json: 'kind' must be a non-empty string"**
- The loom loader wasn't skipping `config.json` when scanning for rules. Fixed in loader.ts — `loadRulesFromDir` now filters out `config.json`.

**Boundary rule not firing:**
- Check that `module` path matches the file's repo-relative path (forward slashes)
- Check that the resolved import specifier starts with a `deny` entry
- Relative imports (`./foo`, `../bar`) are resolved against the importing file's directory

**Pure module false positive on `new Date(arg)`:**
- The purity checker flags only `new Date()` with no argument; `new Date(value)` is deterministic
- A banned global named inside a string or a trailing `//` comment is not a call and is not flagged

**A file excluded, or a module declared impure, that should not be:**
- Every `exclude` and `impureModules` entry carries its reason — read it; an entry whose
  reason no longer holds is deleted, and `lint-project` reports entries that match nothing

**No violations found but architecture is wrong:**
- Boundaries use an allowlist — add explicit `deny` entries for forbidden patterns
- Ensure `module` paths have trailing `/` for directory prefix matching
- Set `requireGovernance` so a file in a directory no boundary names fails instead of passing
- The shipped defaults govern nothing and hold nothing pure: a project without `boundaries` /
  `pureModules` gets neither rule's protection
