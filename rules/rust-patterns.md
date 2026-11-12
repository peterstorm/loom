---
description: Rust architectural patterns - newtypes, enums, Result, traits as ports, FP core
globs: "**/*.rs"
---

# Rust Architecture Patterns

The rules are in `architecture.md`; this file gives their Rust shape.

## Module Layout

```
src/
├── domain/          Pure core: types, errors, functions. No I/O, no async, no framework crates.
│   └── port.rs      Port traits, owned by the domain
├── orchestrator/    Shell: sequences ports around pure domain functions
├── api/             Outermost shell: HTTP handlers, CLI
├── infra/{system}/  Adapters: implement the port traits, import vendor crates
└── main.rs          Wiring and configuration
```

`domain` uses nothing from the other modules; `orchestrator` and `api` use `domain` and never `infra`; only `main.rs` names concrete adapters.

## Newtypes: Parse, Don't Validate

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct OrderId(u64);

// The only way to get a PositiveInt is through the parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PositiveInt(u32);

impl PositiveInt {
    fn new(value: u32) -> Result<Self, DomainError> {
        if value == 0 { Err(DomainError::MustBePositive) } else { Ok(Self(value)) }
    }

    fn get(self) -> u32 {
        self.0
    }
}
```

Wrap every primitive that carries meaning (`OrderId`, `Money`, `NonEmptyString`); keep the field private so the constructor cannot be bypassed.

## Enums for State

```rust
#[derive(Debug, Clone)]
struct Order {
    id: OrderId,
    lines: Vec<OrderLine>,
    state: OrderState,
}

// Each state carries exactly its own data: no `paid_at` on a draft.
#[derive(Debug, Clone)]
enum OrderState {
    Draft,
    Submitted { submitted_at: OffsetDateTime },
    Paid { paid_at: OffsetDateTime, charge_id: ChargeId },
}

// A command is a pure function: it takes the aggregate by value and returns a new one.
fn submit(order: Order, now: OffsetDateTime) -> Result<Order, OrderError> {
    match order.state {
        OrderState::Draft if order.lines.is_empty() => Err(OrderError::Empty(order.id)),
        OrderState::Draft => Ok(Order { state: OrderState::Submitted { submitted_at: now }, ..order }),
        OrderState::Submitted { .. } | OrderState::Paid { .. } => Err(OrderError::NotModifiable(order.id)),
    }
}
```

- `match` on your own enums without a `_` arm, so a new variant is a compile error.
- Persisted and serialised times are wall-clock: `time::OffsetDateTime` or `chrono::DateTime<Utc>`. `std::time::Instant` is monotonic and cannot be stored; use it only to measure durations. The shell reads the clock and passes the value in.
- **Enum or typestate:** use an enum when the state is runtime data (loaded from storage, matched on). Use typestate (`Connection<Handshaking>` → `Connection<Ready>`, one zero-sized marker type per state, transitions consuming `self`) only for a flow fixed at compile time, such as a builder or a handshake. An aggregate that is saved and loaded is an enum.

## Errors

```rust
#[derive(Debug, thiserror::Error)]
enum OrderError {
    #[error("order {0:?} has no lines")]
    Empty(OrderId),
    #[error("order {0:?} can no longer be modified")]
    NotModifiable(OrderId),
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("order {0:?} not found")]
    NotFound(OrderId),
    #[error(transparent)]
    Order(#[from] OrderError),
    #[error(transparent)]
    Repo(#[from] RepoError),
}
```

- Core functions return `Result` with an error enum and never panic. A function that cannot fail returns the plain value, not a `Result` that is always `Ok`.
- Propagate with `?`; `#[from]` supplies the conversion, so `.map_err(AppError::from)?` is redundant. Use `map`, `and_then` and `ok_or` instead of a `match` that only rewraps.
- Collect fallible iterations with `.collect::<Result<Vec<_>, _>>()`; it stops at the first `Err`.
- Prefer iterator chains (`filter`, `map`, `fold`) to loops that push into a `mut Vec`.

## Ports & Adapters

See `architecture.md` → "Ports at I/O Boundaries" for when a port is earned.

```rust
// Port: a trait owned by the domain, typed in domain terms.
trait OrderRepository {
    async fn find(&self, id: OrderId) -> Result<Option<Order>, RepoError>;
    async fn save(&self, order: &Order) -> Result<(), RepoError>;
}

// Shell: depends on the port, not on a connection pool.
async fn submit_order(
    id: OrderId,
    repo: &impl OrderRepository,
    now: OffsetDateTime,
) -> Result<Order, AppError> {
    let order = repo.find(id).await?.ok_or(AppError::NotFound(id))?;
    let submitted = submit(order, now)?; // pure
    repo.save(&submitted).await?;
    Ok(submitted)
}

// Test fake: a plain struct, no mocking crate.
#[derive(Default)]
struct FakeOrderRepository {
    orders: Mutex<HashMap<OrderId, Order>>,
}

impl OrderRepository for FakeOrderRepository {
    async fn find(&self, id: OrderId) -> Result<Option<Order>, RepoError> {
        Ok(self.orders.lock().expect("fake lock").get(&id).cloned())
    }

    async fn save(&self, order: &Order) -> Result<(), RepoError> {
        self.orders.lock().expect("fake lock").insert(order.id, order.clone());
        Ok(())
    }
}
```

`async fn` in traits is native since Rust 1.75; take ports as generics (`&impl OrderRepository`). `#[async_trait]` is still needed when the port is used as `dyn Trait`, because native async trait methods are not dyn-compatible, and it is the simple way to require `Send` futures.

## Retry

```rust
/// Only for retry-safe operations: see `architecture.md` → "Effects are retry-safe".
fn retry<T, E>(attempts: NonZeroU32, mut operation: impl FnMut() -> Result<T, E>) -> Result<T, E> {
    let mut result = operation();
    for _ in 1..attempts.get() {
        if result.is_ok() {
            break;
        }
        result = operation();
    }
    result
}
```

`NonZeroU32` makes "zero attempts" unrepresentable, so there is no `unwrap`. Retrying an operation that is not idempotent repeats its effect.

## Anti-Patterns to Avoid

- **`unwrap()`/`expect()` in library/application code** — use `?` or combinators; reserve them for tests and provably-safe cases
- **`clone()` to avoid borrow checker** — rethink ownership; cloning to silence the compiler hides design issues
- **Stringly-typed errors** — use `thiserror` enums, not `String` or `Box<dyn Error>` in domain code
- **Mutable shared state** — prefer message passing (`mpsc`), `Arc<Mutex<>>` only at boundaries
- **Giant match arms with logic** — extract each arm into a named function
- **Ignoring `Result` with `let _ =`** — always handle or explicitly log
- **`impl` blocks with mixed concerns** — separate construction, domain logic, serialization
- **Manual iterator reimplementation** — use `Iterator` trait and combinators
