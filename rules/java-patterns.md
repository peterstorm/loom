---
description: Java 21+ architectural patterns - records, sealed types, Either, FP core
globs: "**/*.java"
---

# Java 21+ Architecture Patterns

## Records for Immutable Domain Models
```java
// Prefer records over classes for DTOs and value objects
public record OrderLine(ProductId productId, int quantity, Money price) {
    public OrderLine {
        if (quantity <= 0) throw new IllegalArgumentException("qty must be positive");
    }

    public Money total() {
        return price.multiply(quantity);
    }
}

public record Order(OrderId id, CustomerId customer, List<OrderLine> lines, Instant createdAt) {
    public Order {
        lines = List.copyOf(lines); // defensive copy, immutable
    }

    public Money total() {
        return lines.stream()
            .map(OrderLine::total)
            .reduce(Money.ZERO, Money::add);
    }
}
```

## Sealed Types for Domain Modeling
```java
// Exhaustive pattern matching, compiler-verified
public sealed interface PaymentResult permits PaymentSuccess, PaymentFailed, PaymentPending {
    record PaymentSuccess(TransactionId txId, Instant completedAt) implements PaymentResult {}
    record PaymentFailed(ErrorCode code, String message) implements PaymentResult {}
    record PaymentPending(String redirectUrl) implements PaymentResult {}
}

// Pattern matching in switch (Java 21+)
public String handlePayment(PaymentResult result) {
    return switch (result) {
        case PaymentSuccess(var txId, _) -> "Success: " + txId;
        case PaymentFailed(var code, var msg) -> "Failed: " + code + " - " + msg;
        case PaymentPending(var url) -> "Redirect to: " + url;
    };
}
```

## Data-Oriented Programming
```java
// Pure functions operating on immutable data
public class PricingRules {
    // Pure: no side effects, deterministic
    public static Money calculateDiscount(Order order, CustomerTier tier) {
        var subtotal = order.total();
        var discountPercent = switch (tier) {
            case GOLD -> 15;
            case SILVER -> 10;
            case BRONZE -> 5;
            case STANDARD -> 0;
        };
        return subtotal.multiply(discountPercent).divide(100);
    }

    // Pure: transforms data, returns new data
    public static Order applyDiscount(Order order, Money discount) {
        // Returns new immutable Order with discount applied
        return new Order(order.id(), order.customer(), order.lines(), order.createdAt())
            .withDiscount(discount);
    }
}
```

## Iteration: Streams over For Loops
```java
// BAD: imperative for loop
for (var item : items) {
    process(item);
}

// GOOD: stream/forEach
items.forEach(this::process);

// GOOD: stream with transformation
items.stream()
    .filter(Item::isActive)
    .map(this::transform)
    .toList();
```

## Functional Core, Imperative Shell
```java
// SHELL: Handles I/O, orchestrates
@Service
public class OrderService {
    private final OrderRepository repo;
    private final CustomerRepository customerRepo;

    public OrderResult processOrder(OrderId id) {
        // Fetch (I/O)
        var order = repo.findById(id).orElseThrow();
        var customer = customerRepo.findById(order.customer()).orElseThrow();

        // Transform (pure) - delegate to functional core
        var discount = PricingRules.calculateDiscount(order, customer.tier());
        var processed = OrderProcessor.process(order, discount);

        // Persist (I/O)
        repo.save(processed);
        return OrderResult.success(processed);
    }
}

// CORE: Pure business logic, trivially testable
public class OrderProcessor {
    public static ProcessedOrder process(Order order, Money discount) {
        var finalTotal = order.total().subtract(discount);
        var status = finalTotal.isZero() ? OrderStatus.FREE : OrderStatus.PENDING_PAYMENT;
        return new ProcessedOrder(order, discount, finalTotal, status);
    }
}
```

## Railway-Oriented Programming with Either (dk.oister.util)
```java
import dk.oister.util.Either;
import dk.oister.util.Eithers;

// Composable error handling - Left = error, Right = success
public Either<OrderError, ProcessedOrder> processOrder(OrderRequest request) {
    return validateRequest(request)
        .flatMap(this::createOrder)
        .flatMap(this::applyPricing)
        .map(this::toProcessedOrder);
}

// Pattern matching with fold
public ResponseEntity<?> handleOrder(OrderRequest request) {
    return processOrder(request).fold(
        error -> ResponseEntity.badRequest().body(error.message()),
        order -> ResponseEntity.ok(order)
    );
}

// Safe exception handling
public Either<OrderError, Order> fetchOrder(OrderId id) {
    return Either.fromTryCatch(
        () -> orderRepo.findById(id).orElseThrow(),
        ex -> new OrderError("Order not found: " + id)
    );
}

// Batch processing - fail fast or collect all errors
public Either<OrderError, List<Order>> processAll(List<OrderRequest> requests) {
    return requests.stream()
        .map(this::processOrder)
        .collect(Eithers.firstFailure());  // or allFailures() for validation
}

// Collecting all validation errors
public Either<List<ValidationError>, Order> validateOrder(OrderRequest req) {
    return Stream.of(
        validateCustomer(req),
        validateItems(req),
        validatePayment(req)
    ).collect(Eithers.allFailures())
     .map(results -> buildOrder(req));
}

// Combining multiple Eithers (applicative style)
public Either<OrderError, OrderLine> parseLine(LineRequest req) {
    return Eithers.combine(
        ProductId.of(req.productId()),
        Quantity.of(req.quantity()),
        Money.of(req.price())
    ).map(OrderLine::new);  // maps (productId, quantity, price) -> OrderLine
}

// Eithers.combine supports 2-5 arguments
// Fails fast on first Left encountered
```

## Parse, Don't Validate
```java
// BAD: Validation returns boolean/Unit - caller can ignore result
public Either<List<String>, Boolean> validate(OrderRequest request) {
    // ... validation logic ...
    return Either.right(true);
}

// Caller can still use unvalidated data
orderService.process(request); // no compile-time guarantee

// GOOD: Parse into validated type - compiler enforces validation happened
public record ValidatedOrder(
    OrderId id,
    CustomerId customer,
    List<OrderLine> lines
) {}

public Either<List<String>, ValidatedOrder> validate(OrderRequest request) {
    return allValidations(request)
        .collect(Eithers.allFailures())
        .map(ignored -> new ValidatedOrder(
            request.id(), request.customer(), request.lines()));
}

// Downstream requires ValidatedOrder - type system enforces validation
public ProcessedOrder process(ValidatedOrder order) {
    // Can only receive validated data
}
```

Key principle: Return the validated data itself, not a success indicator.
The type system then enforces that validation occurred before processing.

## Primitive Wrappers (dk.oister.util.primitives)
Type-safe wrappers with factory methods returning Either. Use instead of raw primitives.

```java
import dk.oister.util.primitives.*;

// PositiveInt: int > 0
Either<String, PositiveInt> qty = PositiveInt.of(5);   // Right(PositiveInt(5))
Either<String, PositiveInt> bad = PositiveInt.of(0);   // Left("must be positive (> 0)")

// NonEmptyString: trims whitespace, rejects blank
Either<String, NonEmptyString> name = NonEmptyString.of("  hello  ");  // Right("hello")
Either<String, NonEmptyString> blank = NonEmptyString.of("");          // Left("must not be empty")

// NonNegativeLong: long >= 0
Either<String, NonNegativeLong> price = NonNegativeLong.of(100);  // Right(100)
Either<String, NonNegativeLong> neg = NonNegativeLong.of(-1);     // Left("must be non-negative")

// Compose with Eithers.combine - fail fast
record OrderLine(PositiveInt qty, NonEmptyString name, NonNegativeLong price) {}

Either<String, OrderLine> parseLine(LineRequest req) {
    return Eithers.combine(
        PositiveInt.of(req.quantity()),
        NonEmptyString.of(req.productName()),
        NonNegativeLong.of(req.priceInCents())
    ).map(OrderLine::new);
}
```

## Validation for Error Accumulation (dk.oister.util.validation)
Unlike Either (fail-fast), Validation collects ALL errors. Use for form validation.

```java
import dk.oister.util.validation.*;

// Validation<E, A> - sealed with Valid/Invalid
Validation<String, Integer> valid = Validation.valid(42);
Validation<String, Integer> invalid = Validation.invalid("error");
Validation<String, Integer> multi = Validation.invalid(NonEmptyList.of("err1", "err2"));

// Pattern matching (Java 21)
String result = switch (validation) {
    case Valid(var value) -> "Success: " + value;
    case Invalid(var errors) -> "Errors: " + errors.toList();
};

// Field validators return Validation
Validation<String, String> validateName(String name) {
    return name.isBlank()
        ? Validation.invalid("name required")
        : Validation.valid(name.trim());
}

Validation<String, String> validateEmail(String email) {
    return !email.contains("@")
        ? Validation.invalid("invalid email")
        : Validation.valid(email);
}

// Validations.combine - accumulates ALL errors
record User(String name, String email, int age) {}

Validation<String, User> validateUser(String name, String email, int age) {
    return Validations.combine(
        validateName(name),
        validateEmail(email),
        validateAge(age)
    ).map(User::new);
}

// Multiple errors collected
var result = validateUser("", "invalid", -5);
// → Invalid(NonEmptyList("name required", "invalid email", "age must be 0-150"))

// Sequence stream of validations
Validation<String, List<Integer>> sequenced = Stream.of(
    Validation.valid(1),
    Validation.invalid("bad"),
    Validation.valid(3)
).collect(Validations.sequence());
// → Invalid(NonEmptyList("bad"))

// Traverse: map + sequence
Validation<String, List<User>> users = Validations.traverse(
    requests,
    req -> validateUser(req.name(), req.email(), req.age())
);
```

## Either vs Validation

| Use Case | Type | Reason |
|----------|------|--------|
| Parsing/deserialization | Either | Fail fast on first error |
| Sequential operations | Either | Later steps depend on earlier |
| Form validation | Validation | Show ALL errors to user |
| Batch validation | Validation | Collect all problems |

```java
// Either: parsing (fail fast is fine)
Either<String, Config> config = Eithers.combine(
    NonEmptyString.of(req.host()),
    PositiveInt.of(req.port())
).map(Config::new);

// Validation: user input (show all errors)
Validation<String, UserForm> form = Validations.combine(
    validateUsername(input.username()),
    validatePassword(input.password()),
    validateEmail(input.email())
).map(UserForm::new);
```
