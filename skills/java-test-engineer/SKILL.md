---
name: java-test-engineer
version: 1.0.0
description: "This skill should be used when the user asks to 'write unit tests', 'add integration tests', 'test this Java code', 'add jqwik property tests', 'fix failing test', 'improve test coverage', 'add Spring Boot tests', 'add Testcontainers test', or needs guidance on JUnit 5, jqwik property testing, AssertJ, Mockito, Testcontainers, WireMock, or Spring Boot test slices for Java/Spring Boot applications. NOT for writing production code, build configuration, or deployment."
---

# Java Test Engineer Skill

Expert guidance for writing, reviewing, and fixing tests in Java/Spring Boot applications. Prioritizes property-based and integration tests over heavy mocking.

---

## Workflow

### Step 1: Determine What to Test

| What you have | Test type | Tool |
|---------------|-----------|------|
| Pure function, value object, parser | Property test | jqwik |
| Sealed type / discriminated union handler | Property test + example test | jqwik + JUnit 5 |
| Domain service (functional core) | Unit test, no mocks | JUnit 5 + AssertJ |
| Repository / JPA entity | Slice test | `@DataJpaTest` + Testcontainers |
| REST controller | Slice test | `@WebMvcTest` + MockMvc |
| Full HTTP flow | Integration test | `@SpringBootTest` + Testcontainers |
| Outbound HTTP client | Integration test | WireMock |
| Critical end-to-end flow | E2E test | `@SpringBootTest(webEnvironment=RANDOM_PORT)` + RestAssured |

### Step 2: Apply Core Principles

1. **Test pyramid**: 70% unit (functional core, no Spring), 20% slice/integration, 10% full E2E.
2. **Real over mocked**: Use real implementations for pure domain code. Reach for Testcontainers (Postgres, Kafka, Redis) instead of in-memory fakes — they catch real schema/index/migration bugs.
3. **Test behavior, not implementation**: Assert on outputs and observable side effects (rows in DB, messages on topic), not on which methods were called. Mockito `verify(...)` is a smell unless asserting an interaction is the point.
4. **Property tests > example tests** for pure functions, parsers, validators, state transitions, and any code with mathematical invariants.
5. **Functional core has zero `@SpringBootTest`**: If you need Spring context to test domain logic, the design has leaked I/O into the core — fix the design, not the test.

### Step 3: Write the Test

Pick the right base based on the unit under test (UUT):

- **Pure UUT** → plain JUnit 5, no annotations beyond `@Test`/`@Property`. Fast, no context.
- **JPA repository** → `@DataJpaTest` + Testcontainers Postgres. Real SQL, real migrations.
- **REST controller** → `@WebMvcTest(SomeController.class)` with `@MockBean` only for direct collaborators, asserting on `MockMvc` response.
- **Outbound port** → integration test with WireMock binding the real client to a stub server.
- **Cross-cutting flow** → `@SpringBootTest` + Testcontainers, hit the HTTP API.

---

## Property-Based Testing (jqwik)

Property tests find edge cases automatically. Use for pure functions and type transformations.

### When to Use

| Use Property Tests | Use Example Tests |
|-------------------|-------------------|
| Pure functions | Side effects (DB, HTTP) |
| Validation logic | Specific business scenarios |
| Parsers/serializers | Small enumerable cases |
| State transitions | Integration flows |
| Mathematical invariants | Visual/UI assertions |

### Common Patterns

#### 1. Invariants — "This should always be true"

```java
@Property
void totalAlwaysEqualsLineSum(@ForAll("orders") Order order) {
    var lineSum = order.lines().stream()
        .map(OrderLine::total)
        .reduce(Money.ZERO, Money::add);
    assertThat(order.total()).isEqualTo(lineSum);
}
```

#### 2. Round-Trip / Symmetry

```java
@Property
void serializeDeserializeIsIdentity(@ForAll("orders") Order order) throws Exception {
    var json = mapper.writeValueAsString(order);
    var restored = mapper.readValue(json, Order.class);
    assertThat(restored).isEqualTo(order);
}
```

#### 3. Idempotence

```java
@Property
void normalizationIsIdempotent(@ForAll String input) {
    var once = StringUtils.normalize(input);
    var twice = StringUtils.normalize(once);
    assertThat(twice).isEqualTo(once);
}
```

#### 4. Commutativity

```java
@Property
void mergeOrderDoesNotMatter(@ForAll("configs") Config a, @ForAll("configs") Config b) {
    assertThat(merge(a, b)).isEqualTo(merge(b, a));
}
```

### Custom Arbitraries

```java
@Provide
Arbitrary<Order> orders() {
    return Combinators.combine(
        Arbitraries.longs().map(OrderId::new),
        Arbitraries.longs().map(CustomerId::new),
        Arbitraries.lists(orderLines()).ofMinSize(1).ofMaxSize(10)
    ).as(Order::new);
}
```

### Sealed Types / Discriminated Unions

```java
@Provide
Arbitrary<Result<String, Error>> results() {
    return Arbitraries.oneOf(
        Arbitraries.strings().map(Result::ok),
        Arbitraries.of(Error.values()).map(Result::err)
    );
}

@Property
void handleResultNeverThrows(@ForAll("results") Result<String, Error> result) {
    assertThatCode(() -> handler.handle(result)).doesNotThrowAnyException();
}
```

See `${CLAUDE_PLUGIN_ROOT}/rules/property-testing.md` for the full jqwik pattern catalog.

---

## Integration Tests with Testcontainers

For anything touching a real DB, queue, or cache, use Testcontainers. In-memory replacements (H2, embedded Kafka) lie about behavior.

```java
@SpringBootTest
@Testcontainers
class OrderRepositoryIT {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    @Autowired OrderRepository repo;

    @Test
    void persistsAndReadsOrder() {
        var saved = repo.save(anOrder());
        assertThat(repo.findById(saved.id())).contains(saved);
    }
}
```

**Reuse containers across tests** with `withReuse(true)` + `~/.testcontainers.properties` `testcontainers.reuse.enable=true` to keep CI/local fast.

---

## Spring Boot Test Slices

| Slice | Loads | When to use |
|-------|-------|-------------|
| `@DataJpaTest` | JPA, repositories, entity manager | Repository/SQL tests |
| `@WebMvcTest` | MVC stack, controllers, filters | Controller/HTTP-shape tests |
| `@JsonTest` | Jackson config | Serialization/deserialization tests |
| `@RestClientTest` | RestTemplate/WebClient + MockRestServiceServer | Outbound HTTP client tests |
| `@SpringBootTest` | Full context | Cross-cutting integration |

Prefer the narrowest slice that proves the test. Full `@SpringBootTest` is slow — use sparingly.

---

## Mocking Discipline

Mockito is a tool, not a default. Use it only when:
- The collaborator is a **port to the outside world** (HTTP client, message publisher) AND a slice/integration test would be disproportionate effort.
- You need to **simulate failure modes** (timeout, 500) that are hard to trigger otherwise.

Do NOT mock:
- Value objects, records, sealed types — instantiate them.
- Pure domain services — call them directly.
- Repositories in service tests — use `@DataJpaTest` with Testcontainers, or test the service against an in-memory port implementation.

```java
// BAD: mocking domain logic
when(pricingService.calculateTotal(any())).thenReturn(Money.ofCents(100));

// GOOD: use the real domain service, test the orchestrator's behavior
var orchestrator = new OrderOrchestrator(new PricingService(rules), repo);
```

---

## Anti-Patterns

```java
// BAD: testing through Mockito.verify when output assertion would do
verify(repo).save(any());
// GOOD: assert on observable state
assertThat(repo.findById(id)).isPresent();

// BAD: in-memory DB pretending to be Postgres
@AutoConfigureTestDatabase(replace = ANY)  // H2
// GOOD: real engine via Testcontainers

// BAD: @SpringBootTest for a pure function
@SpringBootTest
class CalculatorTest { ... }
// GOOD: plain JUnit
class CalculatorTest { ... }

// BAD: arbitrary sleep
Thread.sleep(1000);
// GOOD: Awaitility
await().atMost(5, SECONDS).untilAsserted(() -> assertThat(...).isPresent());

// BAD: @MockBean cascade for indirect collaborators
@MockBean A; @MockBean B; @MockBean C;
// GOOD: smaller slice, or restructure the controller's dependencies
```

---

## Checklist

- [ ] Test name describes behavior, not implementation
- [ ] Functional-core tests have NO Spring, NO Mockito, NO `@Autowired`
- [ ] Property tests cover pure functions with invariants
- [ ] Integration tests use Testcontainers, not H2/embedded fakes
- [ ] Slice tests use the narrowest slice that proves the test
- [ ] Assertions on observable state, not Mockito `verify` (unless interaction IS the contract)
- [ ] No `Thread.sleep` — use Awaitility for async waits
- [ ] AssertJ fluent chains, not raw `assertEquals`
- [ ] Test data via `@Provide` arbitraries or focused factories — not big shared fixtures

---

## Constraints

- Prefer property tests over example tests for pure functions
- Use AssertJ (`assertThat`) over JUnit's `assertEquals`
- Use Testcontainers for any test touching infrastructure
- Use Awaitility for async assertions, never `Thread.sleep`
- Mock only at the outer edge of the system (ports/clients), never domain logic
- Tests in the functional core run without a Spring context

---

## See Also

- `${CLAUDE_PLUGIN_ROOT}/rules/java-patterns.md` — records, sealed types, Either, railway-oriented programming
- `${CLAUDE_PLUGIN_ROOT}/rules/property-testing.md` — jqwik invariants and arbitraries
- `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` — functional core / imperative shell
