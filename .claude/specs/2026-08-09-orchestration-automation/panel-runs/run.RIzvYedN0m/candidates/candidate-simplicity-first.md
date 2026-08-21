# Candidate: simplicity-first

## Approach summary
Put one direct `orchestration-runner` façade in front of Loom's existing domain-specific reducers: `start`, `next`, `capture`, `decide`, `status`, and `stage-remediation` all load one run, execute deterministic work, persist it, and return exactly one typed external action. Use Fugue 0.4.0 as the in-process execution substrate—its `Machine`/`JobLike`/replay kernel for persistent sessions and small static DAGs for deterministic preparation, validation, fan-out/fan-in, routing, HITL, and tracing—without adding a workflow registry, service, queue, or generic DSL.

## Component boundaries
- **Existing domain programs (functional core):** Keep architecture panel and Refutation Panel reducers separate in `panel-program.ts`; add separate `WaveGateProgramState` and `StandaloneReviewProgramState` unions beside their existing domain logic. Each reducer is a pure `(state, event) -> Either<error, state + next action>` function. A small shared contract defines branded `RunId`, `RequestId`, `ContextDigest`, exact slot bindings, `SpawnRequest`, `BlockedDiagnostic`, and the common external-action envelope; it does not define workflow stages or a configurable workflow language.
- **`orchestration-runner` (single imperative shell):** The only new orchestration façade. It parses commands, locks and loads a run, calls the selected domain reducer directly, invokes deterministic Fugue operation DAGs, persists the result, and renders human/machine output. Existing helpers become thin compatibility calls into this façade rather than alternate orchestration paths.
- **Fugue execution inside the runner:** Adapt each domain reducer to Fugue's public `Machine` API and persist it through a local `JobLike`. States that expose a spawn batch or other external action are halted states. For finite deterministic operations, build a static, run-scoped DAG from the already-frozen manifest: pure transforms derive readiness and routing; per-slot packet/context/result checks execute as a fan-out wave; a join enforces exact coverage and publishes one batch marker; conditional/default edges select spawn, retry, blocked, panel, user-decision, or done. Use `withHumanReview` only for genuine advisory/policy decisions, never as a fake Agent-call node. Semantic Agent execution remains outside Fugue and explicit.
- **Run persistence:** Reuse the current Run Directory no-follow and atomic-publication primitives. One `session.json` acts as the local `JobLike` snapshot and prefix-preserving event journal; immutable `authority.json`, request records, content-addressed context packets, per-attempt raw outputs, and final artifacts sit beside it. `appendEvent` and `updateData` each lock and atomically replace `session.json`; Fugue dedup keys close the append-before-checkpoint crash window. A final batch marker makes multi-file preparation spawnable only after every artifact validates.
- **Protected State File boundary:** Wave authority is read and re-parsed through `StateManager`. Any Wave mutation is a locked `StateManager.update` that re-derives readiness against the locked graph before applying the pure transition. Run files record program progress but never become an alternative Task-graph authority; panel and standalone runs never inspect an unrelated State File.
- **Harness capture:** Pi and Claude Code adapters reserve engine-issued request bindings before spawn and, on completion, pass the harness-reported output bytes directly to `capture(requestId, attribution, bytes)`. Capture verifies run, request, Agent, reservation/agent id, canonical slot, attempt, model, Skill, and context digest; writes `attempt-N.raw` with exclusive no-follow I/O; parses from those bytes; and appends accepted or rejected evidence without touching sibling slots. The parent never handles raw output.
- **Context/model binding:** The runner writes one immutable content-addressed context packet per distinct context and includes its digest/reference, semantic role, required Skill, exact Pi or Claude Code binding, request id, and output slot in every spawn request. Existing model and Skill gates re-check the request. Harness startup resolves the packet reference for the child; the parent carries only the compact reference.
- **Status and remediation:** Wave status calls the same pure readiness/next-action function used by the Wave Gate reducer. Remediation stays part of the standalone-review bounded context: freeze the result scope and initial Git path/index facts, register additional support paths through an explicit event, parse NUL-delimited Git name-status data (including renames/deletions), fail before index mutation on any unauthorized path, stage with argument arrays rather than shell text, verify exact staged equality, and restore the saved index bytes if staging or verification fails.
- **Fugue limits kept explicit:** Add an exact `@fuguejs/framework@0.4.0` dependency but no Redis/BullMQ packages or host service. Graph topology is fixed before each deterministic operation starts; a manifest-derived number of slot nodes is construction-time specialization, not runtime dynamic fan-out. The one semantic retry is represented as attempt-1/attempt-2 domain state (or two static branches), not a cross-node loop. No Agent-call nodes, nested subgraphs, dynamic fan-out, or bounded back-edges are assumed.

## Data flow
1. `start` parses user arguments and canonical authority, creates a fresh no-follow Run Directory, freezes scope/roster/model/slot data, and writes immutable authority plus the initial Fugue-backed session.
2. `next` locks the session, replays or verifies its event prefix, and runs the selected pure reducer. Deterministic work is passed through a static Fugue operation DAG; read/write nodes declare only the local capability they need (run artifacts, Task graph, or Git), while pure nodes require none. Fugue checkpoints each transition and emits identity/hash/count traces, never raw Agent prose.
3. Preparation nodes stage every Review Packet, request, and context packet. Fan-in validates exact roster/slot conservation and all hashes, then publishes one immutable batch marker. Only then does the halted program return one `spawn-batch` containing exact bindings and compact context references.
4. The parent visibly executes that batch. Harness adapters bind native completion identity to the reserved request and publish the exact output bytes directly to the immutable attempt slot. Capture translates boundary exceptions to typed errors and records malformed, mismatched, duplicate, stale, or surplus evidence as rejected without changing accepted siblings.
5. The reducer accepts valid results in canonical-slot order regardless of arrival order. An initial failure emits a batch containing exactly affected slots at attempt 2; a second failure enters monotonic terminal blocked state. Complete exact rosters unlock deterministic aggregation/tally. Zero criticals bypass Refutation Panel; non-empty canonical criticals initialize it directly.
6. Wave completion rechecks every prerequisite under the State File lock before applying `applyGateDecision`. Advisory triage routes to Fugue HITL suspension and resumes only from a bound user decision. Standalone finalization writes `result.json` only after exact capture and optional panel completion.
7. `status` derives the same one next action and all reasons without mutating authority. Remediation later audits the current NUL-safe Git path sets against the finalized scope plus registered additions, stages exactly the audited set, verifies it, and publishes comparison evidence while excluding Run Directory paths.

## File-structure sketch
```text
package.json                                      # add exact Fugue dependency
engine/package.json                               # same dependency for engine-local tests
engine/src/core/
├── orchestration-contract.ts                     # shared identities/actions/errors only (new)
├── panel-program.ts                              # run-bound requests + persistent architecture/refutation reducers
├── standalone-review.ts                          # standalone program + remediation authority transitions
└── wave-gate-program.ts                          # Wave Gate reducer and shared status derivation (new)
engine/src/
└── orchestration-runner.ts                       # single shell, Fugue machines/DAGs, JobLike, run storage (new)
engine/src/handlers/helpers/
└── orchestration.ts                              # thin CLI adapter: start/next/decide/status/stage (new)
engine/src/handlers/pre-tool-use/
├── validate-agent-model.ts                       # consume exact engine request binding
└── validate-agent-skill.ts                       # verify packet Skill binding
engine/src/handlers/subagent-stop/
└── dispatch.ts                                   # Claude Code direct raw capture before Task-state routing
pi/extension.ts                                   # reserve request ids; direct byte capture on tool_result
commands/loom.md                                  # status/deep-interface calls; delete deterministic recipes
commands/templates/wave-gate.md                   # external actions only
skills/review-and-fix/SKILL.md                    # external actions only
engine/tests/
├── core/orchestration-program.property.test.ts   # replay/order/retry/terminal invariants (new)
├── orchestration-runner.test.ts                  # in-memory JobLike + static DAG tests (new)
├── orchestration-publication.test.ts             # no-follow/atomic fault injection (new)
├── orchestration-harness-parity.test.ts          # Pi/Claude fixture equivalence (new)
└── orchestration-benchmark.test.ts               # five approved replay scenarios (new)
```

## Trade-offs
Pros:
+ One parent-facing façade and one session format remove manual journals, state queries, packet/model loops, raw-output publication, and staging scripts with the shortest migration path.
+ Reuses Loom's proven reducers, parsers, `StateManager`, no-follow publication, model/Skill gates, and harness reservations instead of introducing a second engine or storage system.
+ Uses Fugue where its shipped API is strong: durable `JobLike` transitions and replay, static typed DAG validation, conditional routing, concurrent fan-out/fan-in, native HITL suspension, scoped capabilities, retries for deterministic node failures, and OTel tracing.
Cons:
- The single `orchestration-runner.ts` deliberately collapses persistence, Fugue adaptation, artifact publication, and command dispatch; it can become a simple but hard-to-change blob as more flows arrive.
- Run-specialized static DAG construction is less reusable than a workflow registry and may repeat small node-building functions across the four domain programs; this candidate accepts that duplication rather than inventing a generic DSL.
- Fugue cannot model semantic Agent calls, nested panels, dynamic runtime fan-out, or the semantic retry as a true graph loop, so domain reducer halts and an unrolled two-attempt policy remain visible seams rather than one visually unified graph.

## Testability impact
The reducers, status derivation, request binding, roster conservation, remediation path algebra, and action selection remain pure and mock-free; in-memory `JobLike` plus fake capability objects exercise the runner without filesystem or harness mocks. Fast-check properties cover all result permutations, replay idempotence, exact slot conservation, duplicate/stale/surplus rejection, one-retry exhaustion, terminal monotonicity, and status/program agreement. Focused integration tests cover descriptor-anchored publication, byte equality, `StateManager` lock rechecks, Git index rollback, interruption at every publication boundary, exact Fugue checkpoint resume, and Pi/Claude Code parity; the five-scenario replay test enforces the command-character/tool-call targets.

## Codebase fit
This extends the named brownfield seams rather than replacing them: `panel-kernel.ts` retains only genuinely shared panel primitives, architecture and refutation vocabularies/reducers remain separate, `standalone-review.ts` still owns its independent authority, and Wave Gate checks remain the single readiness policy. It preserves `StateManager` as the only protected-state writer and reuses existing Run Directory, model/Skill, Pi reservation, Claude hook, and atomic publication conventions. Compatibility helpers call the new façade until replay parity is proven, after which procedural runbook text can be deleted. The intentional divergence is adding Fugue 0.4.0 as an in-process runtime dependency; no Fugue repository changes or unshipped capabilities are required.

## Effort
Approximately 7–9 engineer-weeks: 2 weeks for contracts/session store/Fugue integration, 2 weeks for persistent panels and standalone capture, 2 weeks for Wave Gate/status/context packets, 1 week for remediation staging, and 1–2 weeks for cross-harness fault injection, replay benchmarks, compatibility migration, and documentation deletion.

## Lens fit
This is the shortest honest route—one direct façade, one local session format, existing domain reducers, and no service/registry/DSL—with the characteristic risk that `orchestration-runner.ts` accumulates distinct authority and execution concerns into a hard-to-evolve blob.
