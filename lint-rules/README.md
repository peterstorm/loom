# Lint Rules — Authoring Guide

Loom's PostToolUse linter uses declarative JSON rule files and programmatic TypeScript rules to catch bad code patterns. This guide covers writing rules, project configuration, and the complete rule reference. See [`docs/architecture.md`](../docs/architecture.md) for its place in the engine and [`docs/operations.md`](../docs/operations.md) for run commands.

## Table of Contents

- [Rule JSON Schema](#rule-json-schema)
- [How Rules Are Loaded](#how-rules-are-loaded)
- [Override Semantics](#override-semantics)
- [Scoping Model](#scoping-model)
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
| `flags` | `string` | No | Regex flags (e.g., `"i"` for case-insensitive). Defaults to `""`. |
| `excludePatterns` | `string[]` | No | Normalized file-path suffixes this regex rule skips. |
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

2. **Project-local rules** — Defined in the project's one rules directory, `.claude/linter/rules/*.json`, which both Claude Code and Pi read (`.pi/linter/rules/*.json` only in a Pi-only project that has no `.claude/linter/rules/`).

### Load Order

```
lint-rules/*.json                → tagged source: "default"
.claude/linter/rules/*.json      → tagged source: "project"  (or .pi/linter/rules/ in a Pi-only project)
```

The `source` field is set automatically by the loader — do **not** include it in your JSON files.

### Enforcement Model

**Automatic (opt-out, not opt-in):** When a repo uses Loom, the linter fires on every edit. No setup required.

**Project-local control:**
- **Disable a rule:** Drop a JSON file with `"enabled": false` in your project rules dir
- **Override a rule:** Same `name`, different pattern/extensions
- **Add custom rules:** New `name` in project rules dir

**Invariant rules (executable-models policy):** the loom architecture phase writes checkable plan invariants (`INV-N`) as project-local rules — see `references/executable-models.md`. Both the filename and the JSON `name` field use the same `inv-<n>-<slug>` (override matching keys on `name`). Validate that hand- or agent-written rules load cleanly (from the loom plugin dir, or pass the project rules dir explicitly):

```bash
bun <loom-plugin-dir>/engine/src/cli.ts helper validate-lint-rules <project-rules-dir>
```

Passing a directory that doesn't exist is an error — the helper proves rules load; it never treats a typo'd path as "no rules".

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

## Scoping Model

**Everything is linted; exclusions are explicit and reasoned.** Nothing is in
scope by being listed, and nothing is out of scope by being forgotten.

| Question | Answer | Where it is declared |
|----------|--------|----------------------|
| Which files does `lint-project` read? | Every file with a lintable extension (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .java .kt .scala`), tests and declaration files included | — |
| …except? | Never-source directories (`node_modules`, `.git`, `.claude`, `.pi`, build output, `vendor`, …) and the project's `exclude` list | `exclude: [{ path, reason }]` |
| Which rules skip tests? | Each rule that should, by itself | a regex rule's `excludePatterns`; `isTestFile` in a programmatic rule |
| Which files must be pure? | Every non-test file under a `pureModules` root | `pureModules` |
| …except? | The declared shells inside the roots, each with the I/O it does | `impureModules: [{ path, reason }]` |
| Which files must belong to a boundary? | Every file under a `requireGovernance` root — an ungoverned file is a violation, not an allow | `requireGovernance`, `boundaries` |

Every subtracting list is checked for decay on each full run (see
[`references/runner.md`](../skills/lint-project/references/runner.md)): an
exclusion, root, shell, boundary or capability grant that names nothing fails
the run, like a stale baseline entry.

The generic defaults stay inert for other projects: with no config, the
boundary rule governs nothing and the purity rule holds nothing pure. Loom's own
roots, shells, boundaries and exclusions are in its `.claude/linter/rules/config.json`,
which both harnesses read.

## Project Configuration

Programmatic rules (boundary checking, I/O detection, function length, totality) use project-local configuration to adapt to your codebase structure.

### Config File Location

`config.json` lives **inside** the project rules directory, beside the rule files:

```
.claude/linter/rules/config.json     (every project; read by Claude Code and Pi)
.pi/linter/rules/config.json         (only a Pi-only project with no .claude/linter/rules)
```

A file at `.claude/linter/config.json` (one level up) is never read. A project
has ONE rules directory, and the lookup does not depend on the harness: the
first present of `.claude/linter/rules`, then `.pi/linter/rules`. Both
harnesses' edit hooks, the Wave Gate lint, `helper validate-lint-rules` with no
argument and `lint-project` read that one directory, and
`lint-project --write-baseline` writes only it. A project carrying both layouts
is refused by `lint-project` (exit 2, "keep one rules directory"): the hooks
read only `.claude/linter/rules`, so a `.pi` twin would look enforced while
nothing reads it. The project root is the directory above `.claude/linter/rules` (or
`.pi/linter/rules`) — `lint-project` finds it from any subdirectory — and
every path in the config — module prefixes, baseline keys, exclusions — is
relative to it.

The parse is **strict**: an unknown key (at the top level, in a boundary, an
exemption or a grant) is refused by name, as are globs, absolute or `./`
paths, empty scopes, and exemptions or grants without a reason. A typo must
fail the run, never silently fall back to a default that checks nothing.

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
| `exclude` | `{ path, reason }[]` | `[]` | Paths `lint-project` never reads (vendored, generated). `dir/` or one file; every entry states why |
| `boundaries` | `BoundaryRule[]` | `[]` (governs nothing) | Import boundary rules for `no-cross-boundary-imports` |
| `requireGovernance` | non-empty `string[]` | absent | Roots inside which a file no boundary names is a violation ("ungoverned module") |
| `pureModules` | `string[]` | `[]` (nothing pure) | The functional core: `dir/` roots and single files. Every non-test file beneath a root is pure |
| `impureModules` | `{ path, reason }[]` | `[]` | The shells inside the pure roots, each with the I/O it does |
| `maxFunctionLines` | `number` | `50` | Max lines per function body for `max-function-lines` |
| `excludeFromMaxLines` | `string[]` | Test file patterns | File suffixes to exclude from line-length checking |
| `switchTotalityModules` | non-empty `string[]` | every non-test TS file | Narrows `switch-totality` to these path prefixes. An empty list is refused — disable the rule by name instead |
| `switchTotalityBaseline` | `string[]` | `[]` | Grandfathered `path::scrutinee` sites `switch-totality` excuses, one entry per site |
| `maxDiscriminantBranches` | `number` | `3` | Branches on one tag at which `exhaustive-discriminant-branching` reads an if-chain as a switch |
| `discriminantTags` | `string[]` | `kind`, `status`, `verdict`, `stage`, `severity`, `type` | Field names that tag a discriminated union |
| `discriminantBranchingBaseline` | `string[]` | `[]` | Grandfathered `path::discriminant` chains `exhaustive-discriminant-branching` excuses |

### Baselines: adopting the totality rules on an existing codebase

`switch-totality` applies to every TypeScript file in every project, so a
codebase with switches that predate it would block the next edit to each of
those files. Record them once:

```bash
bun <loom-plugin-dir>/scripts/lint-project.ts --write-baseline
```

This writes every unproven switch and if-chain into `switchTotalityBaseline` /
`discriminantBranchingBaseline`, keyed relative to the project root. A
baselined site costs nothing until it is converted; a new site must prove
totality. The list is debt, and it only shrinks: `lint-project` (full tier)
fails on any entry no live site consumes, so a converted switch's entry must
be deleted — re-running `--write-baseline` does it.

### BoundaryRule Structure

```typescript
{
  module: string;        // Path prefix that identifies the module (with trailing /), or one file
  description?: string;  // What the module is and which way its imports point
  allow: string[];       // Allowed import prefixes (relative "./" always works)
  deny: string[];        // Denied import prefixes (checked first)
  // Per-file capability beyond `allow`, each with the reason it was granted.
  // A boundary with no blanket "node:" allow refuses every node builtin in a
  // file it does not grant here.
  perFileAllow?: { [file: string]: { allow: string[]; reason: string } };      // prefix grants
  perFileExactAllow?: { [file: string]: { allow: string[]; reason: string } }; // exact specifiers
}
```

A grant must name one file under the boundary's `module`; a grant that could
never apply is refused.

### No Config = Built-in Defaults

If no `config.json` exists, every rule uses its built-in default.
`switch-totality`, `exhaustive-discriminant-branching`, `max-function-lines`
and the expression-shape rules apply to any project as-is. The boundary and
purity rules' defaults are empty — no boundaries, nothing pure — so they do
nothing until the project declares its architecture. Loom's own architecture is
declared the same way, in its `.claude/linter/rules/config.json`: nothing
Loom-specific is hard-coded in the rules.

---

## Built-in Rules Reference

### TypeScript Rules (Immediate Tier)

| Rule | Pattern | Enabled | What it catches |
|------|---------|---------|-----------------|
| `no-any-type` | `:\s*any\b` | ✅ | Explicit `: any` type annotations |
| `no-unsafe-as-any` | `\bas\s+any\b` | ✅ | `as any` casts, tests included |
| `no-non-null-assertion` | `x!` before `. [ ) , ; : ] }` | ✅ | Non-null and definite-assignment assertions in production code (test files exempt) |
| `no-catch-ignore` | `catch (e) {}`, `catch {}` | ✅ | Empty catch blocks (TS and JS) |
| `no-console-log` | `console\.log\(` | ✅ | `console.log()` calls |
| `no-todo-fixme` | `//\s*(TODO\|FIXME)` | ✅ | `// TODO` and `// FIXME` comments (TS and JS) |
| `no-alias-export` | `^export (const\|let) X = Y;` | ✅ | An export that only renames another symbol |

The TypeScript rules read every TypeScript spelling (`.ts .tsx .mts .cts`).

`no-non-null-assertion`, `no-unsafe-as-any` and `no-catch-ignore` enforce
architecture.md's "no silencing casts" and "no catch-all handlers": each one
asserts something the compiler or the caller would otherwise have had to prove.
`no-non-null-assertion` exempts test files — there a failed assumption throws
and fails the test, which is the assertion's purpose.

The rules that exempt tests (`no-non-null-assertion`, `no-console-log`,
`no-todo-fixme`) name one test-file list between them: `.test.` and `.spec.`
before every extension the rule reads — `ts tsx mts cts`, and for
`no-todo-fixme` also `js jsx mjs cjs`. A rule that reads `.mts` exempts
`.test.mts`, so a test file is never exempt from one rule and held to another.
`engine/tests/linter/regex-rules.test.ts` pins each rule's matching and
non-matching lines and that exemption list.

**"Use ts-pattern instead of switch" is `switch-totality`**, a programmatic rule
that also runs in this tier (below). The old regex rule `prefer-ts-pattern` is
deleted: it matched only `switch (`, so it missed the if-chain form, and it
fired on exhaustive switches whose `default` binds the scrutinee to `never` — a
totality proof, not a defect. A project that still carries its own
`prefer-ts-pattern.json` override keeps that regex as a project rule; delete it
in favour of `switch-totality`.

`no-alias-export` is the pattern that produced twelve dead aliases on one branch
(`parseCorpus = parseCalibrationCorpus` and siblings). It matters because `tsc`
**cannot** see a dead export — it assumes an external consumer — so an alias whose
callers all moved to the real name lives forever. Derived values like
`X.length` are not bare identifiers and do not match.

### Java Rules (Immediate Tier)

| Rule | Pattern | Enabled | What it catches |
|------|---------|---------|-----------------|
| `no-system-out` | `System\.(out\|err)\.(print\|println\|printf)\(` | ✅ | System.out/err print calls |
| `no-raw-exception-catch` | `catch\s*\(\s*(Exception\|Throwable)\s+` | ✅ | Catching raw Exception/Throwable |
| `no-null-return` | `return\s+null\s*;` | ✅ | Returning null (use Optional) |
| `no-field-injection` | `@(Autowired\|Inject)` on field | ✅ | Field injection (use constructor) |
| `no-mutable-entity-fields` | Non-final instance fields | ❌ | Mutable fields (opt-in) |
| `no-star-import` | `import\s+[\w.]+\.\*\s*;` | ✅ | Wildcard imports |

### Programmatic Rules

| Rule | Tier | Languages | What it enforces |
|------|------|-----------|-----------------|
| `no-cross-boundary-imports` | immediate + full | TS, JS, Java | Import direction between bounded contexts; under `requireGovernance`, every file belongs to one |
| `no-io-in-pure-modules` | immediate + full | TS, JS, Java | No filesystem/network/console/non-determinism in the functional core |
| `switch-totality` | immediate + full | TS | A switch with 2+ arms proves totality — `match(…).exhaustive()`, or a `default` arm binding the scrutinee to `never` |
| `max-function-lines` | full | TS, JS, Java | Function bodies ≤ configured max (default: 50 lines) |
| `fugue-generated-integrity` | full | TS | Structural projection of Fugue-generated files matches the stamped SHA-256 |
| `exhaustive-discriminant-branching` | full | TS | 3+ branches on one discriminant without a totality proof |
| `no-nested-ternary` | full | TS | A ternary whose else-branch opens another ternary |
| `prefer-array-methods` | full | TS | A mutable accumulator whose loop only pushes into it |

**These encode judgement, so read what they deliberately do NOT flag.**
A rule that fires on correct code teaches people the rule is wrong, and then it
gets disabled — which is worse than not having it.

- `switch-totality` applies to **every non-test TypeScript file** by default.
  Only the `default` arm can prove a switch — a `never` binding,
  `assertNever(x)`, or `default: return match(x)…exhaustive()`; an
  `.exhaustive()` inside a `case` arm proves that nested match, not the switch.
  `default: throw new Error("unreachable")` is **not** a proof: it compiles
  after a variant is added. Quoted literals (`case "a":`) and qualified members
  (`case Kind.Draft:`) are arms; one-arm switches are guards and exempt, as is
  `switch (typeof raw)`. An open domain (a plain `string`) has no `never` to
  bind — write `match(raw).with("a", …).otherwise(…)`, which makes the fallback
  a visible decision.
- `exhaustive-discriminant-branching` ignores one- and two-branch guard clauses.
  Guards are the *preferred* shape; only at three does an if-chain stop reading
  as a guard and start reading as a switch. It accepts either
  `match(…).exhaustive()` or a `never` binding as proof — it is about totality,
  not about which library you reach for. Chains must be contiguous
  (10-line max gap), so two unrelated guards on the same tag at opposite ends of
  a file are not merged into a phantom chain.
- `no-nested-ternary` exempts **type-level** conditionals. `S extends X ? A : …`
  is the only way to express a mapped relation in the type system — there is no
  `if` and no `match` there, so the chain is essential, not incidental.
- `prefer-array-methods` fires only on the narrow accumulator shape: an array
  declared immediately before a loop whose single statement pushes into it. Loops
  with `break`, `continue`, `return`, or `await` are exempt, as are
  multi-statement bodies — those are folds, and spelling a fold `reduce` is
  frequently *harder* to read. The bar is that a mechanical rewrite exists AND it
  deletes a mutable binding.

Both hook tiers are **touch-scoped** — PostToolUse lints the file you edited,
and the wave gate lints the wave's `files_modified` — so enabling a rule with
an existing backlog does not block unrelated edits. `scripts/lint-project.ts`
is not touch-scoped: it lints the whole project, and in Loom it runs as part of
`npm run verify` (engine `lint` script, full tier), so a backlog fails
verification until it is fixed or explicitly baselined.

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
- For project-specific rules: add to the project's rules directory, `.claude/linter/rules/` (`.pi/linter/rules/` only in a Pi-only project)

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

Programmatic rules run TypeScript handler functions that can perform deeper structural analysis than regex allows. Each declares its tier: the import-boundary rules and `switch-totality` run after every edit (`"immediate"`) and at the Wave Gate; the rest only at the Wave Gate (`"full"`).

### How They Work

Each programmatic rule is a function with signature:
```typescript
(content: string, filePath: string) => Violation[]
```

The rule receives the full file content and path, and returns any violations found. Rules are registered in `engine/src/linter/programmatic/index.ts`.

### Built-in Programmatic Rules

#### `no-cross-boundary-imports`

Parses import statements and checks against configured boundary rules. Prevents bounded contexts from depending on each other incorrectly.

Under `requireGovernance`, a file inside a governance root that no boundary's
`module` names is reported as an **ungoverned module** — a new directory must
state its dependency direction before it can hold code. Paths are made
project-relative against the project root (the directory above the rules
directory), so boundary prefixes match absolute paths exactly.

**Detects:**
- `engine/src/linter/` importing from `engine/src/core/` (wrong direction)
- `domain/` package importing from `infra/` (architecture violation)
- Any import matching a `deny` list entry

**Configure per-project:** Set `boundaries` in `config.json`.

#### `no-io-in-pure-modules`

Scans the functional core for I/O operations. A file is held to purity when it
is under a `pureModules` root (or named there), is not a test file, and is not
declared in `impureModules` — pure by default inside the roots, so a new core
file is checked the moment it exists. A banned global named inside a quoted
string or a trailing `//` comment is not flagged; code inside a template
literal still is.

**Detects:**
- Imports: `node:fs`, `node:net`, `node:http`, `node:child_process`
- Globals: `process.env`, `process.exit`, `console.log/error/warn`
- Non-determinism: `Math.random()`, `new Date()` (without argument), `fetch()`

**Allows:** `node:path`, `node:url` (side-effect free modules)

**Configure per-project:** Set `pureModules` (roots) and `impureModules` (shells, with reasons) in `config.json`.

#### `max-function-lines`

Uses bracket-depth tracking to detect functions exceeding a line limit.

**Detects:**
- `function` declarations
- Arrow functions with block bodies (`const x = () => { ... }`)
- Class methods

**Excludes:** Test files (`.test.ts`, `.spec.ts`) by default.

**Configure per-project:** Set `maxFunctionLines` and `excludeFromMaxLines` in `config.json`.

#### `fugue-generated-integrity`

Recognizes TypeScript generated by `fugue new --from` through its strict `@fugue-integrity sha256:<hex>` banner. It recomputes the hash over the generated structural projection while collapsing sanctioned `@fugue-body-start` / `@fugue-body-end` regions. Implementing a body is allowed; changing imports, schemas, node ids, wiring, or other generated structure blocks at the full tier.

A file with no marker is not Fugue-generated and is ignored. A malformed marker prefix, executable content above the banner, or a digest mismatch is a violation. See [`references/executable-models.md`](../references/executable-models.md).

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

### Cooperative Runtime Deadline

Even if a pattern passes static analysis, regex execution checks a **50ms per-file deadline** every 100 lines and after each regex rule. This bounds ordinary multi-line work and fails closed once control returns to a check.

This is cooperative, not a preemptive sandbox: JavaScript cannot interrupt one synchronous `RegExp.test()` that is already catastrophically backtracking, and programmatic handlers are checked before invocation but not preempted while running. Static rejection is therefore the primary defense against a single blocking match; custom programmatic rules are not supported from JSON. Do not describe the deadline as a guarantee that arbitrary regex or handler code cannot hang.

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
| `immediate` | After every edit (PostToolUse/tool_result) | Regex rules, plus the programmatic rules whose tier is `immediate` | 50ms cooperative per-file deadline |
| `full` | At Wave Gate boundaries or explicit scans | All rules (regex + programmatic) | Same checker; programmatic handlers are not preemptible |

The immediate tier runs after every file write to catch surface-level issues instantly. The full tier runs at natural pause points where deeper structural analysis is acceptable.

Type errors are not a lint tier: a separate, advisory post-edit check runs the project's incremental `tsc` and never blocks. See [Advisory type diagnostics](../docs/operations.md#advisory-type-diagnostics).

### Fail-Closed Guarantee

Any linter error (malformed rule, timeout, crash) **blocks the edit**. The linter never silently passes — if something goes wrong, the agent sees the error and can investigate.

---

## Quick Reference: Project Setup

### TypeScript project (minimal)

```
.claude/linter/
└── rules/
    ├── (override files if needed)
    └── config.json     ← optional: boundaries, purity, totality baselines
```

### Java/Spring Boot project

```
.claude/linter/
└── rules/
    ├── no-mutable-entity-fields.json  ← enable opt-in rule
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
