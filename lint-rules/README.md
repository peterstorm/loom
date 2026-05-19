# Lint Rules — Authoring Guide

Loom's PostEdit linter uses declarative JSON rule files and programmatic TypeScript rules to catch bad code patterns. This guide covers writing rules, configuring per-project, and the complete rule reference.

## Table of Contents

- [Rule JSON Schema](#rule-json-schema)
- [How Rules Are Loaded](#how-rules-are-loaded)
- [Override Semantics](#override-semantics)
- [Project Configuration](#project-configuration)
- [Built-in Rules Reference](#built-in-rules-reference)
- [Writing Custom Rules](#writing-custom-rules)
- [Programmatic Rules](#programmatic-rules)
- [Regex Safety](#regex-safety-considerations)
- [Execution Model](#execution-model)

---

## Rule JSON Schema

Each regex rule is a single `.json` file with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `"regex"` | ✅ | Rule type. Use `"regex"` for declarative pattern-matching rules. |
| `name` | `string` | ✅ | Unique identifier (kebab-case). Used for override matching. |
| `description` | `string` | ✅ | Human-readable explanation of what the rule catches. |
| `extensions` | `string[]` | ✅ | File extensions this rule applies to (e.g., `[".ts", ".tsx"]`). Include the leading dot. |
| `pattern` | `string` | ✅ | Regex source string (without delimiters). Matched against each line. |
| `flags` | `string` | ✅ | Regex flags (e.g., `"i"` for case-insensitive). Use `""` for none. |
| `fixHint` | `string` | ✅ | Actionable suggestion shown when the rule triggers. |
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

---

## How Rules Are Loaded

The linter loads rules from two directories, merged at runtime:

1. **Default rules** — Bundled with loom in the `lint-rules/` directory. Ship with every installation.

2. **Project-local rules** — Defined in `.claude/linter/rules/*.json` (or `.pi/linter/rules/*.json` for Pi projects).

### Load Order

```
lint-rules/*.json                → tagged source: "default"
.claude/linter/rules/*.json      → tagged source: "project"  (or .pi/linter/rules/ for Pi)
```

The `source` field is set automatically by the loader — do **not** include it in your JSON files.

### Enforcement Model

**Automatic (opt-out, not opt-in):** When a repo uses Loom, the linter fires on every edit. No setup required.

**Project-local control:**
- **Disable a rule:** Drop a JSON file with `"enabled": false` in your project rules dir
- **Override a rule:** Same `name`, different pattern/extensions
- **Add custom rules:** New `name` in project rules dir

---

## Override Semantics

| Scenario | Behavior |
|----------|----------|
| Project rule has **same `name`** as default | Project rule **replaces** the default entirely |
| Project rule sets `"enabled": false` | Rule is **disabled** — no matching occurs |
| Project rule has a **new `name`** | Rule is **added** alongside defaults |

### Disabling a Default Rule

Create `.claude/linter/rules/no-console-log.json`:

```json
{
  "kind": "regex",
  "name": "no-console-log",
  "description": "Disabled — we allow console.log in this project",
  "extensions": [],
  "pattern": "",
  "flags": "",
  "fixHint": "",
  "enabled": false
}
```

### Disabling a Programmatic Rule

Same mechanism — create a JSON override by name:

```json
{
  "kind": "regex",
  "name": "no-cross-boundary-imports",
  "description": "Disabled",
  "extensions": [],
  "pattern": "",
  "flags": "",
  "fixHint": "",
  "enabled": false
}
```

---

## Project Configuration

Programmatic rules (boundary checking, I/O detection, function length) use project-local configuration to adapt to your codebase structure.

### Config File Location

```
.claude/linter/config.json     (Claude Code projects)
.pi/linter/config.json         (Pi projects)
```

### Config Schema

```json
{
  "boundaries": [
    {
      "module": "src/main/java/com/example/domain/",
      "allow": ["./", "java.util", "java.time"],
      "deny": ["com.example.infra", "com.example.api", "org.springframework"]
    },
    {
      "module": "src/main/java/com/example/api/",
      "allow": ["./", "com.example.domain"],
      "deny": ["com.example.infra"]
    }
  ],
  "pureModules": [
    "src/main/java/com/example/domain/",
    "src/lib/domain/"
  ],
  "maxFunctionLines": 40,
  "excludeFromMaxLines": [".test.ts", ".test.java", ".spec.ts"]
}
```

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `boundaries` | `BoundaryRule[]` | Loom's own boundaries | Import boundary rules for `no-cross-boundary-imports` |
| `pureModules` | `string[]` | Loom's core modules | File path patterns that must be side-effect free |
| `maxFunctionLines` | `number` | `50` | Max lines per function body for `max-function-lines` |
| `excludeFromMaxLines` | `string[]` | Test file patterns | File suffixes to exclude from line-length checking |

### BoundaryRule Structure

```typescript
{
  module: string;    // Path prefix that identifies the module (with trailing /)
  allow: string[];   // Allowed import prefixes (relative "./" always works)
  deny: string[];    // Denied import prefixes (checked first)
}
```

### No Config = Loom Defaults

If no `config.json` exists, the programmatic rules use Loom's built-in defaults (targeting `engine/src/linter/`, `engine/src/core/`, `engine/src/parsers/`). These only produce violations in the Loom codebase itself — other repos won't see false positives.

---

## Built-in Rules Reference

### TypeScript Rules (Immediate Tier)

| Rule | Pattern | Enabled | What it catches |
|------|---------|---------|-----------------|
| `no-any-type` | `:\s*any\b` | ✅ | Explicit `: any` type annotations |
| `no-console-log` | `console\.log\(` | ✅ | `console.log()` calls |
| `no-todo-fixme` | `//\s*(TODO\|FIXME)` | ✅ | `// TODO` and `// FIXME` comments |
| `prefer-ts-pattern` | `switch\s*\(` | ❌ | `switch()` statements (opt-in) |

### Java Rules (Immediate Tier)

| Rule | Pattern | Enabled | What it catches |
|------|---------|---------|-----------------|
| `no-system-out` | `System\.(out\|err)\.(print\|println\|printf)\(` | ✅ | System.out/err print calls |
| `no-raw-exception-catch` | `catch\s*\(\s*(Exception\|Throwable)\s+` | ✅ | Catching raw Exception/Throwable |
| `no-null-return` | `return\s+null\s*;` | ✅ | Returning null (use Optional) |
| `no-field-injection` | `@(Autowired\|Inject)` on field | ✅ | Field injection (use constructor) |
| `no-mutable-entity-fields` | Non-final instance fields | ❌ | Mutable fields (opt-in) |
| `no-star-import` | `import\s+[\w.]+\.\*\s*;` | ✅ | Wildcard imports |

### Programmatic Rules (Full Tier — Wave-Gate Only)

| Rule | Languages | What it enforces |
|------|-----------|-----------------|
| `no-cross-boundary-imports` | TS, Java | Import direction between bounded contexts |
| `no-io-in-pure-modules` | TS, Java | No filesystem/network/console/non-determinism in pure modules |
| `max-function-lines` | TS, Java | Function bodies ≤ configured max (default: 50 lines) |

---

## Writing Custom Rules

### Step 1: Identify the Pattern

Determine what bad code pattern you want to catch. Express it as a regex that matches a single line.

### Step 2: Scope to File Extensions

Only apply the rule to relevant file types. A rule with `"extensions": [".ts", ".tsx"]` will not run against `.java` files.

### Step 3: Write a Clear Fix Hint

The `fixHint` is shown to the AI agent (or developer) when a violation fires. Make it actionable:

- ❌ "Don't do this"
- ✅ "Replace `var` with `const` or `let` — var has function scope which leads to bugs"

### Step 4: Place the File

- For rules that should ship with loom: add to `lint-rules/`
- For project-specific rules: add to `.claude/linter/rules/` (or `.pi/linter/rules/`)

### Examples

**Block `var` declarations (TypeScript/JavaScript):**
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

**Block `@ts-ignore` comments (TypeScript):**
```json
{
  "kind": "regex",
  "name": "no-ts-ignore",
  "description": "Disallow @ts-ignore — use @ts-expect-error with explanation instead",
  "extensions": [".ts", ".tsx"],
  "pattern": "@ts-ignore",
  "flags": "",
  "fixHint": "Replace @ts-ignore with @ts-expect-error and add a comment explaining why",
  "enabled": true
}
```

**Block `Thread.sleep()` in Java tests:**
```json
{
  "kind": "regex",
  "name": "no-thread-sleep",
  "description": "Disallow Thread.sleep() in tests — use Awaitility or CountDownLatch",
  "extensions": [".java"],
  "pattern": "Thread\\.sleep\\(",
  "flags": "",
  "fixHint": "Use Awaitility.await().atMost(...).until(...) instead of Thread.sleep()",
  "enabled": true
}
```

---

## Programmatic Rules

Programmatic rules run TypeScript handler functions that can perform deeper structural analysis than regex allows. They run only in the `"full"` tier (wave-gate boundaries).

### How They Work

Each programmatic rule is a function with signature:
```typescript
(content: string, filePath: string) => Violation[]
```

The rule receives the full file content and path, and returns any violations found. Rules are registered in `engine/src/linter/programmatic/index.ts`.

### Built-in Programmatic Rules

#### `no-cross-boundary-imports`

Parses import statements and checks against configured boundary rules. Prevents bounded contexts from depending on each other incorrectly.

**Detects:**
- `engine/src/linter/` importing from `engine/src/core/` (wrong direction)
- `domain/` package importing from `infra/` (architecture violation)
- Any import matching a `deny` list entry

**Configure per-project:** Set `boundaries` in `config.json`.

#### `no-io-in-pure-modules`

Scans modules classified as "functional core" for I/O operations.

**Detects:**
- Imports: `node:fs`, `node:net`, `node:http`, `node:child_process`
- Globals: `process.env`, `process.exit`, `console.log/error/warn`
- Non-determinism: `Math.random()`, `new Date()` (without argument), `fetch()`

**Allows:** `node:path`, `node:url` (side-effect free modules)

**Configure per-project:** Set `pureModules` in `config.json`.

#### `max-function-lines`

Uses bracket-depth tracking to detect functions exceeding a line limit.

**Detects:**
- `function` declarations
- Arrow functions with block bodies (`const x = () => { ... }`)
- Class methods

**Excludes:** Test files (`.test.ts`, `.spec.ts`) by default.

**Configure per-project:** Set `maxFunctionLines` and `excludeFromMaxLines` in `config.json`.

---

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

1. **Keep patterns simple** — Line-by-line matching means you don't need `.*` to span content.
2. **Avoid nested quantifiers** — `(x+)+`, `(x*)*`, `(x+)*` are classic ReDoS triggers.
3. **Use word boundaries** — `\b` prevents partial matches without backtracking risk.
4. **Prefer character classes** — `[a-z]+` is safer than `(a|b|c|...|z)+`.
5. **Test with long inputs** — If your pattern is slow on a 10,000-char line, it may backtrack.

### Runtime Safety Net

Even if a pattern passes static analysis, the linter enforces a **50ms timeout** per file. If execution exceeds this budget, the linter fails closed with an error identifying the rule.

---

## Execution Model

### Line-by-Line Evaluation

Regex rules are evaluated **line-by-line** against file content:
- Patterns don't need to handle multi-line content
- `^` and `$` anchors match line boundaries
- The entire matched line is reported in the violation

### Tier System

| Tier | When | Rules | Budget |
|------|------|-------|--------|
| `immediate` | After every edit (PostToolUse/tool_result) | Regex rules only | <50ms |
| `full` | At wave-gate boundaries | All rules (regex + programmatic) | Unbounded |

The immediate tier runs after every file write to catch surface-level issues instantly. The full tier runs at natural pause points where deeper structural analysis is acceptable.

### Fail-Closed Guarantee

Any linter error (malformed rule, timeout, crash) **blocks the edit**. The linter never silently passes — if something goes wrong, the agent sees the error and can investigate.

---

## Quick Reference: Project Setup

### TypeScript project (minimal)

```
.claude/linter/
├── rules/
│   └── (override files if needed)
└── config.json     ← optional, for boundary/purity config
```

### Java/Spring Boot project

```
.claude/linter/
├── rules/
│   └── no-mutable-entity-fields.json  ← enable opt-in rule
└── config.json
```

**`config.json`:**
```json
{
  "boundaries": [
    {
      "module": "src/main/java/com/example/domain/",
      "allow": ["./", "java."],
      "deny": ["com.example.infra", "com.example.api", "org.springframework"]
    }
  ],
  "pureModules": [
    "src/main/java/com/example/domain/model/",
    "src/main/java/com/example/domain/service/"
  ],
  "maxFunctionLines": 40
}
```

### Enable opt-in `no-mutable-entity-fields`:

```json
{
  "kind": "regex",
  "name": "no-mutable-entity-fields",
  "description": "Block non-final instance fields in domain classes",
  "extensions": [".java"],
  "pattern": "^\\s+(private|protected)\\s+(?!static|final|transient)[A-Z][\\w]*\\s+\\w+\\s*[;=]",
  "flags": "",
  "fixHint": "Make this field final, or convert the class to a Java record",
  "enabled": true
}
```
