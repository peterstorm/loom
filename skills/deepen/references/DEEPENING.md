# Deepening

How to deepen a cluster of shallow modules safely, given its dependencies. Uses the vocabulary in [LANGUAGE.md](LANGUAGE.md) and the FC/IS + port patterns from `rules/architecture.md`.

## Dependency Categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-Process (Pure)

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test through the new interface directly. No adapter needed.

**In our model:** This is functional core code. Merge shallow pure functions into a deeper pure function. Test with plain data, no mocks.

### 2. Local-Substitutable

Dependencies where a real-engine test stand-in exists (Testcontainers Postgres, Testcontainers Redis, real SQLite). Deepenable when the stand-in catches the same bugs as production. The seam is the port interface; the stand-in is an adapter used in integration tests.

**In our model:** Use Testcontainers (not H2/PGLite/embedded fakes) for repository and infrastructure tests — in-process substitutes lie about schema, index, and migration behavior. The port interface is the seam; the Testcontainers-backed adapter is used in integration tests, the in-memory fake is used in unit tests of the shell orchestrator.

### 3. Own Services Across Network (Port/Adapter)

Your own services across a network boundary (microservices, internal APIs). Define a **port** at the seam. The deep module owns the logic; the transport is injected as an **adapter**. Tests use an in-memory adapter. Production uses an HTTP/gRPC/queue adapter.

**In our model:** This is exactly our port pattern. The port is domain-typed, owned by the consumer. The adapter adapts the vendor/transport to it. In-memory fake ships with the port for tests.

### 4. True External (Fake)

Third-party services (Stripe, Twilio, etc.) you don't control. The deepened module takes the external dependency as an injected port; tests provide a fake adapter.

**In our model:** Same as port pattern. The port is domain-typed. For unit tests, use an in-memory fake. For integration tests, use WireMock (Java) or MSW (TypeScript) to verify real HTTP contract. No mocking frameworks — plain fakes that implement the port interface.

## Seam Discipline

- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a port unless at least two adapters are justified (typically production + test fake). This is already in our architecture rules: "skip the port and call the concrete thing" unless a real fake exists.

- **Internal seams vs external seams.** A deep module can have internal seams (private to its implementation, used by its own tests) as well as the external seam at its interface. Don't expose internal seams through the interface just because tests use them.

## Testing Strategy: Replace, Don't Layer

- Old unit tests on shallow modules become waste once tests at the deepened module's interface exist — **delete them**.
- Write new tests at the deepened module's interface. The **interface is the test surface**.
- Tests assert on observable outcomes through the interface, not internal state.
- Tests should survive internal refactors — they describe behaviour, not implementation.
- For pure core deepenings: property tests on invariants (jqwik / fast-check).
- For port deepenings: in-memory fake for unit tests, Testcontainers for integration.
- If a test has to change when the implementation changes, it's testing past the interface.
