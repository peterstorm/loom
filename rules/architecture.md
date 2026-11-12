---
description: Core architectural principles for all code - always apply
globs: "**/*.{ts,tsx,js,jsx,java,kt,hs,scala,rs}"
---

# Architecture Principles

Language-neutral rules for all code. Code shapes, package layout and toolchain gates are in `java-patterns.md`, `typescript-patterns.md`, `rust-patterns.md`. `Either<Error, T>` stands for the language's result type (`Result<T, E>` in TypeScript and Rust).

## Core Philosophy

1. **Functional core, imperative shell** - business logic is pure functions; a thin shell does the I/O: `fetch (I/O) → transform (pure) → persist (I/O)`.
2. **Immutability first** - mutability needs a reason.
3. **Parse, don't validate** - return the validated data, not a boolean; make invalid states unrepresentable.
4. **Domain-driven design** - model domain concepts explicitly, in the domain's own words.

## Testability

- 90%+ of the code is unit-testable without mocks.
- Pass data as parameters, not injected services.
- Business rules get property-based tests (`property-testing.md`).
- Integration tests cover I/O boundaries only.

## Domain-Driven Design

Functional DDD: the strategic patterns (bounded contexts, ubiquitous language, context mapping) apply as Evans wrote them; the tactical patterns are adapted to the core/shell split.

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

- Every domain concept has one name, used in code, tests, docs and conversation.
- If a `CONTEXT.md` exists, it is the source of truth for terminology.
- When code uses a different word than the domain expert would, rename the code.
- Generic names (`Manager`, `Service`, `Handler`, `Processor`) and technical suffixes (`UserDTO`, `OrderEntity`) are not domain language; use the domain's nouns.

### Value Objects

Immutable types defined by their attributes; equal when the attributes are equal.

- Untrusted input enters through a factory that returns `Either`, so an invalid value cannot exist.
- No setters. Operations return new values; one that can fail (adding two currencies) returns `Either`, it does not throw.
- Use for money, dates, addresses, email, IDs, measurements, enumerations with behavior.

### Entities

- Identity is the ID, assigned at creation and never changed: two values with the same ID are versions of the same entity. Record equality stays structural; compare IDs when you mean "same entity".
- Entities are immutable records. A state change is a pure function returning a new instance.
- Keep entities small; push behavior into value objects.

### Aggregates

A cluster of entities and value objects that is consistent as a unit, entered only through its root: immutable data plus pure command functions, `(Aggregate, Command) → Either<Error, Aggregate + Events>`.

- Every invariant is enforced by a command function that returns a new aggregate.
- Refer to an aggregate by its root ID, never by object, from outside and from other aggregates.
- One aggregate per transaction.
- Group only what must be consistent together. When in doubt, split.

**Sizing heuristic:** If two things can be independently updated by different users without conflict, they're separate aggregates.

### Shell Orchestrators

Load through ports, call one pure command, persist and publish what it returned. No business logic. The state change and its events leave together (see "Effects are retry-safe").

- **Operation-named**, one method, for complex or cross-aggregate flows: `CalculateShippingOrchestrator`, `SubmitOrderOrchestrator`.
- **Aggregate-named**, several methods, for thin operations on one aggregate that share ports: `OrderOrchestrator` with `submit`, `cancel`. Extract an operation when it grows.
- Never `XxxService`, and the package is `orchestrator/`, not `service/`: "service" already means a pure domain service and a framework stereotype.

### Domain Events

- Immutable facts, named in the past tense in domain language: `OrderPlaced`, `PaymentFailed`.
- Carry everything needed to understand what happened: no entity references, no lazy loading.
- Returned by command functions as data. The core never calls a publisher, bus or repository; the shell publishes.
- Used for communication between aggregates and between contexts.

### Bounded Contexts

A boundary inside which each term has one meaning. One word meaning two things in two parts of the system marks a context boundary.

- Each context owns its language and its storage. No shared tables.
- Contexts talk through published interfaces, never through internal types.
- Types crossing a boundary are translated by an anti-corruption layer in the shell.

Choosing a context relationship and modeling a new feature are design-time work: see the `architecture-tech-lead` skill.

### Repositories

A collection-like port, one per aggregate root.

- Return whole immutable aggregates, not fragments.
- Methods take domain types: `findByOrderId(OrderId)`, not `findById(String)`.
- Complex queries go in dedicated read-model projections, not in the domain.

### Domain Services

Stateless pure functions over several aggregates or value objects.

- Named with domain verbs: `calculateShipping`, `assessCreditRisk`.
- All data arrives as parameters; fallible operations return `Either`.
- If it needs I/O it is a shell orchestrator, not a domain service.
- If you create one because the logic has no obvious home, it probably belongs on a value object or in a command function.

## Error Handling Strategy

**Functional Core (pure functions):**
- Business logic errors → return `Either<Error, T>`, never throw
- Constructor invariants → may throw (guards type's validity); the factory that parses untrusted input makes that throw unreachable
- Enables composition, explicit control flow, trivial testing

**Imperative Shell (I/O orchestration):**
- Infrastructure failures (DB, network) → may throw at boundary
- Converts `Either.left` → thrown exception / error response as needed
- Single place for exception-to-response mapping

## Effects are retry-safe

Two words, two rules. **Idempotence** belongs to a pure function: `f(f(x)) = f(x)`, as for a normaliser. **Idempotency** belongs to an effect: performing a command once or many times leaves the world in the same state and returns the same answer. This section is about the second.

Assume every command arrives more than once: clients retry on timeout, queues redeliver, users double-click.

- The caller supplies an idempotency key with the command. The key is scoped to the authenticated principal, never global.
- Claim the key before the effect, atomically (a unique constraint, not check-then-insert). Deduplication after the mutation is not deduplication.
- Store a fingerprint of the command with the key. The same key with a different command is an error, not a replay.
- The decision (first time, replay, in progress, key reused) is a pure function of the stored attempt and the incoming command. The shell only loads, calls the port and stores.
- An unknown outcome (timeout, crash) is not a failure. Keep the attempt pending and reconcile; never release the key and never retry blind.
- Pass the same key to the downstream system so its deduplication lines up with yours. If it has none, reconcile by asking it for the earlier result before repeating the effect.
- State change and event leave together: the same transaction, or an outbox. Save-then-publish loses the event on a crash and publishes twice on a retry.
- Consumers deduplicate on the event id for the same reason.

The language files show the canonical shape (charging a card).

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
- Return meaningful types: when a port method produces a domain-meaningful result, return it — prefer `Either<Error, OrderPlaced>` over `Either<Error, Void>` or `Either<Error, Boolean>`. Infrastructure write methods (`save`, `publish`) that have no meaningful return value may use `void` and throw on infrastructure failure (per the shell error handling strategy).

Where ports, adapters and fakes are placed is in each language file's "Package Structure".

## Anti-Patterns to Flag

Breaking any rule above is a finding. These have no rule above:

- Anemic domain models (types are data bags with no invariants, all logic in external services — note: immutable records with constructor invariants + separate pure command functions are NOT anemic)
- Ports introduced "for future swappability" with no second adapter and no test fake
- Mock-heavy tests: a port is missing or has the wrong shape
- Services with 5+ dependencies
- Mutable shared state
- Catch-all exception handlers
