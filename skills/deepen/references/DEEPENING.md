# Deepening

How to deepen a cluster of shallow modules safely, given its dependencies. Uses the vocabulary in [LANGUAGE.md](LANGUAGE.md) and the FC/IS and port patterns from `rules/architecture.md`.

## Dependency Categories

Classify the candidate's dependencies. The category decides where the seam goes and how the deepened module is tested across it.

### 1. In-Process (Pure)

Pure computation, in-memory state, no I/O. Always deepenable: merge the shallow pure functions into a deeper one and test it through the new interface with plain data. No adapter, no mocks. This is functional core code.

### 2. Local-Substitutable

A real-engine test stand-in exists (Testcontainers Postgres or Redis, real SQLite). The seam is the port interface. Integration tests run the real adapter against the stand-in; unit tests of the shell orchestrator use the port's in-memory fake.

Use Testcontainers rather than H2, PGLite or other in-process substitutes for repository and infrastructure tests: the substitutes lie about schema, index and migration behavior.

### 3. Own Services Across a Network (Port/Adapter)

Your own services behind a network call (microservices, internal APIs). Define a port at the seam, domain-typed and owned by the consumer. The deep module owns the logic; the transport is an injected adapter (HTTP, gRPC, queue). The in-memory fake ships with the port.

### 4. True External (Fake)

Third-party services you don't control (Stripe, Twilio). Same port shape as category 3. Unit tests use an in-memory fake that implements the port; integration tests verify the real HTTP contract with WireMock (Java) or MSW (TypeScript). No mocking framework.

## Seam Discipline

- A port needs two adapters to be a real seam (see "Principles" in LANGUAGE.md). Production plus a test fake is the usual pair.
- A deep module can have internal seams, private to its implementation and used by its own tests, as well as the external seam at its interface. Don't expose an internal seam through the interface just because tests use it.

## Testing Strategy: Replace, Don't Layer

- Old unit tests on the shallow modules become waste once tests at the deepened module's interface exist. Delete them.
- Write the new tests at the deepened module's interface. They assert on observable outcomes, not internal state.
- If a test has to change when the implementation changes, it is testing past the interface.
- Pure core deepenings: property tests on invariants (jqwik / fast-check).
- Port deepenings: in-memory fake for unit tests, Testcontainers for integration.
