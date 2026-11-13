---
name: lint-project
version: "1.0.0"
description: "Set up and run Loom's linter in a project: create the rules directory and config (import boundaries, pure modules, baselines), run the whole-project lint, report and fix violations. Not for ESLint or other linters, or for PR review (/review-pr)."
---

# Lint Project

Set up and run Loom's architectural linter against a codebase: import direction, purity of the functional core, totality, and code-quality rules, at edit time and on demand.

This skill is the workflow. The facts live in one place each:

| What | Where |
|---|---|
| Rule schema, config fields, every shipped rule, baselines | `${CLAUDE_PLUGIN_ROOT}/lint-rules/README.md` |
| The runner: scope, options, exit codes, how the rules directory is found | `references/runner.md` |
| Boundary templates for TypeScript / JavaScript | `references/typescript.md` |
| Boundary templates for Java / Spring | `references/java.md` |

The model to keep in mind: everything is linted, and every exclusion is explicit and carries its reason.

## Workflow

### Step 1: Check for existing configuration

```bash
ls .claude/linter/rules/ 2>/dev/null || ls .pi/linter/rules/ 2>/dev/null || echo "NO_RULES"
```

- Rules exist → go to Step 4.
- No rules → Step 2.

### Step 2: Analyze the project's architecture

1. Detect the language and build: `tsconfig.json`, `package.json`, `pom.xml`, `build.gradle*`.
2. Find the module structure: workspace `package.json` files, Maven or Gradle modules, the directories under the source root.
3. Identify the layers:
   - `domain/`, `types/`, `models/` → pure core
   - `orchestrator/` → shell that sequences ports and pure logic
   - `infra/`, `adapters/`, `repository/` → I/O adapters
   - `api/`, `controllers/`, `handlers/` → entry points
4. Ask the user before writing any boundary:
   - "What are your layers, and which may import which?"
   - "Which modules are the functional core and must be free of I/O?"
   - "Are there import patterns you want to forbid?"

Check the answers against the import graph that exists. A boundary the current code already violates blocks the next edit to each violating file; say so and let the user choose between fixing the imports first and a narrower boundary.

### Step 3: Generate the configuration

1. Scaffold the rules directory: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts --init`.
2. Read the language reference (both, in a mixed project) and the "Project Configuration" section of the README.
3. Write `config.json` inside the rules directory, beside the rule files:
   - `boundaries`, one per layer, each with a `description` of which way its imports point
   - `requireGovernance`, the source roots inside which every file must belong to a boundary
   - `pureModules`, the functional core's roots; `impureModules`, the shells inside them, each with the I/O it does
   - `exclude`, vendored or generated paths, each with its reason
   - `maxFunctionLines` and `excludeFromMaxLines` if the defaults do not fit
4. Add a rule file for each project-specific pattern, and a disabling file for each default rule the user does not want (README: "Rule File Schema", "Disabling a rule").
5. Record what predates the rules, so existing switches, copied blocks and wire casts do not block the next edit to their files:

   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts --write-baseline
   ```

   Show the user the counts it prints. The lists are debt that only shrinks.

### Step 4: Run the linter

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts
```

Add `--summary` for counts by rule. Other options and the exit codes are in `references/runner.md`.

### Step 5: Report results

```markdown
## Lint Results

### Boundary Violations (must fix)
Import direction breaks — domain importing infra, an ungoverned module.

### Purity Violations (must fix)
I/O in the functional core (under a pure root, not a declared shell).

### Code Quality
Grouped by rule, with counts.

### Stale Entries
Exclusions, roots, grants or baseline entries that no longer match anything.

### Summary
Files scanned: N | Violations: N (boundary: X, purity: Y, quality: Z)
```

### Step 6: Fix violations (if requested)

- **Boundary violation**: move the import to the correct layer, or introduce a port.
- **Ungoverned module**: add the boundary its directory needs, stating which way its imports point.
- **Purity violation**: extract the I/O to a shell and pass it in as a parameter or port. Only a module whose job is the I/O belongs in `impureModules`, with its reason.
- **Unproven switch**: `match(x)…exhaustive()`, or end the switch with `default: return assertNever(x)`.
- **Wire cast**: bind the value as `unknown` and write or reuse a parser that returns the typed value or an error. `as unknown as T` is refused too.
- **Non-null assertion**: an explicit check that returns an error.
- **Empty catch**: handle or rethrow.
- **Function length**: extract helper functions.
- **Stale entry**: delete it; for baselines, re-run `--write-baseline`.

## Troubleshooting

**A boundary rule does not fire.** `module` must match the file's project-relative path with forward slashes, and end in `/` for a directory. A file under no boundary's `module` is not checked at all unless it sits under a `requireGovernance` root.

**An import is refused that no `deny` names.** `allow` is a closed list: inside a governed module, an import matching no `allow` entry is a violation. Add the prefix to `allow`, or grant it to one file with `perFileAllow` and a reason.

**No violations, but the architecture is wrong.** Without `boundaries` and `pureModules` the two architecture rules check nothing. Declare them, and set `requireGovernance` so a file in a directory no boundary names fails instead of passing.

**A file is excluded, or a module declared impure, that should not be.** Every `exclude` and `impureModules` entry carries its reason. Read it; delete the entry if the reason no longer holds.

**The config is refused.** The parse is strict: an unknown key, a glob, an absolute path, or an exemption without a reason is named in the error. `config.json` goes inside the rules directory; one level up it is never read.
