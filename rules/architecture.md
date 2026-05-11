---
description: Core architectural principles for all code - always apply
globs: "**/*.{ts,tsx,js,jsx,java,kt,hs,scala,rs}"
---

# Architecture Principles

Apply these principles to all code suggestions, reviews, and implementations.

## Core Philosophy

1. **Functional Programming Style** - prefer pure functions, avoid side effects
2. **Immutability First** - default to immutable data; mutability requires justification
3. **Domain-Driven Design** - model domain concepts explicitly, ubiquitous language
4. **Push I/O to Edges** - isolate side effects at system boundaries
5. **Functional Core, Imperative Shell** - pure business logic, thin I/O orchestration layer
6. **Parse, Don't Validate** - return validated data, not booleans; make invalid states unrepresentable

## Testability Requirements

- 90%+ of code should be unit testable without mocks
- Pass data as parameters, not injected services
- Property-based tests for business rules (jqwik for Java)
- Integration tests only for I/O boundaries

## Data Transformation Pattern

```
fetch data (I/O) -> transform (pure) -> persist (I/O)
```

Each step independently testable. Business logic lives in "transform".

## Type Design (Java 21+)

- **Records** for immutable value objects and DTOs
- **Sealed types** for exhaustive domain modeling
- **Pattern matching** for type-safe branching
- Validate invariants in constructors

## Type Design (TypeScript)

- Discriminated unions for domain states
- `readonly` by default
- Derive types from source of truth (Zod schemas, DB types)
- Avoid `any` and type assertions
- **Use ts-pattern** for exhaustive pattern matching on discriminated unions

## Error Handling Strategy

**Functional Core (pure functions):**
- Business logic errors → return `Either<Error, T>`, never throw
- Constructor invariants → may throw (guards type's validity)
- Enables composition, explicit control flow, trivial testing

**Imperative Shell (I/O orchestration):**
- Infrastructure failures (DB, network) → may throw at boundary
- Converts `Either.left` → thrown exception / error response as needed
- Single place for exception-to-response mapping

## Ports at I/O Boundaries

Define a narrow port (interface / trait / type alias) owned by your domain for every real I/O collaborator. The shell depends on the port; adapters implement it. This is *not* "code to an interface everywhere" — it applies only at the edges of the system.

**Two outcomes the port must earn:**
1. The functional core (and the shell types) never import a vendor SDK directly.
2. Tests substitute behavior with a plain fake — no mocking framework, no partial mocks.

If a candidate seam delivers neither, skip the port and call the concrete thing.

**Apply to (real I/O boundaries):**
- Repository / persistence (Postgres, Mongo, in-memory)
- Cache (Redis, in-memory map, no-op)
- Clock (`now()`, advanceable test clock)
- ID / UUID generator (random vs seeded)
- Outbound HTTP client to a named external API
- Email / SMS / push notification sender
- Object storage (S3, local FS, in-memory map)
- Message publisher / event bus (Kafka, SQS, in-memory queue)
- Feature-flag provider (LaunchDarkly, static map)
- Secret resolver (Vault, env, fixture)
- Random source (RNG, seeded RNG)
- Audit / metrics / telemetry sink

**Do NOT port-ify:**
- Pure domain functions — just import and call them
- Value-object constructors / smart constructors
- Internal orchestrators or use-cases inside the shell
- Vendor abstractions you'd wrap *just* to add a layer (double indirection)
- Seams used in only one place with no test-double need

**Shape of a port:**
- Narrow: only the methods this consumer actually uses (one port per capability, not per vendor)
- Domain-typed: takes/returns your types, not vendor types (`Order`, not `RedisHash`)
- Stable: the port belongs to the consumer; the adapter adapts the vendor to it, never the reverse
- Real fake: every port ships with an in-memory implementation used by the core's tests

See `java-patterns.md`, `typescript-patterns.md`, `rust-patterns.md` for language-specific shapes.

## Anti-Patterns to Flag

- Business logic mixed with I/O
- Vendor SDK types leaking into the functional core or domain signatures
- Ports that mirror a vendor API instead of the consumer's needs (wide / leaky ports)
- Ports introduced "for future swappability" with no second adapter or test fake
- Services with 5+ dependencies
- Mutable shared state
- Catch-all exception handlers
- Mock-heavy tests (indicates missing port or wrong port shape)

## When to Invoke `/architecture-tech-lead`

- New feature needing architectural validation
- Refactoring for testability
- Complex/hard-to-test code review
- Designing for maximum test coverage
