# Candidate: risk-security-first

## Approach summary
Make each Loom domain program the sole authority for its own typed state, and require every start/resume/status/remediation operation to execute through a real, static Fugue DAG that validates a read-only authority snapshot, fans out deterministic checks, reduces one command, and conditionally routes to one external action. Keep Fugue nodes capability-free and put all filesystem, protected-state, harness, and Git effects behind narrow fail-closed adapters with staged publication, exact request grants, and immutable receipts.

## Component boundaries
- **Distinct domain programs (functional core):** `WaveGateProgram`, `ArchitecturePanelProgram`, `RefutationPanelProgram`, `StandaloneReviewProgram`, and `RemediationProgram` remain separate readonly ADTs and reducers. They consume parsed commands and authority snapshots and return `Either<DomainError, TransitionIntent>`; there is no generic workflow state, event vocabulary, or DSL. Existing `panel-kernel.ts`, architecture/refutation reducers, standalone aggregation/finalization, Finding rules, and Wave Gate checks remain the domain seams.
- **Authority and grant kernel (functional core):** branded `OrchestrationRunId`, `RequestId`, `SlotId`, `Attempt`, `ContextDigest`, `ArtifactDigest`, and `SpawnReceiptId` types; exact-roster conservation; request derivation; context hashing; result binding; terminal monotonicity; and publication-receipt reconciliation. An engine-issued `SpawnGrant` binds one run, semantic Agent role, canonical slot, attempt, exact harness model, required Skill, immutable context digest, and fixed output destination. Manifests and caller-supplied lens/criterion/slot fields are non-authoritative and must exactly agree with this grant or are rejected.
- **Fugue executable pipelines:** separate static DAGs for Wave Gate, architecture panel, Refutation Panel, standalone review, status, and remediation. They use shipped `createTransformNode`, `defineDag`/`defineFanOut`, conditional/default edges (or `defineRouter`), `runDag`, persistent `JobLike`, fingerprint checks, replay, and tracing. Each DAG runs fixed, capability-free validation branches in parallel, joins them, invokes only its matching reducer, then routes the resulting action to `spawn-batch`, `await-user`, `blocked`, `publish`, or `done`. Advisory triage alone uses Fugue's real durable HITL suspension; Agent results never masquerade as human decisions.
- **Persistence and publication shell:** an anchored `RunDirHandle` exposes fixed operations rather than arbitrary path strings. It creates files with descriptor-relative `O_NOFOLLOW|O_EXCL`, records immutable numbered events, stages artifact batches, verifies bytes and hashes, and publishes only after the canonical program state records a pending commit. A crash leaves either the previous accepted state or a typed `committing` state that can reconcile exact staged bytes; no spawn grant is visible before its complete batch has a publication receipt.
- **Protected State File adapter:** Wave Gate and wave-owned Refutation state are changed only through `StateManager.update`; Fugue and Run Directory code never receive State File write authority. The adapter performs a version/digest compare inside the existing lock and records batch registrations, accepted request results, retry consumption, and completion atomically with Task changes. Architecture and standalone sessions use their own locked Run Directory stores and never resolve an unrelated State File.
- **File-backed Fugue `JobLike`:** each engine operation gets an engine-derived subdirectory containing an atomic checkpoint and immutable, hash-linked, deduplicated event records. It implements the shipped `JobLike` contract, supports DAG-fingerprint rejection and replay, and uses existing JSON storage—no Redis, BullMQ, daemon, or Fugue host. Fugue events contain IDs, categories, hashes, and outcomes, never raw Agent prose or secrets.
- **Harness capture adapters:** Pi binds the engine request to its existing tool-call reservation and generated Agent definition; Claude Code binds the stored spawn receipt to `session_id`, `agent_id`, `agent_type`, the trusted first user prompt's request ticket, and the pre-spawn model/Skill gate receipt. Both accept exactly one unambiguous final text result, encode it as UTF-8 without trim/join/reformatting, and write the bytes once to an attempt-specific immutable slot before schema parsing. Ambiguous payload shape, missing attribution, wrong Agent/model/request/context, duplicate delivery, or parser failure preserves the raw attempt but cannot accept the slot; only the reducer may issue attempt 2.
- **Context packet boundary:** complete context is serialized once to an immutable content-addressed packet. The parent receives only an engine-generated reference; Pi lowers it into the child prompt in the extension, while Claude Code's Agent bootstrap reads the fixed packet. Acceptance re-hashes the packet, so post-spawn drift invalidates the result even if the Agent already consumed it.
- **Process and remediation boundary:** no shell is used. A `GitProcessPort` permits only fixed executable/argument templates, a canonical cwd, bounded output/time, and an allowlisted environment. Repository paths are parsed as canonical POSIX relative paths, forbidden from Run Directories or Git metadata, and passed as NUL-delimited literal pathspecs. Remediation builds and validates a temporary Git index, checks the real index/repository snapshot has not drifted, then installs through Git's lock discipline; a failed audit or compare leaves the real index and unrelated bytes untouched.

## Data flow
1. A CLI or harness entry parses unknown JSON/arguments into a domain command, opens the registered Run Directory without following links, and loads a validated authority snapshot. For a Wave, `StateManager` also supplies the protected snapshot and the exact registered run identity; unsafe, stale, contradictory, redirected, or broadened authority stops here.
2. The shell starts/resumes the domain's Fugue DAG with the snapshot and an anchored file-backed `JobLike`. Static branches concurrently check identity/version, roster and slots, model/Skill bindings, context/artifact hashes, evidence completeness, and domain-specific readiness; a typed fan-in feeds the domain reducer. Fugue conditional edges route the reducer's one action, while traces redact content by default.
3. For an artifact-producing transition, the shell writes every output to hidden attempt-specific files, re-reads and parses them, records a `committing` transition under the run's single writer, publishes the exact set, and records a receipt. Wave Review Packets may physically stage independently, but the protected state exposes zero spawnable requests until every packet, context, request, and digest has one coherent batch receipt.
4. A `spawn-batch` contains exact harness bindings and compact immutable context references. The parent performs only the visible semantic spawns; Fugue does not spawn Agents because the inspected local API has no Agent-call node or dynamic fan-out.
5. On completion, the harness adapter looks up the engine-issued request rather than trusting repeated identity from the result, proves the spawn receipt and context, captures exact raw bytes to `attempt-N`, and submits only `{requestId, capturedDigest, captureReceipt}`. The appropriate reducer accepts, rejects, retries exactly that slot, or becomes terminal blocked. Completion order cannot affect canonical slot assignment.
6. Each accepted transition is durably recorded before the next action is exposed. Resume replays immutable domain events and Fugue events, verifies the checkpoint/DAG fingerprint and publication receipts, and derives the same action without reissuing accepted work. Late or surplus results are audited and rejected without mutating terminal state.
7. Status calls the same Wave Gate readiness and next-action derivation used by the executable DAG. Remediation similarly computes an authorized path/index transaction in the pure core, executes only the fixed Git plan, re-snapshots, and finalizes only when audited, dirty, and staged sets agree exactly and contain no run evidence.

Fugue's absent primitives stay explicit boundaries: roster-sized Agent fan-out is data in a visible `spawn-batch`, panel/refutation composition is shell sequencing between separate DAGs rather than a nested subgraph, and the one-Agent-retry cycle is reducer state across resume calls rather than a cross-node back-edge. No design assumes dynamic fan-out, nested DAG execution, an Agent node, or a bounded cyclic DAG.

## File-structure sketch
```text
package.json                                      # pin @fuguejs/framework exactly; lock integrity
engine/package.json
engine/src/core/
├── orchestration-authority.ts                    # branded grants, receipts, binding/conservation
├── wave-gate-program.ts                          # new distinct reducer; reuses gate checks
├── panel-program.ts                              # deepen separate architecture/refutation states
├── standalone-review.ts                          # byte-aware transcript inputs, existing semantics
├── standalone-review-program.ts                  # run lifecycle and next actions
├── orchestration-status.ts                       # shared readiness projection, one next action
└── remediation.ts                                # path authority and Git index transaction decisions
engine/src/orchestration/fugue/
├── runtime.ts                                    # runDag wiring, redacted tracing; no domain policy
├── wave-gate-dag.ts
├── architecture-panel-dag.ts
├── refutation-panel-dag.ts
├── standalone-review-dag.ts
├── status-dag.ts
└── remediation-dag.ts
engine/src/handlers/orchestration/
├── resume-domain-program.ts                      # parse → DAG → stage → commit → render
├── anchored-run-store.ts                         # fixed-name no-follow RunDirHandle
├── anchored-job-like.ts                          # JSON JobLike/checkpoint/event implementation
├── artifact-transaction.ts                       # staged publication + receipt recovery
├── protected-wave-store.ts                       # only delegates mutations to StateManager
├── context-packets.ts                            # immutable content-addressed publication
├── git-process-adapter.ts                        # execFile/spawn only, literal NUL pathspecs
└── capture/
    ├── pi-result-capture.ts
    └── claude-result-capture.ts
engine/src/handlers/helpers/
├── panel-program.ts                              # temporary compatibility adapter to resume API
├── standalone-review.ts                          # temporary compatibility adapter
└── complete-wave-gate.ts                         # delegate checks/commit to WaveGateProgram
engine/src/handlers/subagent-stop/dispatch.ts      # Claude automatic capture receipt path
engine/src/state-manager.ts                       # parse new protected fields; authority unchanged
engine/src/cli.ts                                 # start/resume/status/remediation commands
pi/extension.ts                                   # request reservation + direct byte capture
hooks/hooks.json                                  # capture routed through existing SubagentStop
engine/tests/
├── core/*-program.test.ts                        # domain reducers and status/remediation
├── properties/*.test.ts                          # replay, slots, terminals, publication
├── orchestration/fugue/*.test.ts                 # topology, routing, JobLike resume
├── fault-injection/*.test.ts                     # artifact, capture, commit, Git index
└── integration/*.test.ts                         # Pi/Claude parity and benchmark
commands/loom.md                                   # status/deep interface; delete deterministic recipes
commands/wave-gate.md
skills/review-and-fix/SKILL.md
```

## Trade-offs
Pros:
+ Raw Agent output, shell/process input, paths, manifests, and caller-attributed identities have no direct authority: every effect is selected from an engine-issued grant and every byte is captured outside shell interpolation.
+ Least authority is structural: Fugue nodes declare `requires: []`, semantic Agents receive only their immutable context and role-appropriate tools, Run Directory writers expose fixed destinations, and `StateManager` remains the only protected writer.
+ Crash recovery is auditable and fail-closed across both runtimes: immutable request/result/publication receipts, persistent Fugue checkpoints/events, exact retry consumption, and state/artifact compare-and-swap prevent partial work from appearing complete.
+ It uses Fugue as the mandatory executable substrate—static typed DAGs, fan-out/fan-in, conditional routing, replay, fingerprinting, HITL, and tracing—without inventing any of Fugue's missing graph or Agent primitives.

Cons:
- This sacrifices the interview's simplicity preference and delivery speed: write-ahead publication states, descriptor-anchored stores, harness receipts, file-backed `JobLike`, and transactional Git staging add substantial code and more visible blocked states.
- Exact fail-closed attribution may reject otherwise usable Claude Code/Pi results when a harness payload is ambiguous or a hook receipt is missing; operators pay retries for integrity the legacy flow did not prove.
- Immutable attempt transcripts, Fugue event files, context packets, and retained history increase disk use and forensic surface; explicit cleanup remains an operator responsibility.
- The characteristic over-fortification risk is real: hash-linked event files, index compare-and-swap, and exhaustive boundary receipts may defend same-user tampering and rare races beyond the practical feature threat model, while adding a pinned Fugue dependency and more code that itself needs security maintenance.

## Testability impact
More than 90% of policy remains pure: reducers, exact-set checks, grant derivation, result acceptance, publication reconciliation, status priority, and remediation path/index decisions use immutable data and `Either`-style errors. `fast-check` properties cover arbitrary out-of-order/duplicate/stale result streams, replay idempotency, one-retry conservation, terminal monotonicity, context/manifest drift, and staged-set equality; real Fugue `runDag` tests prove topology, conditional routes, checkpoint fingerprint rejection, HITL suspension, and replay rather than mocking the runtime. Thin adapters use in-memory ports and temp repositories, while integration suites inject a failure after every filesystem/state/index boundary, exercise raw-byte equality and ambiguous harness payloads, and replay identical semantic outputs through Pi and Claude Code for canonical parity and benchmark thresholds.

## Codebase fit
The design deepens the exact brownfield seams named in the interview: `panel-kernel.ts` remains the shared envelope kernel; architecture and Refutation Panel reducers stay separate in `panel-program.ts`; `standalone-review.ts`, `review-panel.ts`, Finding semantics, and pure Wave Gate checks remain authoritative; existing no-follow publication is consolidated rather than bypassed; and model/Skill gates plus Pi reservations and Claude transcript attribution become inputs to stronger request receipts. Historical Run Directories and current helper commands continue to parse and act as compatibility adapters, while new runs add receipts/checkpoints without invalidating old data. The only intentional divergence is introducing a dedicated Fugue orchestration shell and exact pinned runtime dependency; it uses the evaluated local shipped APIs and no Redis/host service, and no Fugue object or error type leaks into Loom's domain reducers.

## Effort
Approximately 12–16 engineer-weeks, including incremental compatibility slices, cross-harness capture work, adversarial filesystem/process fault injection, benchmark fixtures, and documentation deletion; the core panel runner can land earlier, but the security claims require the full parity and interruption matrix.

## Lens fit
This is the honest risk-security-first design because authority is narrow, explicit, receipt-bound, and fail-closed at every hostile boundary; its characteristic risk is spending major complexity on same-user tampering and rare publication races beyond the feature's likely threat model.
