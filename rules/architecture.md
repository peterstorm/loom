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

## Anti-Patterns to Flag

- Business logic mixed with I/O
- Services with 5+ dependencies
- Mutable shared state
- Catch-all exception handlers
- Mock-heavy tests (indicates poor architecture)

## When to Invoke `/architecture-tech-lead`

- New feature needing architectural validation
- Refactoring for testability
- Complex/hard-to-test code review
- Designing for maximum test coverage
