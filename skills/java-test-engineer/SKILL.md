---
name: java-test-engineer
version: 1.0.0
description: "Java/Spring Boot tests: JUnit 5, jqwik property tests, AssertJ, Testcontainers, WireMock, Spring Boot test slices. Use to write, fix or extend Java tests. Not for TypeScript tests (ts-test-engineer), production code or build configuration."
---

# Java Test Engineer

How to write, review and fix tests in Java/Spring Boot applications. Property tests and real infrastructure come before mocking. When to reach for a property and which kinds exist is in `${CLAUDE_PLUGIN_ROOT}/rules/property-testing.md`; this skill owns the jqwik code.

## Step 1: Determine What to Test

| What you have | Test type | Tool |
|---------------|-----------|------|
| Pure function, value object, parser | Property test | jqwik |
| Sealed type / discriminated union handler | Property test + example test | jqwik + JUnit 5 |
| Domain service (functional core) | Unit test, no mocks | JUnit 5 + AssertJ |
| Shell orchestrator | Unit test with in-memory port fakes | JUnit 5 + AssertJ, no Spring |
| Repository / JPA entity | Slice test | `@DataJpaTest` + Testcontainers |
| REST controller | Slice test | `@WebMvcTest` + MockMvc |
| Full HTTP flow | Integration test | `@SpringBootTest` + Testcontainers |
| Outbound HTTP client | Integration test | WireMock |
| Critical end-to-end flow | E2E test | `@SpringBootTest(webEnvironment=RANDOM_PORT)` + RestAssured |

## Step 2: Apply Core Principles

1. **Test pyramid**: about 70% unit (functional core and orchestrators over fakes, no Spring), 20% slice/integration, 10% full E2E.
2. **Real over mocked**: real implementations for pure domain code; Testcontainers (Postgres, Kafka, Redis) instead of in-memory *databases* such as H2, which hide schema, index and migration bugs. In-memory *port fakes* remain the tool for orchestrator unit tests.
3. **Behavior, not implementation**: assert on outputs and observable effects (rows in the database, messages on a topic, what the fake recorded), not on which methods were called.
4. **Properties before examples** for pure functions, parsers, validators and state transitions.
5. **No Spring in the functional core**: if testing domain logic needs a Spring context, I/O has leaked into the core. Fix the design, not the test.

## Step 3: Write the Test

- **Pure code** → plain JUnit 5 or jqwik, nothing beyond `@Test` / `@Property`.
- **Shell orchestrator** → plain JUnit 5; construct it with the in-memory fakes that ship with its ports and a fixed `Clock`.
- **JPA repository** → `@DataJpaTest` against Testcontainers Postgres: real SQL, real migrations.
- **REST controller** → `@WebMvcTest(SomeController.class)`, asserting on the `MockMvc` response. Give the controller its real orchestrator over port fakes from a `@TestConfiguration`.
- **Outbound adapter** → the real client bound to a WireMock server.
- **Cross-cutting flow** → `@SpringBootTest` + Testcontainers, through the HTTP API.

## Property-Based Testing (jqwik)

A property states a fact about the result that does not repeat the implementation. If the assertion recomputes what the function computes, it proves nothing.

```java
// Invariant
@Property
void discountNeverExceedsSubtotal(@ForAll("orders") Order order, @ForAll CustomerTier tier) {
    assertThat(PricingRules.discount(order, tier)).isLessThanOrEqualTo(order.subtotal());
}

// Round trip
@Property
void serializeThenDeserializeIsIdentity(@ForAll("orders") Order order) throws Exception {
    var restored = mapper.readValue(mapper.writeValueAsString(order), Order.class);
    assertThat(restored).isEqualTo(order);
}

// Idempotence: f(f(x)) = f(x). True of normalisers; not of a percentage discount.
@Property
void normalizationIsIdempotent(@ForAll String input) {
    var once = Emails.normalize(input);
    assertThat(Emails.normalize(once)).isEqualTo(once);
}

// Total handler over a sealed type
@Property
void everyPaymentResultHasAMessage(@ForAll("paymentResults") PaymentResult result) {
    assertThat(Receipts.messageFor(result)).isNotBlank();
}
```

Generators build valid domain values from parts:

```java
@Provide
Arbitrary<Order> orders() {
    return Combinators.combine(
        Arbitraries.longs().greaterOrEqual(1).map(OrderId::new),
        Arbitraries.longs().greaterOrEqual(1).map(CustomerId::new),
        orderLines().list().ofMinSize(1).ofMaxSize(10)
    ).as(Order::new);
}

@Provide
Arbitrary<PaymentResult> paymentResults() {
    return Arbitraries.oneOf(
        Arbitraries.strings().alpha().ofMinLength(1).map(PaymentResult.Succeeded::new),
        Arbitraries.of(DeclineReason.values()).map(PaymentResult.Declined::new));
}
```

### Idempotency of an effect (model-based)

Idempotency is a different claim from idempotence: a command that arrives many times changes the world once and gets one answer. Test it through the orchestrator with a counting fake at the port, over generated sequences of retries and failures.

```java
enum Step { RETRY, CRASH_AFTER_PSP, TIMEOUT }

@Property
void atMostOneChargeAcrossRetries(@ForAll @Size(min = 1, max = 20) List<Step> steps) {
    var psp = new CountingFakePsp();            // counts charges per idempotency key, replays the first outcome
    var attempts = new InMemoryAttemptStore();  // port fake: claim and settle
    var charge = new ChargeOrchestrator(attempts, psp);
    var command = aChargeCommand();             // one merchant and one key for the whole run
    var completed = new HashSet<Outcome>();

    for (Step step : steps) {
        psp.behaveOnNextCall(step);             // CRASH_AFTER_PSP: charge, then throw; TIMEOUT: outcome unknown
        try {
            charge.execute(command).peek(completed::add);  // your Either's right-side hook
        } catch (SimulatedCrash crash) {
            // the process died between the PSP call and settle; the next step is the retry
        }
    }

    assertThat(psp.chargesFor(command.key())).isLessThanOrEqualTo(1);
    assertThat(completed).hasSizeLessThanOrEqualTo(1);   // every completed call returned the same outcome
}
```

Add two example tests beside it: N parallel calls with one key produce one charge, and the same key under two merchants produces two independent attempts.

## Repository Tests with Testcontainers

```java
@TestConfiguration(proxyBeanMethods = false)
class Containers {
    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgres() {
        return new PostgreSQLContainer<>("postgres:16");
    }
}

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@Import(Containers.class)
class OrderRepositoryIT {

    @Autowired OrderRepository repo;

    @Test
    void persistsAndReadsOrder() {
        var saved = repo.save(anOrder());
        assertThat(repo.findById(saved.id())).contains(saved);
    }
}
```

- `@ServiceConnection` (Spring Boot 3.1+) supplies the connection details; no `@DynamicPropertySource` is needed.
- The container is a bean, so every test class that shares the cached Spring context shares one container. That is the way to keep the suite fast locally and in CI. `withReuse(true)` is a local-only convenience and does nothing for a container managed by `@Container`.

## Spring Boot Test Slices

| Slice | Loads | When to use |
|-------|-------|-------------|
| `@DataJpaTest` | JPA, repositories, entity manager | Repository/SQL tests |
| `@WebMvcTest` | MVC stack, controllers, filters | Controller/HTTP-shape tests |
| `@JsonTest` | Jackson config | Serialization/deserialization tests |
| `@RestClientTest` | `RestClient` / `RestTemplate` + `MockRestServiceServer` | Outbound client built on those two. Not `WebClient`: use WireMock |
| `@SpringBootTest` | Full context | Cross-cutting integration |

Use the narrowest slice that proves the test.

## Mocking Discipline

Substitute behavior at ports with the in-memory fake that ships with the port. Mockito is for one case: a third-party type you cannot fake and cannot reach through a port. Failure modes (timeout, 500) are a fake that fails on demand or a WireMock stub, not a mock.

Do not mock:
- Value objects, records, sealed types — instantiate them.
- Pure domain functions — call them.
- Repositories — `@DataJpaTest` with Testcontainers for the adapter, the in-memory port fake for the orchestrator.

```java
// BAD: mocking domain logic
when(pricing.calculateTotal(any())).thenReturn(Money.ofCents(100));

// GOOD: real pure core, fake port, assert on what the fake holds
var orders = new InMemoryOrderRepository();
var orchestrator = new SubmitOrderOrchestrator(orders, Clock.fixed(NOW, ZoneOffset.UTC));
```

If a Spring test does replace a bean with a mock, the annotation is `@MockitoBean`; `@MockBean` is deprecated since Spring Boot 3.4 and removed in 4.0.

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

// BAD: a mock for every indirect collaborator
@MockitoBean A a; @MockitoBean B b; @MockitoBean C c;
// GOOD: smaller slice, or restructure the controller's dependencies
```

## Checklist

- [ ] Test name describes behavior, not implementation
- [ ] A test for a claimed Acceptance Scenario starts its display name with the identifier: `@DisplayName("AS-004: rejects a stale cursor")`. `/spec-check` links scenarios to tests only by this prefix
- [ ] Functional-core and orchestrator tests have no Spring, no Mockito, no `@Autowired`
- [ ] Pure functions with invariants have property tests; a retried effect has the model-based property
- [ ] Anything touching infrastructure runs against Testcontainers, in the narrowest slice
- [ ] Async waits use Awaitility
- [ ] AssertJ fluent chains, not raw `assertEquals`
- [ ] Test data from `@Provide` arbitraries or focused factories, not big shared fixtures
