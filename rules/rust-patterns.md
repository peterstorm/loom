---
description: Rust architectural patterns - ownership, enums, Result/Option, iterators, FP core
globs: "**/*.rs"
---

# Rust Architecture Patterns

## Newtype Pattern for Domain Modeling
```rust
// Prevent primitive obsession - wrap raw types
struct OrderId(u64);
struct CustomerId(u64);
struct Money(u64); // cents

impl Money {
    fn add(self, other: Money) -> Money {
        Money(self.0 + other.0)
    }
}

// Parse, don't validate - constructor returns Result
struct PositiveInt(u32);

impl PositiveInt {
    fn new(value: u32) -> Result<Self, DomainError> {
        if value == 0 {
            Err(DomainError::MustBePositive)
        } else {
            Ok(Self(value))
        }
    }

    fn get(&self) -> u32 {
        self.0
    }
}

struct NonEmptyString(String);

impl NonEmptyString {
    fn new(s: impl Into<String>) -> Result<Self, DomainError> {
        let s = s.into();
        let trimmed = s.trim().to_owned();
        if trimmed.is_empty() {
            Err(DomainError::MustNotBeEmpty)
        } else {
            Ok(Self(trimmed))
        }
    }
}
```

## Enums for Exhaustive Domain Modeling
```rust
// Algebraic data types - compiler-verified exhaustiveness
enum PaymentResult {
    Success { tx_id: TransactionId, completed_at: Instant },
    Failed { code: ErrorCode, message: String },
    Pending { redirect_url: String },
}

// Exhaustive pattern matching
fn handle_payment(result: &PaymentResult) -> String {
    match result {
        PaymentResult::Success { tx_id, .. } => format!("Success: {tx_id}"),
        PaymentResult::Failed { code, message } => format!("Failed: {code} - {message}"),
        PaymentResult::Pending { redirect_url } => format!("Redirect to: {redirect_url}"),
    }
}

// Domain states as enums - invalid states unrepresentable
enum OrderState {
    Draft { items: Vec<OrderLine> },
    Submitted { items: Vec<OrderLine>, submitted_at: Instant },
    Paid { items: Vec<OrderLine>, paid_at: Instant, tx_id: TransactionId },
    Cancelled { reason: String },
}
```

## Structs Are Immutable by Default
```rust
// Owned, immutable value objects
struct Order {
    id: OrderId,
    customer: CustomerId,
    lines: Vec<OrderLine>,
    created_at: Instant,
}

impl Order {
    fn total(&self) -> Money {
        self.lines.iter()
            .map(|line| line.total())
            .fold(Money(0), Money::add)
    }

    // Return new struct instead of mutating
    fn with_line(mut self, line: OrderLine) -> Self {
        self.lines.push(line);
        self
    }
}
```

## Iterator Chains over Imperative Loops
```rust
// BAD: imperative mutation
let mut results = Vec::new();
for item in &items {
    if item.is_active() {
        results.push(transform(item));
    }
}

// GOOD: iterator chain
let results: Vec<_> = items.iter()
    .filter(|item| item.is_active())
    .map(transform)
    .collect();

// GOOD: fold for aggregation
let total = lines.iter()
    .map(|l| l.total())
    .fold(Money(0), Money::add);

// GOOD: flat_map for nested iteration
let all_items: Vec<_> = orders.iter()
    .flat_map(|o| &o.lines)
    .collect();

// GOOD: partition for splitting
let (active, inactive): (Vec<_>, Vec<_>) = items.iter()
    .partition(|i| i.is_active());
```

## Result/Option Combinators over Match
```rust
// BAD: verbose matching
let value = match maybe_value {
    Some(v) => Some(transform(v)),
    None => None,
};

// GOOD: combinator
let value = maybe_value.map(transform);

// Chaining Result - railway-oriented
fn process_order(req: OrderRequest) -> Result<ProcessedOrder, OrderError> {
    validate_request(&req)
        .and_then(|v| create_order(v))
        .and_then(|o| apply_pricing(o))
        .map(|o| to_processed(o))
}

// ? operator for ergonomic propagation
fn process(req: OrderRequest) -> Result<ProcessedOrder, OrderError> {
    let validated = validate_request(&req)?;
    let order = create_order(validated)?;
    let priced = apply_pricing(order)?;
    Ok(to_processed(priced))
}

// map_err to convert error types
fn fetch_order(id: OrderId) -> Result<Order, AppError> {
    db.find(id)
        .map_err(|e| AppError::Database(e))?
        .ok_or(AppError::NotFound(id))
}

// Collecting Results from iterators
fn parse_all(inputs: &[&str]) -> Result<Vec<Order>, ParseError> {
    inputs.iter()
        .map(|s| parse_order(s))
        .collect() // short-circuits on first Err
}
```

## Error Handling Strategy
```rust
// Domain errors as enums - exhaustive, no stringly-typed errors
#[derive(Debug, thiserror::Error)]
enum OrderError {
    #[error("order not found: {0}")]
    NotFound(OrderId),
    #[error("invalid quantity: must be positive")]
    InvalidQuantity,
    #[error("insufficient stock for {product_id}")]
    InsufficientStock { product_id: ProductId },
}

// Functional core: returns Result, never panics
fn calculate_discount(order: &Order, tier: CustomerTier) -> Result<Money, OrderError> {
    let subtotal = order.total();
    let percent = match tier {
        CustomerTier::Gold => 15,
        CustomerTier::Silver => 10,
        CustomerTier::Bronze => 5,
    };
    Ok(subtotal.multiply(percent) / 100)
}

// Imperative shell: orchestrates I/O, converts errors
async fn handle_order(id: OrderId, db: &Pool) -> Result<HttpResponse, ApiError> {
    let order = db.find_order(id).await.map_err(ApiError::from)?;
    let customer = db.find_customer(order.customer).await.map_err(ApiError::from)?;

    // Pure core
    let discount = calculate_discount(&order, customer.tier)?;
    let processed = process_order(order, discount)?;

    // Persist
    db.save_order(&processed).await.map_err(ApiError::from)?;
    Ok(HttpResponse::Ok().json(processed))
}
```

## Functional Core, Imperative Shell
```rust
// CORE: Pure functions, no I/O, trivially testable
mod pricing {
    pub fn calculate_total(lines: &[OrderLine]) -> Money {
        lines.iter().map(|l| l.total()).fold(Money(0), Money::add)
    }

    pub fn apply_discount(total: Money, tier: CustomerTier) -> Money {
        let rate = match tier {
            CustomerTier::Gold => 85,
            CustomerTier::Silver => 90,
            CustomerTier::Bronze => 95,
        };
        total.multiply(rate) / 100
    }

    pub fn determine_status(total: Money) -> OrderStatus {
        if total == Money(0) {
            OrderStatus::Free
        } else {
            OrderStatus::PendingPayment
        }
    }
}

// SHELL: Thin orchestration, I/O at edges
async fn process_order(id: OrderId, repo: &dyn OrderRepo) -> Result<(), AppError> {
    // Fetch (I/O)
    let order = repo.find(id).await?;
    let customer = repo.find_customer(order.customer).await?;

    // Transform (pure)
    let total = pricing::calculate_total(&order.lines);
    let discounted = pricing::apply_discount(total, customer.tier);
    let status = pricing::determine_status(discounted);

    // Persist (I/O)
    repo.update_status(id, status).await?;
    Ok(())
}
```

## Trait-Based Abstraction (Ports & Adapters)
```rust
// Port: trait defines the contract
#[async_trait]
trait OrderRepository {
    async fn find(&self, id: OrderId) -> Result<Order, RepoError>;
    async fn save(&self, order: &Order) -> Result<(), RepoError>;
}

// Adapter: concrete implementation
struct PgOrderRepository { pool: PgPool }

#[async_trait]
impl OrderRepository for PgOrderRepository {
    async fn find(&self, id: OrderId) -> Result<Order, RepoError> {
        sqlx::query_as!(Order, "SELECT * FROM orders WHERE id = $1", id.0)
            .fetch_optional(&self.pool)
            .await
            .map_err(RepoError::from)?
            .ok_or(RepoError::NotFound)
    }
    // ...
}

// Test double: no mocking framework needed
struct FakeOrderRepository {
    orders: Vec<Order>,
}

#[async_trait]
impl OrderRepository for FakeOrderRepository {
    async fn find(&self, id: OrderId) -> Result<Order, RepoError> {
        self.orders.iter()
            .find(|o| o.id == id)
            .cloned()
            .ok_or(RepoError::NotFound)
    }
    // ...
}
```

## TypeState Pattern
```rust
// Encode state transitions in the type system - invalid transitions are compile errors
struct Order<S: OrderState> {
    id: OrderId,
    items: Vec<OrderLine>,
    state: S,
}

struct Draft;
struct Submitted { submitted_at: Instant }
struct Paid { paid_at: Instant, tx_id: TransactionId }

trait OrderState {}
impl OrderState for Draft {}
impl OrderState for Submitted {}
impl OrderState for Paid {}

impl Order<Draft> {
    fn submit(self) -> Order<Submitted> {
        Order {
            id: self.id,
            items: self.items,
            state: Submitted { submitted_at: Instant::now() },
        }
    }
}

impl Order<Submitted> {
    fn pay(self, tx_id: TransactionId) -> Order<Paid> {
        Order {
            id: self.id,
            items: self.items,
            state: Paid { paid_at: Instant::now(), tx_id },
        }
    }
}

// Compile error: can't pay a draft order
// let order = Order::<Draft>::new().pay(tx_id); // won't compile
```

## Builder Pattern with Consuming Self
```rust
struct RequestBuilder {
    url: String,
    headers: Vec<(String, String)>,
    timeout: Option<Duration>,
}

impl RequestBuilder {
    fn new(url: impl Into<String>) -> Self {
        Self { url: url.into(), headers: Vec::new(), timeout: None }
    }

    fn header(mut self, key: impl Into<String>, val: impl Into<String>) -> Self {
        self.headers.push((key.into(), val.into()));
        self
    }

    fn timeout(mut self, duration: Duration) -> Self {
        self.timeout = Some(duration);
        self
    }

    fn build(self) -> Result<Request, BuildError> {
        // validate and construct
        Ok(Request { url: self.url, headers: self.headers, timeout: self.timeout })
    }
}
```

## Closures and Higher-Order Functions
```rust
// Accept closures for flexible composition
fn retry<T, E, F>(max_attempts: u32, mut operation: F) -> Result<T, E>
where
    F: FnMut() -> Result<T, E>,
{
    let mut last_err = None;
    for _ in 0..max_attempts {
        match operation() {
            Ok(val) => return Ok(val),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap())
}

// Return closures for deferred computation
fn make_validator(min: u32, max: u32) -> impl Fn(u32) -> bool {
    move |value| value >= min && value <= max
}
```

## Anti-Patterns to Avoid

- **`unwrap()`/`expect()` in library/application code** — use `?` or combinators; reserve `unwrap` for tests and provably-safe cases
- **`clone()` to avoid borrow checker** — rethink ownership; cloning to silence the compiler hides design issues
- **Stringly-typed errors** — use `thiserror` enums, not `String` or `Box<dyn Error>` in domain code
- **Mutable shared state** — prefer message passing (`mpsc`), `Arc<Mutex<>>` only at boundaries
- **Giant match arms with logic** — extract each arm into a named function
- **Ignoring `Result` with `let _ =`** — always handle or explicitly log
- **`impl` blocks with mixed concerns** — separate construction, domain logic, serialization
- **Manual iterator reimplementation** — use `Iterator` trait and combinators
