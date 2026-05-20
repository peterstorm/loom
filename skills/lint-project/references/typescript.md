# TypeScript / JavaScript Lint Setup

## Boundary Rules

TypeScript projects use relative imports (`./`, `../`) and package imports. The boundary checker resolves relative imports against the file's directory to produce repo-relative paths, then matches against `deny`/`allow` lists.

### Monorepo Pattern (packages/)

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

Paths that must be side-effect free. The checker detects:

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

### Example pureModules config

```json
{
  "pureModules": [
    "src/domain/",
    "src/types/",
    "packages/framework/src/types/",
    "packages/framework/src/shared/validate.ts",
    "packages/framework/src/shared/topo.ts"
  ]
}
```

Use directory paths (trailing `/`) for entire directories, or exact file paths for individual files.

## Regex Rules — TypeScript

### Recommended project rules

**no-unsafe-as-any.json** — Block `as any` type escape hatches:
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
| `no-console-log` | `console.log(` | Console.log calls |
| `no-todo-fixme` | `// TODO\|FIXME` | Unresolved TODOs |

### Rules to consider enabling

**prefer-ts-pattern** (disabled by default) — flags `switch()` statements. Enable for projects using ts-pattern for discriminated union matching:
```json
{
  "kind": "regex",
  "name": "prefer-ts-pattern",
  "description": "Prefer ts-pattern match().exhaustive() over switch for discriminated unions",
  "extensions": [".ts", ".tsx"],
  "pattern": "switch\\s*\\(",
  "flags": "",
  "fixHint": "Use match(value).with(...).exhaustive() from ts-pattern instead of switch",
  "enabled": true,
  "excludePatterns": [".test.ts"]
}
```

## Function Length

```json
{
  "maxFunctionLines": 50,
  "excludeFromMaxLines": [".test.ts", ".spec.ts", ".property.test.ts"]
}
```

Functions exceeding this limit trigger `max-function-lines`. Test files are excluded since `describe` blocks are naturally long.
