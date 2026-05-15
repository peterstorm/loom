# Deepening

How to deepen a cluster of shallow modules safely, given its dependencies. Uses the vocabulary in [LANGUAGE.md](LANGUAGE.md) and the FC/IS + port patterns from `rules/architecture.md`.

## Dependency Categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-Process (Pure)

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test through the new interface directly. No adapter needed.

**In our model:** This is functional core code. Merge shallow pure functions into a deeper pure function. Test with plain data, no mocks.

### 2. Local-Substitutable

Dependencies that have local test stand-ins (PGLite for Postgres, in-memory filesystem, embedded Redis). Deepenable if the stand-in exists. The deepened module is tested with the stand-in running in the test suite. The seam is internal; no port at the module's external interface.

**In our model:** Use Testcontainers (not H2/embedded fakes) for repository tests. The seam is the port interface; the Testcontainers adapter is used in integration tests.

### 3. Own Services Across Network (Port/Adapter)

Your own services across a network boundary (microservices, internal APIs). Define a **port** at the seam. The deep module owns the logic; the transport is injected as an **adapter**. Tests use an in-memory adapter. Production uses an HTTP/gRPC/queue adapter.

**In our model:** This is exactly our port pattern. The port is domain-typed, owned by the consumer. The adapter adapts the vendor/transport to it. In-memory fake ships with the port for tests.

### 4. True External (Mock)

Third-party services (Stripe, Twilio, etc.) you don't control. The deepened module takes the external dependency as an injected port; tests provide a mock/fake adapter.

**In our model:** Same as port pattern, but the adapter may need WireMock or MSW for integration tests alongside the in-memory fake.

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
