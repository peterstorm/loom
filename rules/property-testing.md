---
description: Property-based testing patterns with jqwik - invariants, arbitraries
globs: "**/*Test.java"
---

# Property-Based Testing (jqwik)

## When to Use Property Tests
| Use Property Tests | Use Example Tests |
|-------------------|-------------------|
| Pure functions | Side effects (DB, HTTP) |
| Validation logic | Specific business scenarios |
| Parsers/serializers | Integration flows |
| Mathematical properties | Small enumerable cases |

## Property Patterns

### Invariants
Properties that must always hold true.

```java
@Property
void orderTotalAlwaysEqualsLineSum(@ForAll("orders") Order order) {
    var lineSum = order.lines().stream()
        .map(OrderLine::total)
        .reduce(Money.ZERO, Money::add);
    assertThat(order.total()).isEqualTo(lineSum);
}

@Property
void discountNeverExceedsSubtotal(@ForAll("orders") Order order,
                                   @ForAll CustomerTier tier) {
    var discount = PricingRules.calculateDiscount(order, tier);
    assertThat(discount).isLessThanOrEqualTo(order.total());
}
```

### Round-Trip / Symmetry
Operations that cancel each other.

```java
@Property
void serializeDeserializeIsIdentity(@ForAll("orders") Order order) {
    var json = mapper.writeValueAsString(order);
    var restored = mapper.readValue(json, Order.class);
    assertThat(restored).isEqualTo(order);
}
```

### Idempotence
Repeatable operations yield same result.

```java
@Property
void normalizationIsIdempotent(@ForAll String input) {
    var once = StringUtils.normalize(input);
    var twice = StringUtils.normalize(once);
    assertThat(twice).isEqualTo(once);
}
```

### Commutativity
Order-independent operations.
- "Add items in any order = same total"

## Custom Arbitraries
```java
@Provide
Arbitrary<Order> orders() {
    return Combinators.combine(
        Arbitraries.longs().map(OrderId::new),
        Arbitraries.longs().map(CustomerId::new),
        Arbitraries.lists(orderLines()).ofMinSize(1).ofMaxSize(10),
        Arbitraries.longs().map(Instant::ofEpochMilli)
    ).as(Order::new);
}

@Provide
Arbitrary<OrderLine> orderLines() {
    return Combinators.combine(
        Arbitraries.longs().map(ProductId::new),
        Arbitraries.integers().between(1, 100),
        Arbitraries.integers().between(1, 10000).map(Money::ofCents)
    ).as(OrderLine::new);
}

@Provide
Arbitrary<String> danishCprs() {
    return Combinators.combine(
        Arbitraries.integers().between(1, 31),
        Arbitraries.integers().between(1, 12),
        Arbitraries.integers().between(0, 99),
        Arbitraries.integers().between(0, 9999)
    ).as((d, m, y, s) -> String.format("%02d%02d%02d-%04d", d, m, y, s));
}
```

## Identify Properties in Your Code

1. **Invariants**: Always true
   - "Total price = sum of line items"
   - "End date > start date"

2. **Inverse Operations**: Cancel each other
   - "serialize -> deserialize = identity"

3. **Idempotence**: Repeatable safely
   - "Apply discount twice = apply once"

4. **Commutativity**: Order-independent
   - "Add items in any order = same total"
