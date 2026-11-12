# Architecture Interview

The questionnaire the architecture phase runs before any design work. The architecture agent runs it in standard mode and the panel interviewer runs it in `/loom --panel`, so both modes ask the same questions.

## How to ask

- Read the spec and explore the codebase first, so each question can name the files, modules and patterns you found.
- Ask with `AskUserQuestion`, up to 4 related questions per call, multiple choice where possible. Under Pi, Loom relays the tool to the parent TUI while your Agent turn stays alive. Never print a question as plain text and never invent an answer.
- Ask every topic; skip one only when the spec or codebase answers it explicitly.
- Group topics that belong together (testability with error handling; data model with concurrency).

## Topics

1. **Codebase constraints.** Name the specific files, modules and patterns you found. Ask which to conform to, which to extend, and which are off-limits.
2. **Testability bar.** Pure functional core (90%+ unit-testable without mocks), pragmatic mix (mocks at boundaries are fine), or integration-first (real systems wherever possible).
3. **Primary optimization axis.** Simplicity, performance, extensibility, shipping speed or operational cost. Get one primary axis; secondary axes may be listed, but the primary decides trade-offs.
4. **Concurrency and state model.** Stateless per request, in-memory, persistent or distributed state; synchronous or asynchronous processing; real-time or eventual consistency.
5. **Data model and persistence.** New tables or collections, or reuse; migration strategy; retention.
6. **Sensitive boundaries.** Trust and security boundaries the design crosses: auth, external APIs, sensitive data, file uploads, command execution, deserialization. If any is in play, say so; the design should then be checked with the `security-expert` skill.
7. **Tech preferences.** Libraries, frameworks and patterns the user prefers or wants avoided, beyond what the codebase already uses.
8. **Observability.** Logging level, metrics, tracing, audit events, failure visibility.
9. **Error-handling philosophy.** Either/Result types end to end, exceptions at boundaries, or a pragmatic mix; retry and backoff strategy.
10. **Backwards compatibility and migration.** Greenfield, brownfield extension or rewrite; in-flight users or data to preserve; feature-flag rollout.
11. **Deployment and environments.** Anything in the design that affects how it ships: build, runtime, infrastructure dependencies, environment configuration.
12. **Out-of-scope architecture concerns.** What the user wants kept out of this design (multi-tenancy, i18n, advanced caching, and so on).
13. **Executable models.** Ask only when exploration surfaced one.
    - A real domain lifecycle (order, payment, subscription, document workflow): confirm it should be modeled as a statechart or typed reducer that the implementation imports.
    - A real multi-stage pipeline in a project that already uses fugue: ask whether to model it as an `AuthoredDag`. This question is the only place the fugue bridge is opted into. If the project does not use fugue, do not ask and do not model a pipeline.
