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

We practice **functional DDD**: the strategic patterns (bounded contexts, ubiquitous language, context mapping) are applied as-is from Evans. The tactical patterns (aggregates, entities, value objects) are adapted to work with the functional core / imperative shell split — aggregates are immutable data + pure functions, not mutable OOP objects.

### How DDD Maps to Functional Core / Imperative Shell

| DDD Concept | Where It Lives | Why |
|-------------|---------------|-----|
| Value Objects | Functional core | Pure data, validated at construction, no I/O |
| Entities (as data) | Functional core | Immutable records identified by ID |
| Aggregate invariants | Functional core | Pure functions: `(Aggregate, Command) → Either<Error, Aggregate>` |
| Domain Events | Functional core | Immutable records returned alongside state changes |
| Domain Services | Functional core | Pure functions that operate across aggregates — no I/O |
| Repositories (port) | Port definition in core, implementation in shell | Interface is domain-typed; impl is I/O |
| Use Cases / Shell Orchestrators | Imperative shell | Orchestrate: load via port → call pure core → persist via port |
| Anti-Corruption Layers | Imperative shell | Translation between contexts is I/O-adjacent |

The key insight: traditional DDD puts behavior *on* mutable aggregate objects (`order.addItem()`). Functional DDD extracts that behavior into pure functions that take the aggregate as input and return a new aggregate (or an error). The aggregate itself is just data.

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
- Value objects are the primary building blocks of the functional core

```java
// Java: record — immutable by construction, invariants in compact constructor
public record Money(BigDecimal amount, Currency currency) {
  public Money {
    if (amount.scale() > currency.getDefaultFractionDigits())
      throw new IllegalArgumentException("Scale exceeds currency precision");
  }
  // Pure transformation — returns new Money, no mutation
  public Money add(Money other) {
    if (!currency.equals(other.currency)) throw new IllegalArgumentException("Currency mismatch");
    return new Money(amount.add(other.amount), currency);
  }
}
```

```typescript
// TypeScript: branded type with smart constructor returning Either
type Email = string & { readonly __brand: 'Email' };

function Email(raw: string): Either<ValidationError, Email> {
  return /^[^@]+@[^@]+\.[^@]+$/.test(raw)
    ? right(raw as Email)
    : left(new ValidationError(`Invalid email: ${raw}`));
}
```

### Entities

Domain objects with identity that persists across state changes. Two entities with the same attributes but different IDs are different.

**In functional DDD, entities are immutable data records** — not mutable objects. "State change" means producing a new instance with updated fields. The entity type carries the identity; pure functions produce new versions.

**Rules:**
- Identity is assigned at creation and never changes
- Equality by ID only
- Represented as immutable records/types (Java records, TS readonly types, Rust structs)
- State transitions are pure functions returning new instances — never mutate in place
- Keep entities small — push behavior into value objects where possible

```java
// Entity as immutable record — identity is OrderId
public record Order(
  OrderId id,
  CustomerId customer,
  List<OrderLine> lines,
  OrderStatus status,
  Instant createdAt
) {
  public Order {
    lines = List.copyOf(lines); // defensive immutable copy
  }
}

// State transition is a pure function, not a method that mutates
// See Aggregates section below for the full pattern
```

### Aggregates

A cluster of entities and value objects treated as a single unit for consistency. Has a root entity that is the sole external entry point.

**In functional DDD, an aggregate is immutable data + pure command functions.** The traditional `aggregate.doThing()` becomes `doThing(aggregate, command) → Either<Error, AggregateWithEvents>`. This keeps all business logic in the functional core.

**Rules:**
- External code references the aggregate only through its root ID
- All invariants are enforced by pure functions that produce new aggregate instances
- Transactions don't span aggregates — one aggregate per transaction
- Reference other aggregates by ID, never by object
- Keep aggregates small — only group things that MUST be consistent together
- When in doubt, make it smaller (split, don't merge)
- Command functions return `Either<Error, Aggregate>` (or a pair of `Aggregate + List<DomainEvent>`)

**Sizing heuristic:** If two things can be independently updated by different users without conflict, they're separate aggregates.

```java
// Aggregate root is an immutable record
public record Order(
  OrderId id,
  CustomerId customer,
  List<OrderLine> lines,
  OrderStatus status
) {
  public Order {
    lines = List.copyOf(lines);
  }
}

// Command functions are pure — in a dedicated module, not methods on the record.
// Takes aggregate + command data → returns Either<Error, NewAggregate>
public final class OrderCommands {
  private OrderCommands() {} // namespace, not an object

  public static Either<OrderError, Order> addItem(Order order, ProductId product, Quantity qty) {
    if (order.status() != OrderStatus.DRAFT)
      return left(new OrderError.NotModifiable(order.id(), order.status()));
    if (order.lines().stream().anyMatch(li -> li.productId().equals(product)))
      return left(new OrderError.DuplicateProduct(product));
    var newLines = append(order.lines(), new OrderLine(product, qty));
    return right(new Order(order.id(), order.customer(), newLines, order.status()));
  }

  public static Either<OrderError, OrderWithEvents> submit(Order order, Instant now) {
    if (order.status() != OrderStatus.DRAFT)
      return left(new OrderError.NotModifiable(order.id(), order.status()));
    if (order.lines().isEmpty())
      return left(new OrderError.EmptyOrder(order.id()));
    var submitted = new Order(order.id(), order.customer(), order.lines(), OrderStatus.SUBMITTED);
    var event = new OrderPlaced(order.id(), order.customer(), order.lines(), now);
    return right(new OrderWithEvents(submitted, List.of(event)));
  }
}

// Pairs aggregate state with events produced by a command
public record OrderWithEvents(Order order, List<DomainEvent> events) {}
```

```typescript
// TypeScript equivalent — aggregate as readonly type, commands as functions
type Order = Readonly<{
  id: OrderId;
  customer: CustomerId;
  lines: readonly OrderLine[];
  status: 'draft' | 'submitted' | 'paid';
}>;

const addItem = (order: Order, product: ProductId, qty: Quantity): Result<Order, OrderError> =>
  order.status !== 'draft'
    ? err({ kind: 'not-modifiable', orderId: order.id, status: order.status })
    : order.lines.some(li => li.productId === product)
    ? err({ kind: 'duplicate-product', productId: product })
    : ok({ ...order, lines: [...order.lines, { productId: product, qty }] });
```

**The imperative shell orchestrates:**
```java
// Shell: load → pure command → persist. No business logic here.
public class OrderOrchestrator {
  private final OrderRepository orders;
  private final EventPublisher events;
  private final Clock clock;                              // I/O dependency

  public void submitOrder(OrderId id) {
    var order = orders.findById(id).orElseThrow();
    OrderCommands.submit(order, clock.now())              // pure (clock value passed in)
      .peek(result -> {
        orders.save(result.order());                   // I/O
        events.publishAll(result.events());             // I/O
      })
      .peekLeft(error -> { throw error.toException(); });
  }
}
```

### Domain Events

Immutable record of something meaningful that happened in the domain. Past tense.

**Rules:**
- Named in past tense using domain language: `OrderPlaced`, `PaymentFailed`, `ShipmentDispatched`
- Immutable value objects — they are facts that happened; never modified after creation
- Contain all data needed to understand what happened (no lazy loading, no entity references)
- **Returned by pure aggregate command functions** — not "published" from inside the core
- The imperative shell receives them as return values and handles publication (I/O)
- Used for cross-aggregate and cross-context communication

```java
// Domain event is a value object — immutable record
public record OrderPlaced(
  OrderId orderId,
  CustomerId customerId,
  List<LineItemSnapshot> items,
  Money total,
  Instant occurredAt
) implements DomainEvent {}
```

**Event flow in FC/IS:**
```
pure command function → returns (NewState, List<Event>)
       ↓
imperative shell → persists NewState, publishes Events (both I/O)
```

The functional core never calls a publisher, bus, or repository. It returns data. The shell decides what to do with it.

### Bounded Contexts

Explicit boundaries within which a domain model is consistent and terms have precise meaning.

**Rules:**
- Each context owns its own ubiquitous language (same word can mean different things in different contexts)
- Contexts communicate through published interfaces — not shared databases or internal types
- Types at context boundaries are translated (anti-corruption layer), not shared directly
- One team owns one context — shared ownership leads to coupled models
- When the same word means different things to different parts of the system, that's a context boundary

**Context relationships:**

| Pattern | Where It Lives | When to Use |
|---------|---------------|-------------|
| **Published Language** | Between contexts | Upstream defines a stable schema (OpenAPI, events) for consumers |
| **Anti-Corruption Layer** | Imperative shell | Downstream translates upstream's model into its own domain terms |
| **Shared Kernel** | Functional core (shared types) | Two contexts co-own a small set of types (use sparingly — tight coupling) |
| **Conformist** | Imperative shell | Downstream accepts upstream's model as-is (OK for trivial integrations) |

ACLs live in the imperative shell because translation between external and internal representations is I/O-adjacent work — parsing external formats, calling external APIs, mapping foreign types.

### Repositories

Collection-like interface for retrieving and persisting aggregates. One repository per aggregate root.

A repository is a **port** (see "Ports at I/O Boundaries" below). The interface is defined in domain terms, owned by the domain. The implementation is infrastructure that lives in the imperative shell.

**Rules:**
- Return whole immutable aggregates, not fragments
- Methods use domain types: `findByOrderId(OrderId)`, not `findById(String)`
- No query logic leaking into the domain — complex queries go in dedicated read-model projections
- In-memory fake for tests; real implementation for production
- See "Ports at I/O Boundaries" for the full port shape and fake pattern

### Domain Services (Pure)

Stateless pure functions that operate across multiple aggregates or value objects. The "domain service" in functional DDD is just a function in the functional core.

**Rules:**
- Named using domain verbs: `calculateShipping`, `assessCreditRisk`, not `ShippingService`
- Pure functions — all data comes through parameters, no I/O
- Lives in the functional core, always. If it needs I/O, it's a **shell orchestrator**, not a domain service.
- Returns `Either<Error, Result>` for operations that can fail
- If you're creating one because you don't know where to put logic, reconsider — it usually belongs on a value object or in an aggregate command function

```java
// Domain service: pure function operating across aggregates
public final class ShippingCalculator {
  private ShippingCalculator() {}

  // Pure: takes data from two aggregates, returns a value object
  public static Either<ShippingError, ShippingCost> calculate(
      Order order, Warehouse warehouse, ShippingZone zone) {
    if (!warehouse.canFulfill(order.lines()))
      return left(new ShippingError.InsufficientStock(warehouse.id()));
    var weight = order.lines().stream()
      .map(OrderLine::weight)
      .reduce(Weight.ZERO, Weight::add);
    return zone.costForWeight(weight); // pure calculation
  }
}
```

**Not a domain service** (this is a shell orchestrator):
```java
// BAD: "domain service" that does I/O — this is a shell orchestrator
public class ShippingService {
  private final WarehouseRepo warehouses; // I/O dependency = not a domain service
  public ShippingCost calculate(OrderId orderId) { /* loads, calculates, saves */ }
}

// GOOD: orchestrator in the shell, calls pure domain service
public class CalculateShippingOrchestrator {
  private final OrderRepository orders;
  private final WarehouseRepository warehouses;

  public ShippingCost execute(OrderId orderId, WarehouseId warehouseId) {
    var order = orders.findById(orderId).orElseThrow();         // I/O
    var warehouse = warehouses.findById(warehouseId).orElseThrow(); // I/O
    return ShippingCalculator.calculate(order, warehouse, zone)  // pure
      .getOrElseThrow(ShippingError::toException);              // shell converts
  }
}
```

### Strategic Design Checklist

When modeling a new feature:

1. **Identify the bounded context** — does this belong to an existing context or need a new one?
2. **Define the ubiquitous language** — what terms does the domain expert use? Capture in `CONTEXT.md`.
3. **Find the aggregates** — what are the consistency boundaries? What must change together atomically?
4. **Keep aggregates small** — only group what must be transactionally consistent.
5. **Model as immutable data** — aggregates and entities are records, not mutable objects.
6. **Extract command functions** — `(Aggregate, Command) → Either<Error, Aggregate + Events>` in the functional core.
7. **Identify value objects** — what has no identity? Make these the building blocks.
8. **Define domain events** — what state changes do other contexts need to know about? Returned by commands, published by shell.
9. **Map context relationships** — how does this context talk to others? ACL? Published language? Shared kernel?
10. **Define ports** — repositories and external adapters as interfaces in domain terms. Shell implements them.
11. **Write shell orchestrators** — thin orchestrators: load → call pure core → persist. No business logic.

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
- Internal orchestrators inside the shell
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

**DDD / Functional DDD:**
- Anemic domain models (types are data bags with no invariants, all logic in external services — note: immutable records with constructor invariants + separate pure command functions are NOT anemic)
- **Mutable aggregates** (aggregate methods that mutate `this` instead of returning new instances)
- **"Domain services" that do I/O** (if it touches a DB or API, it's a shell orchestrator, not a domain service)
- **Business logic in the shell** (orchestrators should be load → pure call → persist, nothing more)
- **Events published from inside the core** (core returns events as data; shell publishes them)
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
