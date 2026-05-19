# ADR-0001: Linter as Module within Engine

## Status
Accepted

## Context
The loom project needs a PostEdit linter that catches bad code patterns immediately after file edits. The linter requires access to several engine-provided services: CLI routing (`cli.ts`), configuration (`config.ts`), shared type definitions (`types.ts`), state management (`state-manager.ts`), and hook handler infrastructure (`handlers/`). It also shares the bun runtime, build tooling, and test harness with the rest of the engine.

The question is where this linter code should live. The engine already follows a modular directory structure with sibling modules (`core/`, `parsers/`, `handlers/`, `utils/`), each representing a distinct bounded context with its own types and responsibilities. The linter is consumed by two adapters — a Claude Code PostToolUse hook and a Pi extension — both of which already import from `engine/src/`.

The project has a single consumer (the loom orchestration system), no external API stability requirements, and no need for independent versioning or publishing.

## Options Considered

1. **Module within Engine (`engine/src/linter/`)**
   - Pros: Shares bun runtime and build tooling; direct access to `config.ts`, `types.ts` without cross-package dependencies; single `bun test` command covers all modules; no npm publish/versioning overhead; follows established engine directory convention (`core/`, `parsers/`, `handlers/`)
   - Cons: Linter grows within a single package (no enforced boundary beyond directory convention); engine package size increases

2. **Standalone npm package (e.g., `@loom/linter`)**
   - Pros: Hard module boundary enforced by package resolution; independently versionable; could theoretically be reused by other tools
   - Cons: Unnecessary deployment complexity for a single consumer; creates circular dependency risk (linter needs engine types, engine needs linter for handlers); requires separate `package.json`, build step, workspace config, publish pipeline; no external consumers exist or are planned

3. **Flat files in `engine/src/core/`**
   - Pros: No new directory; simplest initial change
   - Cons: Violates cohesion — linter is a distinct bounded context with its own domain types (rules, violations, tiers, lint results) unrelated to orchestration; pollutes the core module's responsibility; makes it harder to reason about what `core/` owns

4. **Separate repository**
   - Pros: Complete isolation; independent CI
   - Cons: Splits testing across repos; complicates CI (cross-repo integration tests); adds import complexity and version pinning; makes atomic changes across linter + engine impossible; massive overhead for a tightly-coupled internal module

## Decision
**The linter lives as `engine/src/linter/` — a sub-module within the existing engine package.**

The module is structured as a sibling to `engine/src/core/`, `engine/src/parsers/`, and `engine/src/handlers/`. It owns its internal directory tree:

```
engine/src/linter/
├── types.ts          # Domain types: Rule, Violation, LintResult, LintOutput
├── safety.ts         # ReDoS static analysis + runtime timeout
├── loader.ts         # Rule loading, JSON parsing, merge semantics
├── executor.ts       # Rule execution, line-by-line regex matching
├── formatter.ts      # Violation formatting: JSON + block messages
└── index.ts          # Public API: lintFile orchestrator
```

Key invariants:
- The linter imports from engine's shared modules (`config.ts`, `types.ts`) but engine core modules do NOT import from linter — dependency flows one direction only.
- Handler modules (`handlers/`) import linter's public API via `../linter/index.ts` to wire it into PostToolUse hooks.
- The linter follows engine's architectural patterns: functional core / imperative shell, immutable data, discriminated unions for results, `Either`-style error handling.

## Consequences

**Positive:**
- Zero overhead for dependency management, publishing, or cross-package version coordination
- Single `bun test` invocation exercises linter alongside all other engine modules
- Direct access to shared types eliminates interface duplication or adapter layers
- Consistent architectural patterns (FC/IS, immutability) are naturally enforced by proximity and shared tooling
- Atomic commits can span linter + handler + CLI changes without cross-repo coordination

**Negative:**
- Module boundary is a convention (directory structure), not an enforced package boundary — discipline required to avoid inappropriate coupling
- Engine package grows in scope; a future reader must understand that `engine/` contains multiple bounded contexts
- If the linter ever needs independent consumers (unlikely given project scope), extraction to a package would require refactoring imports
