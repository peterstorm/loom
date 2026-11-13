# TypeScript / JavaScript Lint Setup

Boundary and purity templates. The config fields, the rule schema and every shipped rule are in `${CLAUDE_PLUGIN_ROOT}/lint-rules/README.md`.

## Boundary Rules

The boundary checker resolves a relative import (`./`, `../`) against the importing file to a project-relative path, and leaves a package import as written. It then matches the result against the boundary whose `module` holds the file: `deny` first, then `allow`. `allow` is a closed list, so name every package the layer may import.

The layers follow `rules/typescript-patterns.md` → "Package Structure": `domain/` imports nothing outward, `orchestrator/` imports `domain/` only, `infra/` implements the domain's ports, `api/` (or `app/`) calls orchestrators and never `infra/`.

### Flat `src/`

<!-- wire-example: linter-project-config -->
```json
{
  "requireGovernance": ["src/"],
  "boundaries": [
    {
      "module": "src/domain/",
      "description": "Functional core: imports itself only",
      "allow": ["./", "src/domain/", "zod", "ts-pattern"],
      "deny": ["src/orchestrator/", "src/infra/", "src/api/", "src/config/"]
    },
    {
      "module": "src/orchestrator/",
      "description": "Shell orchestrators: domain logic and ports, never adapters",
      "allow": ["./", "src/orchestrator/", "src/domain/"],
      "deny": ["src/infra/", "src/api/"]
    },
    {
      "module": "src/infra/",
      "description": "Adapters: implement the domain's ports with vendor SDKs",
      "allow": ["./", "src/infra/", "src/domain/", "node:", "pg", "ioredis"],
      "deny": ["src/orchestrator/", "src/api/"]
    },
    {
      "module": "src/api/",
      "description": "Entry points: parse, call an orchestrator, format",
      "allow": ["./", "src/api/", "src/domain/", "src/orchestrator/", "express"],
      "deny": ["src/infra/"]
    },
    {
      "module": "src/config/",
      "description": "Composition root: wires adapters into orchestrators",
      "allow": ["./", "src/", "node:"],
      "deny": []
    }
  ]
}
```

### Monorepo (`packages/`)

The same layers, with the full path from the repository root as each `module` and each prefix:

<!-- wire-example: linter-project-config -->
```json
{
  "boundaries": [
    {
      "module": "packages/core/src/domain/",
      "allow": ["./", "packages/core/src/domain/", "zod"],
      "deny": ["packages/core/src/infra/", "packages/core/src/api/", "@opentelemetry/", "bullmq", "ioredis"]
    },
    {
      "module": "packages/core/src/infra/",
      "allow": ["./", "packages/core/src/infra/", "packages/core/src/domain/", "node:", "ioredis", "bullmq"],
      "deny": ["packages/core/src/api/"]
    }
  ]
}
```

### Next.js App Router

`app/` is the outermost shell; the core and the adapters live under `src/lib/`:

<!-- wire-example: linter-project-config -->
```json
{
  "boundaries": [
    {
      "module": "src/lib/domain/",
      "allow": ["./", "src/lib/domain/", "zod"],
      "deny": ["src/lib/orchestrator/", "src/lib/infra/", "src/app/", "next/", "@prisma"]
    },
    {
      "module": "src/lib/orchestrator/",
      "allow": ["./", "src/lib/orchestrator/", "src/lib/domain/", "next/cache"],
      "deny": ["src/lib/infra/", "src/app/"]
    },
    {
      "module": "src/lib/infra/",
      "allow": ["./", "src/lib/infra/", "src/lib/domain/", "node:", "@prisma", "ioredis"],
      "deny": ["src/app/"]
    }
  ]
}
```

## Pure Modules

The functional core is pure by default inside its roots. List the core's directories, and any single pure files elsewhere, in `pureModules`; every non-test file beneath a root is then held to purity, including files added later. A shell that genuinely lives inside a root is declared in `impureModules` with the I/O it does. That entry is a design decision on the record; I/O that crept into a core module is a defect to move out, not an entry to add.

<!-- wire-example: linter-project-config -->
```json
{
  "pureModules": ["src/domain/", "packages/framework/src/shared/validate.ts"],
  "impureModules": [
    { "path": "src/domain/order-repository.ts", "reason": "reads and writes orders through the database pool" }
  ]
}
```

A trailing `/` names a directory; otherwise the entry is one file. Globs are refused. What a pure module may not import or call is listed in the README under `no-io-in-pure-modules`.

## Rules That Need No Configuration

These fire in every TypeScript project; the README says what each one does and does not flag.

- Regex rules: `no-any-type`, `no-unsafe-as-any`, `no-non-null-assertion`, `no-catch-ignore`, `no-console-log`, `no-todo-fixme`, `no-alias-export`.
- `switch-totality`: a switch with two or more arms is `match(x)…exhaustive()` or ends with `default: return assertNever(x)`. Narrow it to the modules that own your unions with `switchTotalityModules`.
- `no-wire-cast`: `JSON.parse` / `.json()` output is bound as `unknown` and parsed, never given a type by `as T` or an annotation.
- `no-duplicate-block`, and at the Wave Gate `exhaustive-discriminant-branching`, `max-function-lines`, `no-nested-ternary`, `prefer-array-methods`.

On an existing codebase, run `lint-project --write-baseline` once so the sites that predate these rules do not block the next edit to their files.
