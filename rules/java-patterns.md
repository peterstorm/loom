---
description: Java 21+ architectural patterns - records, sealed types, Either, FP core
globs: "**/*.java"
---

# Java 21+ Architecture Patterns

The rules are in `architecture.md`; this file gives their Java shape, one canonical sample per concept. Samples target Java 21.

## Package Structure

Dependency arrows point inward: infra → domain, orchestrator → domain. Never outward.

```
<base>/
├── domain/              Pure functional core (no Spring annotations, no I/O)
│   ├── model/           Value objects, entities, sealed types, records
│   ├── port/            Port interfaces (owned by domain, implemented in infra)
│   ├── error/           Error types (sealed hierarchies)
│   └── *.java           Pure logic classes (static functions, no state)
├── orchestrator/        Shell orchestrators: sequence ports + pure domain logic
├── tools/ | api/        Outermost shell: REST controllers, MCP tools
├── infra/{system}/      Adapters and vendor SDK wrappers, grouped by external system (postgres/, kafka/, stripe/)
├── auth/                Authentication/identity boundary (I/O; may implement a port)
└── config/              Spring Boot configuration, properties, security, bean wiring
```

In-memory fakes ship with their port, in `src/test/.../testfixtures/`.

**Import rules** (ArchUnit or Loom's `boundaries` lint):
- `domain/` imports nothing from `orchestrator/`, `infra/`, `tools/`, or `config/`
- `orchestrator/` imports from `domain/` (ports + model + logic). Never from `infra/`.
- `infra/` imports from `domain/port/` (to implement) and vendor SDKs. Never from `orchestrator/`.
- `tools/` imports from `domain/` and `orchestrator/`. Never from `infra/`.
- No class in `domain/` carries `@Component`, `@Service`, `@Repository`, or any Spring annotation.

An orchestrator depends on the port interface (`PaymentGateway`); Spring injects the adapter (`StripePaymentAdapter`) at runtime. Tests substitute an in-memory fake with no Mockito or WireMock, and swapping a backend changes only `infra/`. An `infra` import in an orchestrator is a boundary violation; ArchUnit or the lint rejects it, the compiler does not.

**Naming:** orchestrators as in `architecture.md` → "Shell Orchestrators" (`SubmitOrderOrchestrator`, `OrderOrchestrator`); adapters after system + role (`StripePaymentAdapter`, `JdbcOrderRepository`); ports after the domain capability (`PaymentGateway`, `OrderRepository`). A domain service is a static function on a domain-noun class used as a namespace: `ShippingCalculator.calculate(...)`.

## Either

Fallible core functions return `Either<Error, T>`: Left is the error, Right the success. Use the project's Either. If none exists, define a sealed `Either<L, R>` with `Left` and `Right` records, or use Vavr. The samples use only `Either.left`, `Either.right`, `map`, `flatMap` and `fold`. Errors are sealed hierarchies, not strings.

| Use Case | Type | Reason |
|----------|------|--------|
| Parsing/deserialization | Either | Fail fast on first error |
| Sequential operations | Either | Later steps depend on earlier |
| Form validation | Validation | Show ALL errors to user |
| Batch validation | Validation | Collect all problems |

Either is fail-fast; an applicative `Validation` accumulates. Pick by the table and do not mix the two for one job.

## Value Objects: Parse, Don't Validate

```java
public record Quantity(int value) {
    public Quantity { // an assertion: `of` makes it unreachable for untrusted input
        if (value <= 0) throw new IllegalArgumentException("quantity must be positive");
    }

    public static Either<OrderError, Quantity> of(int raw) {
        return raw > 0 ? Either.right(new Quantity(raw)) : Either.left(new OrderError.InvalidQuantity(raw));
    }
}

public record OrderLine(ProductId productId, Quantity quantity) {}

// The parser returns the parsed value, built from the parsed parts, never from the raw request.
public static Either<OrderError, OrderLine> parseLine(LineRequest request) {
    return ProductId.of(request.productId()).flatMap(productId ->
           Quantity.of(request.quantity()).map(quantity ->
           new OrderLine(productId, quantity)));
}
```

- Untrusted input enters through a factory returning `Either`. A compact constructor may throw only as an assertion the factory makes unreachable.
- Wrap primitives that carry meaning (`Quantity`, `OrderId`), not raw `int` and `String`.
- A function that returns `Either<E, Boolean>` or `void` is a validator: the caller can still use the unvalidated request. Downstream signatures take the parsed type (`OrderLine`), so the compiler proves parsing happened.

## Aggregate, Commands, Events

```java
public record Order(OrderId id, CustomerId customer, List<OrderLine> lines, OrderStatus status) {
    public Order { lines = List.copyOf(lines); }
}

public sealed interface OrderError {
    record NotFound(OrderId id) implements OrderError {}
    record NotModifiable(OrderId id, OrderStatus status) implements OrderError {}
    record EmptyOrder(OrderId id) implements OrderError {}
    record InvalidQuantity(int raw) implements OrderError {}
}

public record OrderPlaced(OrderId orderId, CustomerId customerId, List<OrderLine> lines, Instant occurredAt)
        implements DomainEvent {
    public OrderPlaced { lines = List.copyOf(lines); }
}

public record OrderWithEvents(Order order, List<DomainEvent> events) {}

// Command functions are static and pure, in their own class, not methods on the record.
public final class OrderCommands {
    private OrderCommands() {}

    public static Either<OrderError, OrderWithEvents> submit(Order order, Instant now) {
        if (order.status() != OrderStatus.DRAFT)
            return Either.left(new OrderError.NotModifiable(order.id(), order.status()));
        if (order.lines().isEmpty())
            return Either.left(new OrderError.EmptyOrder(order.id()));
        var submitted = new Order(order.id(), order.customer(), order.lines(), OrderStatus.SUBMITTED);
        var event = new OrderPlaced(order.id(), order.customer(), order.lines(), now);
        return Either.right(new OrderWithEvents(submitted, List.of(event)));
    }
}
```

Sealed interfaces with nested records need no `permits`. Switch over them with pattern matching and no `default` arm, so a new variant is a compile error. Unnamed patterns (`_`) need Java 22. In the core, prefer streams that transform (`filter`/`map`/`toList`) to loops that mutate; `forEach` is for effects in the shell.

## Orchestrator

```java
@Service // Spring's DI annotation, not a DDD term. The class is still named for the operation.
public class SubmitOrderOrchestrator {
    private final OrderRepository orders;
    private final Outbox outbox; // port: stores events in the caller's transaction; a relay publishes them
    private final Clock clock;   // java.time.Clock; tests pass Clock.fixed(...)
    // constructor injection of the three fields

    @Transactional // the order and its events commit together
    public Either<OrderError, Order> submit(OrderId id) {
        return load(id)
            .flatMap(order -> OrderCommands.submit(order, clock.instant()))
            .map(this::store);
    }

    private Either<OrderError, Order> load(OrderId id) {
        return orders.findById(id)
            .<Either<OrderError, Order>>map(Either::right)
            .orElseGet(() -> Either.left(new OrderError.NotFound(id)));
    }

    private Order store(OrderWithEvents result) {
        orders.save(result.order());
        outbox.add(result.events());
        return result.order();
    }
}
```

"Not found" is the empty `Optional`. Do not wrap the lookup in a try/catch that maps every exception to `NotFound`: a database outage is not a missing order, and it propagates as an exception. The controller folds the `Either` into a response in one place.

## Ports & Adapters at I/O Boundaries

See `architecture.md` → "Ports at I/O Boundaries" for when a port is earned.

```java
// Port: owned by the domain, no vendor types in signatures
public interface OrderRepository {
    Optional<Order> findById(OrderId id);
    void save(Order order);
}

public interface Outbox {
    void add(List<DomainEvent> events);
}

@FunctionalInterface
public interface IdGenerator {
    OrderId next();
}

// Test fake: in-memory, no mocking framework
public final class InMemoryOrderRepository implements OrderRepository {
    private final Map<OrderId, Order> store = new ConcurrentHashMap<>();

    @Override public Optional<Order> findById(OrderId id) { return Optional.ofNullable(store.get(id)); }
    @Override public void save(Order order) { store.put(order.id(), order); }
}
```

- A single-method port is a `@FunctionalInterface`, so a test passes a lambda: `IdGenerator ids = () -> new OrderId("order-1");`.
- The clock is `java.time.Clock`. Do not declare your own `Clock` port.
- Do not wrap Spring's abstractions (`CacheManager`, `JdbcTemplate`) in a same-shaped port "for testability"; put a domain-shaped port in front of them.

## Canonical Example: Charging a Card

Sealed types, a pure decision and a thin shell, implementing `architecture.md` → "Effects are retry-safe".

```java
public record ChargeCommand(MerchantId merchantId, IdempotencyKey key, Money amount, PaymentMethodToken method) {}

public sealed interface Outcome {
    record Succeeded(ChargeId chargeId) implements Outcome {}
    record Declined(DeclineReason reason) implements Outcome {}
}

// A stored attempt is pending or settled; no state has both.
public sealed interface Attempt {
    Fingerprint fingerprint();
    record Pending(Fingerprint fingerprint) implements Attempt {}
    record Settled(Fingerprint fingerprint, Outcome outcome) implements Attempt {}
}

public sealed interface Decision {
    record Charge() implements Decision {}                // first sight of this key
    record Replay(Outcome outcome) implements Decision {} // already settled: return the stored answer
    record Reconcile() implements Decision {}             // an earlier run stopped mid-flight
    record KeyReused() implements Decision {}             // same key, different command
}

public final class ChargePolicy {
    private ChargePolicy() {}

    public static Decision decide(Optional<Attempt> existing, Fingerprint fingerprint) {
        if (existing.isEmpty()) return new Decision.Charge();
        Attempt attempt = existing.get();
        if (!attempt.fingerprint().equals(fingerprint)) return new Decision.KeyReused();
        return switch (attempt) {
            case Attempt.Pending pending -> new Decision.Reconcile();
            case Attempt.Settled settled -> new Decision.Replay(settled.outcome());
        };
    }
}
```

```java
public sealed interface PspResult {
    record Completed(Outcome outcome) implements PspResult {}
    record Unknown() implements PspResult {} // timeout: the charge may or may not have happened
}

public sealed interface ChargeError {
    record KeyReused() implements ChargeError {}
    record InProgress() implements ChargeError {}
}

public interface ChargeAttempts {
    // INSERT … ON CONFLICT (merchant_id, key) DO NOTHING in its own transaction, then read the row.
    // Empty when this call created the pending row.
    Optional<Attempt> claim(MerchantId merchantId, IdempotencyKey key, Fingerprint fingerprint);
    void settle(MerchantId merchantId, IdempotencyKey key, Outcome outcome);
}

public interface PaymentProvider {
    PspResult charge(String pspKey, ChargeCommand command); // the PSP deduplicates on pspKey
}

@Service
public class ChargeCardOrchestrator {
    private final ChargeAttempts attempts;
    private final PaymentProvider psp;
    // constructor injection of both ports

    public Either<ChargeError, Outcome> charge(ChargeCommand command) {
        Fingerprint fingerprint = Fingerprint.of(command); // pure: hash of amount, currency, method
        Optional<Attempt> existing = attempts.claim(command.merchantId(), command.key(), fingerprint);
        return switch (ChargePolicy.decide(existing, fingerprint)) {
            case Decision.KeyReused reused -> Either.left(new ChargeError.KeyReused());
            case Decision.Replay replay -> Either.right(replay.outcome());
            case Decision.Charge first -> chargeOnce(command);
            case Decision.Reconcile retry -> chargeOnce(command);
        };
    }

    // Same downstream key on the first run and on every retry: the PSP charges at most once.
    private Either<ChargeError, Outcome> chargeOnce(ChargeCommand command) {
        String pspKey = command.merchantId().value() + ":" + command.key().value();
        return switch (psp.charge(pspKey, command)) {
            case PspResult.Unknown unknown -> Either.left(new ChargeError.InProgress()); // stays pending
            case PspResult.Completed completed -> {
                attempts.settle(command.merchantId(), command.key(), completed.outcome());
                yield Either.right(completed.outcome());
            }
        };
    }
}
```

- **FP:** the whole policy is `ChargePolicy.decide`, pure and total, tested with no fakes. The shell only dispatches on the decision; `KeyReused` and `InProgress` are values, not exceptions.
- **Idempotency:** a unique constraint claims the key before the effect, so two concurrent requests cannot both see "no attempt". `Charge` and `Reconcile` share a path because the PSP gets the same key: a crash before `settle` is healed by the next retry, not by a second charge. A timeout leaves the attempt pending; releasing the key is the classic double charge. If the PSP cannot deduplicate, `Reconcile` queries it first.
- **Security:** `merchantId` comes from the authenticated session, never the body, so one tenant cannot replay or block another's payment. The fingerprint stops a key being reused to change the amount or method. The key is parsed at the boundary, expires on a documented TTL longer than the client's retry window, and stays out of logs with the PSP token. `Money` is integer minor units plus currency.

## Project binding: dk.oister.util

For projects that use `dk.oister.util`. The samples above read unchanged against it.

- Imports: `dk.oister.util.Either`, `dk.oister.util.Eithers`, `dk.oister.util.primitives.*`, `dk.oister.util.validation.*`.
- `Eithers.combine(a, b, …)` takes 2 to 5 Eithers, fails fast on the first Left, and maps positionally. `parseLine` above becomes `Eithers.combine(ProductId.of(request.productId()), Quantity.of(request.quantity())).map(OrderLine::new)`.
- Streams of Eithers: `.collect(Eithers.firstFailure())` stops at the first Left; `.collect(Eithers.allFailures())` gives `Either<List<E>, List<A>>` for a list of already-computed results. To accumulate errors across different fields use `Validation`, not `allFailures()`.
- `Either.fromTryCatch(supplier, ex -> error)` converts a throwing call. Use it only where every exception the call can throw means that one error; never for a repository lookup.
- Primitives, each with `of(...)` returning `Either<String, T>`: `PositiveInt` (> 0), `NonNegativeLong` (>= 0), `NonEmptyString` (trims, rejects blank).
- `Validation<E, A>` is sealed with `Valid(value)` and `Invalid(errors)`, where `errors` is a `NonEmptyList<E>`; build with `Validation.valid(a)` / `Validation.invalid(e)`. `Validations.combine(v1, v2, …).map(UserForm::new)` accumulates every error; `Validations.sequence()` is the stream collector and `Validations.traverse(items, fn)` is map + sequence.
