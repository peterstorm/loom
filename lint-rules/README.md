# Lint Rules — Authoring Guide

Loom's PostEdit linter uses declarative JSON rule files to catch bad code patterns immediately after edits. This guide explains how to write, customize, and override lint rules.

## Rule JSON Schema

Each rule is a single `.json` file with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `"regex"` | ✅ | Rule type. Currently only `"regex"` is supported for declarative rules. |
| `name` | `string` | ✅ | Unique identifier for the rule (kebab-case). Used for override matching. |
| `description` | `string` | ✅ | Human-readable explanation of what the rule catches. |
| `extensions` | `string[]` | ✅ | File extensions this rule applies to (e.g., `[".ts", ".tsx"]`). Include the leading dot. |
| `pattern` | `string` | ✅ | Regex source string (without delimiters). Matched against each line of the file. |
| `flags` | `string` | ❌ | Regex flags (e.g., `"i"` for case-insensitive). Default: none. |
| `fixHint` | `string` | ✅ | Actionable suggestion shown when the rule triggers. Tells the developer what to do instead. |
| `enabled` | `boolean` | ✅ | Whether the rule is active. Set to `false` to disable. |

### Example

```json
{
  "kind": "regex",
  "name": "no-console-log",
  "description": "Disallow console.log() calls — use structured logging",
  "extensions": [".ts", ".tsx"],
  "pattern": "console\\.log\\(",
  "flags": "",
  "fixHint": "Remove console.log() or replace with a structured logger",
  "enabled": true
}
```

## How Rules Are Loaded

The linter loads rules from two directories, merged at runtime:

1. **Default rules** — Bundled with loom in the `lint-rules/` directory. These ship with every installation and provide baseline code quality checks.

2. **Project-local rules** — Defined in `.claude/linter/rules/*.json` (or `.pi/linter/rules/*.json` for Pi projects). These are project-specific and live alongside other project configuration.

### Load Order

```
lint-rules/*.json          → tagged source: "default"
.claude/linter/rules/*.json    → tagged source: "project"  (or .pi/linter/rules/ for Pi)
```

The `source` field is set automatically by the loader — do **not** include it in your JSON files.

## Override Semantics

Project-local rules can override or disable default rules:

| Scenario | Behavior |
|----------|----------|
| Project rule has **same `name`** as default | Project rule **replaces** the default entirely |
| Project rule sets `"enabled": false` | Rule is **disabled** — no matching occurs |
| Project rule has a **new `name`** | Rule is **added** alongside defaults |

### Disabling a Default Rule

To disable the bundled `no-console-log` rule for your project, create `.claude/linter/rules/no-console-log.json`:

```json
{
  "kind": "regex",
  "name": "no-console-log",
  "description": "Disabled — we allow console.log in this project",
  "extensions": [],
  "pattern": "",
  "fixHint": "",
  "enabled": false
}
```

### Overriding a Default Rule

To change the pattern or scope of a default rule, create a project-local rule with the same `name`:

```json
{
  "kind": "regex",
  "name": "no-console-log",
  "description": "Block console.log but only in source files, not tests",
  "extensions": [".ts"],
  "pattern": "console\\.log\\(",
  "flags": "",
  "fixHint": "Use logger.info() instead of console.log()",
  "enabled": true
}
```

## Writing Custom Rules

### Step 1: Identify the Pattern

Determine what bad code pattern you want to catch. Express it as a regex that matches a single line.

### Step 2: Scope to File Extensions

Only apply the rule to relevant file types. A rule with `"extensions": [".ts", ".tsx"]` will not run against `.js` files.

### Step 3: Write a Clear Fix Hint

The `fixHint` is shown to the AI agent (or developer) when a violation fires. Make it actionable:

- ❌ "Don't do this"
- ✅ "Replace `var` with `const` or `let` — var has function scope which leads to bugs"

### Step 4: Place the File

- For rules that should ship with loom: add to `lint-rules/`
- For project-specific rules: add to `.claude/linter/rules/` (or `.pi/linter/rules/`)

### More Examples

**Block `var` declarations:**
```json
{
  "kind": "regex",
  "name": "no-var",
  "description": "Disallow var declarations — use const or let",
  "extensions": [".ts", ".tsx", ".js", ".jsx"],
  "pattern": "\\bvar\\s+\\w",
  "flags": "",
  "fixHint": "Replace 'var' with 'const' (preferred) or 'let' if reassignment is needed",
  "enabled": true
}
```

**Block `@ts-ignore` comments:**
```json
{
  "kind": "regex",
  "name": "no-ts-ignore",
  "description": "Disallow @ts-ignore — use @ts-expect-error with explanation instead",
  "extensions": [".ts", ".tsx"],
  "pattern": "@ts-ignore",
  "flags": "",
  "fixHint": "Replace @ts-ignore with @ts-expect-error and add a comment explaining why the suppression is needed",
  "enabled": true
}
```

**Block `sleep()` calls in tests (case-insensitive):**
```json
{
  "kind": "regex",
  "name": "no-sleep-in-tests",
  "description": "Disallow sleep/delay calls in test files — use waitFor or fake timers",
  "extensions": [".test.ts", ".spec.ts"],
  "pattern": "\\b(sleep|delay)\\s*\\(",
  "flags": "i",
  "fixHint": "Use waitFor(), fake timers, or test-specific async utilities instead of sleep/delay",
  "enabled": true
}
```

## Regex Safety Considerations

All regex patterns are statically analyzed for ReDoS (Regular Expression Denial of Service) vulnerabilities at rule load time. Patterns that exhibit potential catastrophic backtracking are **rejected** and the rule will not load.

### Patterns to Avoid

| Dangerous Pattern | Why | Safe Alternative |
|-------------------|-----|------------------|
| `(a+)+` | Nested quantifiers | `a+` |
| `(a\|a)+` | Overlapping alternations | `a+` |
| `(.*a){10}` | Quantified greedy with backtracking | `(?:.*?a){10}` or restructure |
| `(\w+\s*)+` | Nested quantifiers on overlapping sets | `[\w\s]+` |

### Best Practices

1. **Keep patterns simple** — Match the minimal structure needed. Line-by-line matching means you don't need `.*` to span across content.

2. **Avoid nested quantifiers** — `(x+)+`, `(x*)*`, `(x+)*` are the classic ReDoS triggers.

3. **Use word boundaries** — `\b` prevents partial matches without backtracking risk.

4. **Prefer character classes** — `[a-z]+` is safer than `(a|b|c|...|z)+`.

5. **Test with long inputs** — If your pattern takes noticeably longer on a 10,000-character line, it may have backtracking issues.

### Runtime Safety Net

Even if a pattern passes static analysis, the linter enforces a **50ms timeout** per file across all rules. If execution exceeds this budget, the linter fails closed with an error message identifying the problematic execution. This ensures a single bad rule can never hang the edit pipeline.

## Execution Model

Rules are evaluated **line-by-line** against file content. Each line is tested against all enabled rules whose `extensions` match the file. This means:

- Patterns don't need to handle multi-line content
- `^` and `$` anchors match line boundaries
- The entire matched line is reported in the violation

### Tier System

| Tier | When | Rules |
|------|------|-------|
| `immediate` | After every edit (PostToolUse) | Declarative regex rules only |
| `full` | At wave-gate boundaries | All rules (regex + programmatic) |

The immediate tier has a strict <50ms budget to avoid slowing down the edit experience. The full tier runs at natural pause points where latency is acceptable.
