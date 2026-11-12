# TypeScript / JavaScript Lint Setup

## Boundary Rules

TypeScript projects use relative imports (`./`, `../`) and package imports. The boundary checker resolves relative imports against the file's directory to produce repo-relative paths, then matches against `deny`/`allow` lists.

### Monorepo Pattern (packages/)

<!-- wire-example: linter-project-config -->
```json
{
  "boundaries": [
    {
      "module": "packages/core/src/types/",
      "allow": ["./", "packages/core/src/types/", "zod"],
      "deny": [
        "packages/core/src/infra/",
        "packages/core/src/api/",
        "packages/core/src/shared/",
        "@opentelemetry/",
        "bullmq",
        "ioredis"
      ]
    },
    {
      "module": "packages/core/src/shared/",
      "allow": ["./", "packages/core/src/shared/", "packages/core/src/types/"],
      "deny": [
        "packages/core/src/infra/",
        "packages/core/src/api/",
        "@opentelemetry/",
        "bullmq",
        "ioredis"
      ]
    },
    {
      "module": "packages/core/src/infra/",
      "allow": ["./", "packages/core/src/infra/", "packages/core/src/types/", "ioredis", "bullmq"],
      "deny": ["packages/core/src/api/"]
    }
  ]
}
```

### Flat src/ Pattern

<!-- wire-example: linter-project-config -->
```json
{
  "boundaries": [
    {
      "module": "src/domain/",
      "allow": ["./", "src/domain/"],
      "deny": ["src/infra/", "src/api/", "src/adapters/", "@prisma", "ioredis"]
    },
    {
      "module": "src/infra/",
      "allow": ["./", "src/infra/", "src/domain/"],
      "deny": ["src/api/"]
    }
  ]
}
```

### Next.js App Router Pattern

<!-- wire-example: linter-project-config -->
```json
{
  "boundaries": [
    {
      "module": "src/lib/domain/",
      "allow": ["./", "src/lib/domain/", "zod"],
      "deny": ["src/lib/infra/", "src/app/", "next/", "@prisma"]
    },
    {
      "module": "src/lib/infra/",
      "allow": ["./", "src/lib/infra/", "src/lib/domain/", "@prisma", "ioredis"],
      "deny": ["src/app/"]
    }
  ]
}
```

## Pure Modules

The functional core is **pure by default inside its roots**: list the core's
directories (and any single pure files elsewhere) in `pureModules`; every
non-test file beneath a root is then held to purity — including files added
later. The imperative shells that genuinely live inside a root are declared in
`impureModules`, each with the I/O it does. A shell named there is a design
decision on the record; I/O that crept into a core module is a defect to move
out, not an entry to add. The shipped default holds nothing pure: a project
with no `pureModules` gets no purity checking at all.

The checker detects:

| Banned Import | Why |
|---------------|-----|
| `node:fs`, `fs` | Filesystem I/O |
| `node:net`, `node:http`, `node:https` | Network I/O |
| `node:child_process` | Process spawning |
| `node:dgram`, `node:dns`, `node:tls` | Network I/O |

| Banned Global | Why |
|---------------|-----|
| `process.env` | Environment I/O |
| `process.exit` | Control flow side effect |
| `fetch()` | Network I/O |
| `console.log/error/warn/info/debug` | Output I/O |
| `Math.random()` | Non-determinism |
| `new Date()` (no argument) | Non-determinism |
| `performance.now()` | Non-determinism |

**Allowed even in pure modules:** `node:path`, `node:url` (side-effect free)

### Example purity config

<!-- wire-example: linter-project-config -->
```json
{
  "pureModules": [
    "src/domain/",
    "src/types/",
    "packages/framework/src/types/",
    "packages/framework/src/shared/validate.ts"
  ],
  "impureModules": [
    { "path": "src/domain/order-repository.ts", "reason": "reads and writes orders through the database pool" }
  ]
}
```

Use directory paths (trailing `/`) for entire directories, or exact file paths for individual files. Globs are refused.
A banned global named inside a quoted string or a trailing `//` comment is not flagged; code inside a template literal is.

## Regex Rules — TypeScript

### Shipped as defaults

`no-unsafe-as-any`, `no-non-null-assertion` and `no-catch-ignore` ship in loom's
`lint-rules/` and fire in every project — no project file needed (disable one by
name if a project must). The versions below are the original templates; the
shipped rules widen them: `no-non-null-assertion` matches `x!.`, `x![`, `f()!.`,
`a[0]!`, `x!)` and `let x!:` (production code only — test files are exempt),
`no-unsafe-as-any` applies to tests too, and `no-catch-ignore` also matches the
binding-less `catch {}` in TypeScript and JavaScript.

**no-unsafe-as-any.json** — Block `as any` type escape hatches:
<!-- wire-example: linter-regex-rule -->
```json
{
  "kind": "regex",
  "name": "no-unsafe-as-any",
  "description": "Disallow 'as any' casts — use proper type narrowing",
  "extensions": [".ts", ".tsx"],
  "pattern": "\\bas\\s+any\\b",
  "flags": "",
  "fixHint": "Replace 'as any' with proper type narrowing, a generic constraint, or 'as unknown as SpecificType' with a comment explaining why the cast is sound",
  "enabled": true,
  "excludePatterns": [".test.ts", ".spec.ts"]
}
```

**no-non-null-assertion.json** — Block `!.` operator:
<!-- wire-example: linter-regex-rule -->
```json
{
  "kind": "regex",
  "name": "no-non-null-assertion",
  "description": "Disallow non-null assertions (!) — use explicit guards",
  "extensions": [".ts", ".tsx"],
  "pattern": "\\w+!\\.\\w",
  "flags": "",
  "fixHint": "Replace the non-null assertion with an explicit null check or Result pattern",
  "enabled": true,
  "excludePatterns": [".test.ts", ".spec.ts"]
}
```

**no-catch-ignore.json** — Block empty catch blocks:
<!-- wire-example: linter-regex-rule -->
```json
{
  "kind": "regex",
  "name": "no-catch-ignore",
  "description": "Disallow empty catch blocks that silently swallow errors",
  "extensions": [".ts", ".tsx"],
  "pattern": "catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}",
  "flags": "",
  "fixHint": "Handle the error: log it, return err(...), or re-throw. Add a comment if intentionally empty.",
  "enabled": true
}
```

### Default rules (already active)

These fire automatically from loom's default rules — no project config needed:

| Rule | Pattern | What it catches |
|------|---------|-----------------|
| `no-any-type` | `: any` | Explicit any type annotations |
| `no-unsafe-as-any` | `as any` | Casts that switch the checker off |
| `no-non-null-assertion` | `x!` | Non-null assertions in production code |
| `no-catch-ignore` | `catch {}` | Empty catch blocks |
| `no-console-log` | `console.log(` | Console.log calls |
| `no-todo-fixme` | `// TODO\|FIXME` | Unresolved TODOs |

### Totality: ts-pattern instead of switch (already active)

`switch-totality` runs after every edit on every non-test TypeScript file — no
config needed. A switch with two or more arms must prove it is total:
`match(x).with(…).exhaustive()`, or a `default` arm that binds the scrutinee
to `never` (`const _: never = x`, `assertNever(x)`). For an open domain such as
a plain `string`, use `match(raw).with("a", …).otherwise(…)`.
`exhaustive-discriminant-branching` catches the same omission written as a 3+
branch if/else chain, at the Wave Gate.

On an existing codebase, grandfather the switches and chains that predate the
rule before the first agent edits them:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts --write-baseline
```

To narrow the rule to the modules that own your unions, set
`switchTotalityModules` (non-empty) in `config.json`. The old opt-in
`prefer-ts-pattern` regex rule is gone; delete a project copy of it.

### Wire values: parse, never cast (already active)

`no-wire-cast` runs after every edit on every non-test TypeScript file — no
config needed. `JSON.parse(text)` and `response.json()` return `any`; the rule
refuses giving that value a type without parsing it:

```typescript
const order = JSON.parse(text) as Order;              // refused
const order = (await response.json()) as Order;       // refused
const order = JSON.parse(text) as unknown as Order;   // refused
const order: Order = JSON.parse(text);                // refused
let order: Order; order = JSON.parse(text);           // refused

const raw: unknown = JSON.parse(text);                // accepted
const order = parseOrder(raw);                        // the parser returns Order or an error
const order = parseOrder(JSON.parse(text));           // accepted: argument position
```

It reads text, not types: an unannotated `const value = JSON.parse(text)`, a
`return JSON.parse(text)` under a declared return type and a property read
(`JSON.parse(text).id`) are not flagged — the `any` there is the type
checker's to catch. On an existing codebase, `--write-baseline` (above) records
the sites that predate the rule in `wireCastBaseline`.

## Function Length

<!-- wire-example: linter-project-config -->
```json
{
  "maxFunctionLines": 50,
  "excludeFromMaxLines": [".test.ts", ".spec.ts", ".property.test.ts"]
}
```

Functions exceeding this limit trigger `max-function-lines`. Test files are excluded since `describe` blocks are naturally long.
