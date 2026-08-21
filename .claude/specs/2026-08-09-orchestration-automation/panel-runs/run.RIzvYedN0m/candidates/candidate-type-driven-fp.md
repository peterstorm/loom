# Candidate: type-driven-fp

## Approach summary
Model each Loom flow as its own closed, immutable program ADT and total reducer, executed by a persistent Fugue `Machine`/`JobLike` shell. Use Fugue's shipped static DAG runtime for deterministic preparation, publication, aggregation, conditional routing, and staging; semantic Agent fan-out remains an explicit engine-issued `SpawnBatch` because Fugue has no Agent-call or dynamic-fan-out node.

## Component boundaries

**Typed orchestration kernel (pure shared kernel)**
- Add branded `OrchestrationRunId`, `RequestId`, `SlotId`, `ContextDigest`, `ArtifactDigest`, `RepositoryPath`, and harness reservation identities. Raw strings and paths enter programs only through smart constructors.
- Represent slots as `PendingFirstAttempt | PendingFinalAttempt | Accepted`. A second failure moves the whole program to `TerminalBlocked`; an exhausted slot cannot inhabit a running state. `ExactRoster<Slot>` and `CompleteRoster<AcceptedResult>` are parser-produced proofs, and aggregate/tally states require `CompleteRoster`, making partial aggregation unrepresentable.
- Bind every `AgentRequestAuthority` to run, role, canonical slot, attempt, context digest, output artifact, Skill digest, LLM Profile, and both exact harness bindings. Completion submits only `RequestId` plus raw bytes; lens, criterion, Finding, model, and destination come from authority. Contradictory result prose is rejected.
- Use a closed `BlockedReason` union carrying failure category, run, optional request/slot, retry eligibility, and one typed recovery action.

**Separate domain programs (pure functional core)**
- `ArchitectureProgram`, `RefutationProgram`, `WaveGateProgram`, `StandaloneReviewProgram`, and `RemediationProgram` each own distinct `State`, `Event`, `ExternalAction`, and `ProgramError` unions. They do not instantiate a generic workflow language.
- Each exports a total `reduce(state, event) -> Either<ProgramError, Transition<State, InternalEffect, ExternalAction>>`, exhaustively matched with `ts-pattern`. `Done` and `TerminalBlocked` reject every later event without mutation.
- Architecture and refutation retain disjoint design-lens/refutation-lens types and reducers. Only request envelopes, exact-slot conservation, receipts, and persistence mechanics remain shared in `panel-kernel.ts`.
- `WaveGateProgram` owns implementation/test/spec/review readiness, atomic review preparation, exact retries, critical-Finding routing, advisory decisions, and final completion. `StandaloneReviewProgram` owns frozen scope, roster/model/context authority, transcript acceptance, aggregation, optional refutation, and result publication without ever receiving a State File capability.
- `RemediationProgram` models `AuthorityFrozen -> PathsRegistered -> Audited -> Staged -> Verified`; only `AuditedPathSet` can reach staging, and only a verified temporary index can replace the real index.

**Explicit effect and persistence runtime (imperative shell)**
- Internal effects are immutable data (`ReadAuthority`, `RunDeterministicDag`, `PublishArtifactSet`, `CommitProtectedState`, `CaptureRawTranscript`, `AuditGitIndex`), each with a stable `EffectId` and typed receipt. The shell executes an effect and feeds its receipt back; reducers never call filesystem, Git, clock, randomness, process, or harness APIs.
- Adapt each reducer to Fugue's public `Machine<State, Event, Context>`. States awaiting Agent results or a user decision are durable halted states. Loom `TerminalBlocked` is a persisted domain terminal, not Fugue's uncheckpointed runtime-failure state.
- Implement `RunDirectoryJobLike` over existing no-follow JSON storage: immutable deduplicated events are authority, atomic snapshots are projections, and recovery uses Fugue `replayEvents`. `WaveGateJobLike.updateData` delegates protected mutations exclusively to `StateManager` under its existing lock.
- Write and byte-verify content-addressed artifacts before one commit record makes them authoritative. Wave requests become spawnable only in the `StateManager` transaction registering every packet, context, and request digest. Interrupted uncommitted sets are not authority.
- Spawn actions are safely redeliverable descriptors: persisted `RequestId` is a one-use harness reservation key, so Pi and Claude Code reject duplicate execution while resume omits accepted slots.

**Fugue deterministic pipelines (static, domain-specific DAGs)**
- Pin the evaluated local public API, `@fuguejs/framework` 0.4.0, and define separate static DAGs with `defineDag`; do not generate a generic Loom DSL.
- Architecture/refutation operation DAGs use pure transform nodes for manifest/context/verdict parsing, static fan-out/fan-in for independent artifact preparation, conditional edges for readiness, and deterministic aggregate/tally nodes.
- The Wave Gate DAG fans out spec-check request preparation, Review Packet-set construction, model binding, and context construction, then joins at one atomic publication node. Task-count-dependent work stays inside an immutable `NonEmpty<PreparedPacket>` value rather than pretending Fugue supports dynamic fan-out.
- The standalone DAG routes explicit scope versus changed-path-union derivation, joins Git metadata with deterministic roster/model/context preparation, and later routes a complete aggregate to clean finalization or Refutation Panel preparation.
- The remediation DAG performs authority load, Git inspection, pure set audit, temporary-index staging, and exact staged-set verification. Validation/authority errors are non-retriable; only classified transient I/O uses Fugue's bounded idempotent node retry.
- Fugue `JobLike`, replay, pure state-machine transitions, conditional/default edges, fan-out/fan-in waves, durable halt semantics, capability declarations, and tracing are production mechanisms. A local in-process `CapabilityBroker` issues run/root-scoped handles such as `loom:run-read`, `loom:artifact-publish`, `loom:git-read`, `loom:index-commit`, and `loom:protected-state-commit`; only the last adapter can call `StateManager`.
- No design assumes Fugue Agent-call nodes, nested subgraphs, bounded back-edges, or dynamic fan-out. Semantic batches are emitted values, the single semantic retry is reducer state, and the shell composes separate programs without fake nested DAGs.

**Harness anti-corruption layer**
- Extend Pi reservations and Claude Code SubagentStop registration to map native parent/tool/child identities to one `RequestId` before spawn. Positional or caller-repeated lens/criterion identity has no authority.
- Carry output as `Uint8Array` from harness boundary to an exclusive no-follow transcript slot. Hash and re-read bytes before acceptance; semantic JSON parsing creates separate canonical evidence without changing raw evidence. Agent prose never enters a shell command.
- Context packets contain complete fixed and variable instructions, Skill/output contracts, packet/manifest material, and request identity. Spawn payloads carry only a digest-bound reference and exact harness binding.

**Canonical status/read model**
- `deriveLoomStatus(parsedTaskGraph, parsedActiveProgram)` is a pure projection over the same readiness functions and program state. Its closed `NextAction` union has exactly one value for each valid state; malformed or contradictory authority parses to `Blocked`.
- Trace projection combines immutable events, Fugue spans, request-result bindings, rejected evidence, retries, publications, Finding dispositions, and terminal decisions without becoming authority.

## Data flow

1. Parse a CLI/harness request from `unknown`; scope, paths, run identity, model/Skill bindings, and disk JSON must earn domain types.
2. Load one aggregate, invoke its pure reducer, persist the event through `JobLike`, and execute only its typed internal effect. Fugue runs deterministic DAGs with explicit clock/RNG/id inputs and capability-scoped ports.
3. Preparation computes every packet, context, slot, binding, and artifact immutably. Stage and verify all files, then commit the complete set before halting with one external `SpawnBatch`.
4. The parent executes that batch unchanged. The harness resolves completion identity to `RequestId`, writes untouched bytes directly to the slot, verifies run/Agent/reservation/context/attempt, and submits `ResultAccepted` or `ResultRejected`.
5. Results may arrive in any order. Canonical slot order determines state; partial completion emits nothing, first failure emits only that slot's final attempt, and second failure blocks monotonically.
6. `CompleteRoster` unlocks Fugue aggregate/tally. Conditional routing skips an empty Refutation Panel, starts the separate Refutation Program for criticals, or halts for typed user advisory triage.
7. Wave completion commits through `StateManager`; standalone completion commits only within its Run Directory. Status reuses the same event replay and readiness derivation.
8. Remediation snapshots authority and index digest, audits all dirty/staged paths, stages additions/modifications/renames/deletions into a temporary index using argv/NUL pathspecs, verifies exact set equality and excludes Run Directory paths, then compare-and-swaps the index. Failure leaves index and worktree unchanged.

## File-structure sketch

```text
engine/
├── package.json
├── src/core/
│   ├── panel-kernel.ts
│   ├── panel-program.ts                 # compatibility facade
│   ├── review-panel.ts
│   ├── standalone-review.ts
│   └── orchestration/
│       ├── identity.ts
│       ├── authority.ts
│       ├── slots.ts
│       ├── errors.ts
│       ├── effects.ts
│       ├── architecture-program.ts
│       ├── refutation-program.ts
│       ├── wave-gate-program.ts
│       ├── standalone-review-program.ts
│       ├── remediation-program.ts
│       ├── readiness.ts
│       └── status.ts
├── src/orchestrator/
│   ├── resume-program.ts
│   ├── accept-agent-result.ts
│   ├── context-packets.ts
│   └── remediation-staging.ts
├── src/infra/
│   ├── fugue/
│   │   ├── program-machine.ts
│   │   ├── run-directory-job-like.ts
│   │   ├── loom-capabilities.ts
│   │   ├── architecture-operations.ts
│   │   ├── refutation-operations.ts
│   │   ├── wave-gate-operations.ts
│   │   ├── standalone-review-operations.ts
│   │   └── remediation-operations.ts
│   ├── fs/orchestration-run-store.ts
│   └── git/remediation-index.ts
├── src/handlers/helpers/
│   ├── orchestration.ts                 # start/resume/submit/decide/status
│   ├── panel-program.ts                 # legacy adapter
│   ├── standalone-review.ts             # legacy adapter
│   └── complete-wave-gate.ts
├── src/handlers/subagent-stop/dispatch.ts
├── src/state-manager.ts                 # remains sole protected-state writer
└── tests/
    ├── core/orchestration/*.test.ts
    ├── core/orchestration/*.property.test.ts
    ├── infra/fugue/*.test.ts
    └── integration/{orchestration-replay,harness-parity,publication-faults,remediation-index}.test.ts
pi/extension.ts
commands/{loom,wave-gate}.md
skills/review-and-fix/SKILL.md
docs/{transcript-driven-orchestration-automation,deterministic-core}.md
artifacts/orchestration-benchmark/
```

## Trade-offs
Pros:
+ Illegal transitions are excluded structurally: incomplete rosters cannot aggregate, accepted slots cannot retry, empty critical sets cannot start refutation, and terminal programs cannot reopen.
+ More than 90% of policy is pure and replayable; order independence, interruption, status parity, retry limits, and exact-set conservation are testable without I/O mocks.
+ Fugue supplies real static-DAG execution, durable state/replay, routing, waves, capabilities, retries, suspension, and tracing while Loom preserves stronger evidence and single-writer rules.
+ Raw Agent bytes, model/Skill/context authority, and path/index effects are isolated at narrow boundaries, eliminating shell interpolation and caller-selected destinations.
Cons:
- This intentionally sacrifices the interview's simplicity axis: brands, phase-specific unions, effect receipts, versioned parsers, and complete-roster proofs add substantial ceremony.
- The characteristic risk is over-modeling invariants nobody needs, proliferating brands or states that prevent no demonstrated authority, replay, or staging failure and make evolution expensive.
- Fugue cannot represent the semantic graph end-to-end; dynamic batches as values and retries in reducers leave a visible seam between domain machines and static operation DAGs.
- JSON storage plus `StateManager` cannot provide a true multi-resource transaction; commit references and replay make interruption safe, not simple.

## Testability impact
The pure-core bar is exceeded. Unit tests exhaust state/event and parser/error variants; compile-time negative tests reject cross-program events, wrong ID brands, interactive requests in parallel batches, incomplete aggregate rosters, and unaudited staging. `fast-check` generates completion permutations, duplicate/stale/surplus events, retry sequences, replay prefixes, terminal late events, slot conservation, and status/program parity. Fugue tests use in-memory `JobLike`, fixed clock/RNG, fake capability handles, and trace observers; filesystem/Git adapters use temporary repositories. Cross-harness fixtures assert identical authorities/artifacts, while byte fixtures, publication fault injection at every boundary, process interruption, and all five benchmark replays prove the measurable criteria.

## Codebase fit
This deepens existing readonly ADTs, parse-don't-validate boundaries, `ts-pattern` reducers, exact roster checks, immutable/no-follow publication, Pi reservations, and `StateManager` locking. Existing panel, standalone-review, review-panel, and Wave Gate core functions remain the domain vocabulary; helper commands become compatibility adapters and versioned readers preserve historical/in-flight runs. The intentional extension is making evaluated Fugue 0.4.0 a Loom runtime dependency for deterministic DAG and machine mechanics—not semantic Agent calls, domain ownership, Run Directory authority, or protected-state writes. No Redis, BullMQ, database, daemon, nested graph, dynamic node, or new service is added.

## Effort
Large: approximately 12–16 engineer-weeks in replay-compatible slices, plus Pi/Claude Code parity soak time.

## Lens fit
This is the honest type-driven-FP design: authority and lifecycle invariants become constructors and closed states around a pure reducer core; its defining risk is allowing proof machinery to outgrow the failures the product needs to prevent.
