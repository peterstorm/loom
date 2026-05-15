---
description: Core architectural principles for all code - always apply
globs: "**/*.{ts,tsx,js,jsx,java,kt,hs,scala,rs}"
---

# Architecture Principles

Apply these principles to all code suggestions, reviews, and implementations.

## Core Philosophy

1. **Functional Programming Style** - prefer pure functions, avoid side effects
2. **Immutability First** - default to immutable data; mutability requires justification
3. **Domain-Driven Design** - model domain concepts explicitly, ubiquitous language, aggregates, bounded contexts
4. **Push I/O to Edges** - isolate side effects at system boundaries
5. **Functional Core, Imperative Shell** - pure business logic, thin I/O orchestration layer
6. **Parse, Don't Validate** - return validated data, not booleans; make invalid states unrepresentable

## Domain-Driven Design

DDD is not optional decoration — it's how we structure code to match the problem space.

### Ubiquitous Language

- Every domain concept gets ONE name, used everywhere: code, tests, docs, conversations
- If a `CONTEXT.md` exists, it is the source of truth for terminology
- When code uses a different word than the domain expert would, rename the code
- Avoid generic names (`Manager`, `Service`, `Handler`, `Processor`) for domain concepts — use the domain's actual nouns

### Value Objects

Immutable types defined entirely by their attributes. No identity — two value objects with the same attributes are equal.

**Rules:**
- Validate invariants in the constructor — invalid states are unrepresentable
- No setters; produce new instances via transformation methods
- Equality by value, not reference
- Use for: money, dates, addresses, email, IDs, measurements, enumerations with behavior

```java
// Java: record with validation
public record Money(BigDecimal amount, Currency currency) {
  public Money {
    if (amount.scale() > currency.getDefaultFractionDigits())
      throw new IllegalArgumentException("Scale exceeds currency precision");
  }
  public Money add(Money other) {
    if (!currency.equals(other.currency)) throw new IllegalArgumentException("Currency mismatch");
    return new Money(amount.add(other.amount), currency);
  }
}
```

```typescript
// TypeScript: branded type with smart constructor
type Email = string & { readonly __brand: 'Email' };

function Email(raw: string): Either<ValidationError, Email> {
  return /^[^@]+@[^@]+\.[^@]+$/.test(raw)
    ? right(raw as Email)
    : left(new ValidationError(`Invalid email: ${raw}`));
}
```

### Entities

Objects with identity that persists across state changes. Two entities with the same attributes but different IDs are different.

**Rules:**
- Identity is assigned at creation and never changes
- Equality by ID only
- Mutable state (if any) is encapsulated — changes go through methods that enforce invariants
- Keep entities small — push behavior into value objects where possible

### Aggregates

A cluster of entities and value objects treated as a single unit for data changes. Has a root entity that is the only entry point.

**Rules:**
- External objects reference the aggregate only through the root
- The root enforces all invariants for the cluster
- Transactions don't span aggregates — one aggregate per transaction
- Reference other aggregates by ID, never by object
- Keep aggregates small — only group things that MUST be consistent together
- When in doubt, make it smaller (split, don't merge)

**Sizing heuristic:** If two things can be independently updated by different users without conflict, they're separate aggregates.

```java
// Order is the aggregate root — LineItems can't be accessed directly
public final class Order {
  private final OrderId id;
  private final List<LineItem> items; // internal; not exposed as mutable
  private OrderStatus status;

  public Either<OrderError, Order> addItem(Product product, Quantity qty) {
    if (status != OrderStatus.DRAFT)
      return left(new OrderError.NotModifiable(id, status));
    // invariant: no duplicate products
    if (items.stream().anyMatch(li -> li.product().equals(product)))
      return left(new OrderError.DuplicateProduct(product.id()));
    return right(new Order(id, append(items, new LineItem(product, qty)), status));
  }
}
```

### Domain Events

Record that something meaningful happened in the domain. Past tense. Immutable.

**Rules:**
- Named in past tense using domain language: `OrderPlaced`, `PaymentFailed`, `ShipmentDispatched`
- Immutable — they are facts that happened; never modified after creation
- Contain all data needed to understand what happened (no lazy loading)
- Published by the aggregate that owns the state change
- Consumed by other aggregates or bounded contexts to react
- Use for cross-aggregate and cross-context communication (not synchronous method calls)

```java
public record OrderPlaced(
  OrderId orderId,
  CustomerId customerId,
  List<LineItemSnapshot> items,
  Money total,
  Instant occurredAt
) implements DomainEvent {}
```

### Bounded Contexts

Explicit boundaries within which a domain model is consistent and terms have precise meaning.

**Rules:**
- Each context owns its own ubiquitous language (same word can mean different things in different contexts)
- Contexts communicate through published interfaces — not shared databases or internal types
- Types at context boundaries are translated (anti-corruption layer), not shared directly
- One team owns one context — shared ownership leads to coupled models
- When the same word means different things to different parts of the system, that's a context boundary

**Context relationships:**

| Pattern | When to Use |
|---------|-------------|
| **Published Language** | Upstream defines a stable schema (OpenAPI, events) for consumers |
| **Anti-Corruption Layer** | Downstream translates upstream's model into its own terms |
| **Shared Kernel** | Two contexts co-own a small set of types (use sparingly — tight coupling) |
| **Conformist** | Downstream accepts upstream's model as-is (OK for trivial integrations) |

### Repositories

Collection-like interface for retrieving and persisting aggregates. One repository per aggregate root.

**Rules:**
- Return whole aggregates, not fragments
- Interface defined in the domain (a port); implementation is infrastructure
- Methods use domain types: `findByOrderId(OrderId)`, not `findById(String)`
- No query logic leaking into the domain — complex queries go in read-model projections
- In-memory fake for tests; real implementation for production

### Domain Services

Stateless operations that don't belong to any single entity or value object. Use sparingly.

**Rules:**
- Named using domain verbs: `TransferMoney`, `CalculateShipping`, not `MoneyService`
- Stateless — no fields, all data comes through parameters
- Lives in the functional core if it has no I/O
- Lives in the imperative shell if it orchestrates I/O (but then it's really a use-case, not a domain service)
- If you're creating a service because you don't know where to put logic, reconsider — it usually belongs on an entity or value object

### Strategic Design Checklist

When modeling a new feature:

1. **Identify the bounded context** — does this belong to an existing context or need a new one?
2. **Define the ubiquitous language** — what terms does the domain expert use? Capture in `CONTEXT.md`.
3. **Find the aggregates** — what are the consistency boundaries? What must change together atomically?
4. **Keep aggregates small** — only group what must be transactionally consistent
5. **Identify value objects** — what has no identity? Make these the building blocks.
6. **Define domain events** — what state changes do other contexts need to know about?
7. **Map context relationships** — how does this context talk to others? ACL? Published language? Shared kernel?
8. **Place I/O at edges** — repositories and adapters implement ports; the domain is pure.

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

**Architecture:**
- Business logic mixed with I/O
- Vendor SDK types leaking into the functional core or domain signatures
- Ports that mirror a vendor API instead of the consumer's needs (wide / leaky ports)
- Ports introduced "for future swappability" with no second adapter or test fake
- Services with 5+ dependencies
- Mutable shared state
- Catch-all exception handlers
- Mock-heavy tests (indicates missing port or wrong port shape)

**DDD:**
- Anemic domain models (entities with only getters/setters, all logic in services)
- God aggregates (aggregate that grows to encompass everything — split it)
- Cross-aggregate object references (use IDs, not object refs)
- Transactions spanning multiple aggregates (redesign the boundary)
- Shared database tables between bounded contexts (each context owns its storage)
- Domain types named after technical concepts (`UserDTO`, `OrderEntity`) instead of domain language
- Missing ubiquitous language (team uses different words for the same concept)
- `Service` or `Manager` suffix on what should be a domain concept with real behavior

## When to Invoke `/architecture-tech-lead`

- New feature needing architectural validation
- Refactoring for testability
- Complex/hard-to-test code review
- Designing for maximum test coverage
