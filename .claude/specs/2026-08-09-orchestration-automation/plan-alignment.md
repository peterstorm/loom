# Plan Alignment Report

**Spec:** `.claude/specs/2026-08-09-orchestration-automation/spec.md`  
**Plan:** `.claude/plans/2026-08-09-orchestration-automation.md`  
**Date:** 2026-08-09  
**Mode:** Fresh semantic recheck after architecture loop-back

## Summary

- **Requirement count assessed:** 107 (`US`: 7, `FR`: 69, `NFR`: 16, `SC`: 15)
- **Gap count:** 0
- **Gap IDs:** None
- **FR-051 status:** Fully covered
- **Out-of-scope respected:** Yes. The plan keeps semantic implementation/review/refutation/architecture/remediation choices and advisory decisions external; rejects a generic workflow DSL/registry; keeps Architecture and Refutation vocabularies separate; avoids a second protected State File writer; avoids invisible Agent spawning; preserves model/Skill gates; and removes deterministic parent recipes rather than moving them into prompts/runbooks.

## Executable-Model Policy Check

| Policy | Result | Notes |
|---|---|---|
| Lifecycle machines must bind to real implementation sources, not decorative prose | Pass | LC-1..LC-3 bind to concrete machine files (`engine/src/core/wave-gate-machine.ts`, `engine/src/core/standalone-review-machine.ts`, `engine/src/core/remediation-machine.ts`) with typed reducer states/events. Architecture/refutation reducers are explicitly imported/adapted from `engine/src/core/panel-program.ts` rather than duplicated descriptively. |
| Multi-stage executable behavior must use an executable model or explicitly justify why the plan-level sidecar is not valid | Pass | AD-1 explicitly rejects a plan-level `AuthoredDag` sidecar because the local authored-DAG model supports only one static single-shape DAG and cannot truthfully express several distinct persistent event-driven programs plus roster-sized semantic batches. The plan instead binds execution to Fugue public `Machine`, `JobLike`, `runStateMachine`, `replayEvents`, `defineDag`/shape helpers, `runDag`, `runResumableDagJob`, HITL, capability, conditional-edge, and tracing APIs. |
| Domain programs must remain distinct; executable model must not collapse them into a generic workflow language | Pass | The plan defines separate Architecture Panel, Refutation Panel, Wave Gate, Standalone Review, and Remediation machines/DAG modules, sharing only authority/action/effect envelopes. Generic workflow registry/DSL is explicitly rejected. |
| Checkable invariants must have executable/testable bindings | Pass | Roster conservation, complete-roster proofs, terminal monotonicity, replay idempotency, status/program parity, batch atomicity, capture byte equality, remediation set equality, and benchmark thresholds are bound to specific unit/property/integration/acceptance tests. |
| Parent-facing executable actions must be constrained to the spec's external-action model | Pass | `ExternalAction` is a closed union of `spawn-batch`, `await-user`, `blocked`, and `done`; deterministic effects are internal intents/receipts, and semantic Agent work remains explicit. |

## Gap Details

No gaps found.

## FR-051 Recheck

**FR-051:** Status MUST report active Phase and Wave; pending, running, implemented, blocked, and completed Tasks; failed Proof Obligations; test readiness; Review Run roster gaps and evidence failures; active, advisory, resolved, and refuted Finding counts; Refutation Panel need; and Wave Gate completion eligibility.

**Result:** Fully covered.

**Coverage evidence in plan:**
- `CanonicalStatusFacts` explicitly models `location` with active Phase/Wave, five-state `StatusTaskCounts`, failed Proof Obligations, test readiness, Review Run roster gaps/evidence failures, Finding counts by active/advisory/resolved/refuted, Refutation Panel need, and Wave Gate completion eligibility.
- The plan defines `LoomStatus` as the versioned status contract and states malformed authority keeps every category present as `StatusFact.unavailable` while returning a blocked action.
- Task 3 explicitly requires deriving and testing the full FR-051 inventory.
- Task 10 requires both human and JSON status renderers to preserve the complete fact inventory from the same `LoomStatus` value.
- Task 11 and the Testing/Verification sections assert the inventory in benchmark/status checkpoints and require status/program agreement.

## Semantic Coverage Matrix

| ID | Status | Plan coverage |
|---|---|---|
| US1 | Covered | Wave Gate machine owns readiness, batch-atomic packet/request preparation, missing-slot recovery, critical/advisory routing, blocked diagnostics, and completion. |
| US2 | Covered | Persistent Architecture and Refutation panel sessions derive manifests/slots, bind results by request identity, reject invalid submissions, enforce one retry, persist accepted slots/retries, and aggregate only complete canonical slots. |
| US3 | Covered | Standalone Review preparation freezes scope/metadata/roster/run authority/model bindings/transcript slots, returns one spawn batch, captures raw output directly, blocks incomplete rosters, and routes criticals through Refutation before finalization. |
| US4 | Covered | Engine-authored spawn requests include semantic role, exact harness model binding, request identity, immutable context digest/reference, required Skill, and output slot/result contract. |
| US5 | Covered | `/loom --status` exposes one `LoomStatus` value rendered as human/JSON, with canonical facts, exactly one typed next action, all reasons, blocked diagnostics for bad authority, and parity with executable readiness. |
| US6 | Covered | Remediation starts from authoritative standalone scope, requires explicit support-path registration, audits dirty/staged sets including deletions/absent paths, excludes Run Directory evidence, preserves unrelated work, and stages exactly audited changes. |
| US7 | Covered | RunDir events/receipts/replay, terminal monotonicity, direct harness capture, interruption tests, and Pi/Claude parity fixtures preserve equivalent auditable outcomes. |
| FR-001 | Covered | Closed reducers, Fugue machines/DAGs, typed rosters/effects/receipts, retry policy, aggregation/tally, persistence, and next-action derivation move deterministic orchestration into Loom. |
| FR-002 | Covered | Parent-facing `ExternalAction` exposes only spawn batches, await-user decisions, blocked diagnostics, and done outcomes; deterministic publications are internal effect intents/receipts. |
| FR-003 | Covered | Orchestration façade parses authority, resumes sessions, submits receipts/results, derives status, and returns one external action without parent state inspection or workflow advancement. |
| FR-004 | Covered | Plan keeps separate Architecture Panel, Refutation Panel, Wave Gate, Standalone Review, and Remediation vocabularies and explicitly rejects a general-purpose workflow DSL/registry. |
| FR-005 | Covered | Semantic implementation, review, refutation reasoning, architecture design, remediation design, and user policy choices remain explicit Agent/user external actions with audit trails. |
| FR-006 | Covered | Deterministic mechanics are implemented in reducers/DAGs/effect runners, while command/skill docs remove deterministic shell/journal/transcript recipes. |
| FR-010 | Covered | `deriveWaveReadiness` validates wave/task/proof/test/review/spec/finding/lifecycle/completion facts from locked canonical authority. |
| FR-011 | Covered | Wave preparation derives packets/requests/contexts as one fan-out/fan-in operation and publishes either the durable complete batch or no spawnable requests. |
| FR-012 | Covered | Wave preparation returns spec-check, reviewer roster, model bindings, context references, request identities, and result slots. |
| FR-013 | Covered | Missing-evidence recovery uses the exact active Review Run/original immutable authority and emits retries only for missing or invalid slots. |
| FR-014 | Covered | Critical routing skips Refutation Panel when the canonical critical Finding set is empty. |
| FR-015 | Covered | Critical-bearing reviews transition from Wave Gate to Refutation Program using canonical Findings and engine-issued request/slot authority, not caller journals or hand-built metadata. |
| FR-016 | Covered | Advisory triage routes through `await-user`/HITL; deterministic code never accepts, dismisses, or remediates advisories silently. |
| FR-017 | Covered | Completion requires `ready-to-complete` from canonical readiness; failed prerequisites are carried as complete blocked reasons/diagnostics. |
| FR-018 | Covered | Immutable events, dedup keys, receipts, checkpoint/replay, and terminal monotonicity make resume idempotent and non-duplicating. |
| FR-020 | Covered | Panel sessions derive immutable item sets and ordered architecture lenses/refutation criteria from authoritative run inputs/manifests. |
| FR-021 | Covered | Panel state, accepted request identities, retry consumption, and terminal outcome persist in RunDir events/checkpoints across interruption. |
| FR-022 | Covered | `AgentRequestAuthority` uniquely binds run, request, role, canonical slot, model/harness binding, context digest, output slot, and attempt. |
| FR-023 | Covered | Submission uses engine-issued request identity; caller lens/criterion/candidate/Finding claims are compared only as non-authoritative claims. |
| FR-024 | Covered | Malformed, stale, mismatched, duplicate, missing, and surplus results reject fail-closed while preserving unrelated accepted slots. |
| FR-025 | Covered | Attempts are typed as `1 | 2`; first failure permits one retry and second failure terminal-blocks the owning program. |
| FR-026 | Covered | `parseCompleteRoster` is the only constructor of `CompleteRoster`, and aggregation/tally APIs require that proof. |
| FR-027 | Covered | Canonical request/slot authority, complete-roster ordering, and property tests make completion order irrelevant to assignment, retry, outcome, and next action. |
| FR-028 | Covered | Refutation operations preserve strict-majority tally, uncertainty/tie retention behavior, and retain refuted Findings with lenses/reasoning/evidence. |
| FR-029 | Covered | Architecture and refutation lens types/vocabularies remain disjoint and are explicitly not merged. |
| FR-030 | Covered | One Standalone Review preparation accepts/derives exact non-empty scope, freezes metadata/roster/run authority/models/transcript slots, and returns one batch. |
| FR-031 | Covered | Scope is explicit user scope or canonical changed-path union; empty, ambiguous, external, or unsafe scope blocks. |
| FR-032 | Covered | Reviewer roster and immutable transcript slots are frozen before spawn and complete-roster proof prevents later shrinkage/replacement. |
| FR-033 | Covered | Pi extension and Claude subagent-stop capture write harness-reported reviewer/verifier output directly to engine-declared slots without parent Write/Edit/Bash publication. |
| FR-034 | Covered | Capture handles raw bytes with sha256/length receipts and byte-equality tests; no trim/join/reformat path is allowed. |
| FR-035 | Covered | Transcript slots are distinct/immutable and capture rejects wrong-run, wrong-Agent, wrong-request, missing, duplicate, mismatched, stale, late, and surplus evidence. |
| FR-036 | Covered | Standalone lifecycle/capture does not resolve unrelated active State File; protected StateManager writes are scoped to Wave registration/commit. |
| FR-037 | Covered | Standalone aggregation requires `CompleteRoster<CapturedReviewerResult>` from the exact frozen roster. |
| FR-038 | Covered | Standalone clean aggregate finalizes directly; critical-bearing aggregate waits for completed canonical Refutation outcome. |
| FR-039 | Covered | Final result/disposition handling distinguishes surviving criticals, refuted criticals, and advisories while retaining source Agent, scope, and adjudication evidence. |
| FR-040 | Covered | Every `AgentRequestAuthority` includes semantic Agent role and exact profile/harness-specific Pi/Claude model binding. |
| FR-041 | Covered | Context packets include complete immutable variable material: Task/plan/spec/review/lens/criterion, Skill, output contract, request identity, and digest. |
| FR-042 | Covered | Parent spawn actions carry compact context references; packet bytes are lowered/loaded inside Pi/Claude harness paths. |
| FR-043 | Covered | Context digest is checked at spawn and rehashed at acceptance; drift/tampering blocks result acceptance. |
| FR-044 | Covered | Existing model and Skill gates remain in pre-spawn/acceptance paths and fail closed on missing, inherited, or mismatched bindings. |
| FR-045 | Covered | Engine emits model bindings and benchmark explicitly enforces zero explicit per-Agent Pi profile lookups by the parent. |
| FR-050 | Covered | Façade exposes `status [--json]`; human and machine renderers derive from the same `LoomStatus` value. |
| FR-051 | Covered | `CanonicalStatusFacts`, Task 3, Task 10, Task 11, Testing Strategy, and Verification item 7 explicitly cover the complete required status fact inventory. |
| FR-052 | Covered | `NextActionDecision` contains exactly one typed action and a non-empty complete ordered reason set. |
| FR-053 | Covered | Wave Gate reducer and status both consume the same readiness snapshot and `deriveNextAction`; renderers contain no readiness/action policy. |
| FR-054 | Covered | Missing/malformed/stale/contradictory authority yields `StatusFact.unavailable` categories and a single blocked action, never permissive readiness. |
| FR-060 | Covered | Remediation starts from `result.json.scope`/authoritative standalone result and maintains an auditable remediation path authority. |
| FR-061 | Covered | New regression/support paths require explicit `support-path-registered` events before audit/staging. |
| FR-062 | Covered | Git remediation adapter and tests handle additions, modifications, renames, deletions, and absent scoped paths. |
| FR-063 | Covered | Pure path-set audit and staging verification block outside-authority dirty/staged paths and identify every discrepancy. |
| FR-064 | Covered | Temporary-index workflow verifies `audited == dirty == staged` and publishes canonical comparison evidence. |
| FR-065 | Covered | Run Directory roots/evidence are excluded by the Git boundary and benchmark/integration tests require zero staged run evidence. |
| FR-066 | Covered | Index/worktree witnesses, temporary index, and outside-authority blocking preserve unrelated pre-existing changes unless explicitly registered. |
| FR-067 | Covered | Fault/rollback tests require failed audit/staging to remove temporary state and leave real index/worktree/unrelated changes unchanged. |
| FR-070 | Covered | Every run has fresh authority/run identity and cannot implicitly consume prior terminal runs or Run Directories. |
| FR-071 | Covered | Run authority, requests, contexts, rosters, slots, transcripts, receipts, retries, Findings, and decisions are keyed to originating run identity. |
| FR-072 | Covered | Plan states no automatic cleanup/expiry/deletion and historical artifacts remain readable indefinitely. |
| FR-073 | Covered | Safe commit-reference protocol, receipts, publication fault injection, and recovery expose only last complete accepted or blocked recoverable state. |
| FR-074 | Covered | Immutable event replay is idempotent; dedup keys/receipts prevent duplicate effects and consumed external results reject as duplicates. |
| FR-075 | Covered | Done/terminal-blocked states are monotonic and late/stale/surplus results are audited but cannot mutate outcomes. |
| FR-076 | Covered | Only `StateManager.update` writes protected state; no database/daemon/second State File writer is introduced. |
| FR-077 | Covered | Agent output has no authority until exact run/request/slot/model/context/attempt validation and Loom acceptance. |
| FR-078 | Covered | Genuine advisory/policy decisions are accepted only through user decision/HITL routes. |
| FR-079 | Covered | Immutable run history, request-result bindings, retries, blocked reasons, Findings, traces, status, receipts, and counters remain inspectable without mutation. |
| FR-080 | Covered | `BlockedDiagnostic` is a closed union with affected run, request/slot/effect where applicable, category, retry eligibility, and one recovery action. |
| FR-081 | Covered | Missing evidence, malformed results, authority drift, stale requests, partial publication, helper failure, path mismatch, and harness attribution failure all fail closed. |
| FR-082 | Covered | Recovery keeps previously accepted valid slots and emits work only for genuinely pending/invalid slots. |
| FR-083 | Covered | Immutable scope/roster/slots, strict refutation threshold, direct raw capture, and gate validation prevent broadening, shrinkage, threshold lowering, overwrite, parent reconstruction, or gate bypass. |
| FR-084 | Covered | Boundary fault injection requires zero false completion for helper/harness failures. |
| NFR-001 | Covered | Benchmark verification enforces at least 80% reduction in parent-authored orchestration Bash/JSON command characters. |
| NFR-002 | Covered | Benchmark verification enforces at least 70% reduction in deterministic-orchestration parent tool calls. |
| NFR-003 | Covered | Benchmark enforces zero parent-authored `jq`, Panel Program journals, raw-output shell embedding, manual transcript publication, and explicit Pi profile lookup. |
| NFR-004 | Covered | Immutable context references and benchmark counters enforce zero repeated full fixed rules/contracts in parent-supplied Agent requests. |
| NFR-010 | Covered | Pure reducers, deterministic DAGs, immutable authority, replay, and property tests make transitions/artifacts/rosters/slots/retries/final decisions reproducible from the same inputs. |
| NFR-011 | Covered | Replay and terminal monotonicity properties/fixtures cover 100% generated replay and late-result cases. |
| NFR-012 | Covered | `ExactRoster`/`CompleteRoster` parser and property tests enforce roster/slot conservation for valid and invalid sequences. |
| NFR-013 | Covered | Publication-boundary fault injection requires zero falsely complete runs and zero partially authoritative outcomes. |
| NFR-014 | Covered | Pi/Claude acceptance fixtures verify equivalent canonical outcomes for approved cross-harness integration fixtures. |
| NFR-020 | Covered | Parser-proven RunDir handles, no-follow anchored operations, path validation, and remediation path parser reject unsafe/external/ambiguous/redirected paths. |
| NFR-021 | Covered | Agent prose never selects run/slot/lens/criterion/Finding/model/destination and appears in zero command strings; authority comes from request identity. |
| NFR-022 | Covered | Fault/property tests reject duplicate, missing, malformed, mismatched, stale, and surplus evidence fail-closed. |
| NFR-023 | Covered | Remediation staging excludes Run Directory evidence and benchmark/integration suites verify zero run evidence in commits. |
| NFR-030 | Covered | Shared domain actions/diagnostics/retry/final decision model and Pi/Claude adapters preserve parity despite harness differences. |
| NFR-031 | Covered | Accepted semantic results trace to run, issued request, Agent role, model binding, immutable context, canonical slot, and attempt via authority/receipts. |
| NFR-032 | Covered | Command/skill docs are updated to external actions only and runbook verification requires zero deterministic parent-executable recipes. |
| SC-001 | Covered | Five-scenario benchmark enforces ≥80% fewer parent-authored orchestration Bash/JSON characters. |
| SC-002 | Covered | Five-scenario benchmark enforces ≥70% fewer deterministic-orchestration parent tool calls. |
| SC-003 | Covered | Benchmark requires exactly zero `jq`, Panel Program journals, shell-embedded raw output, manual transcript publication, and explicit per-Agent Pi profile lookups. |
| SC-004 | Covered | Approved fixture 1 verifies a no-critical two-Task Wave needs one Wave Gate prep/resume and one spawn batch with zero parent packet/model/prompt/state loops. |
| SC-005 | Covered | Standalone fixture verifies one preparation and one spawn batch with zero parent transcript Write/Edit/Bash publication calls. |
| SC-006 | Covered | Cross-harness fixtures verify equivalent canonical artifacts, rosters, slots, Finding dispositions, next actions, and gate decisions. |
| SC-007 | Covered | Direct capture receipts and byte-equality tests verify 100% byte equality from harness output to raw transcript artifact. |
| SC-008 | Covered | CompleteRoster/fault tests reject missing, duplicate, malformed, stale, mismatched, and surplus results before finalization. |
| SC-009 | Covered | Interruption tests at accepted action boundaries verify no duplicate publication/spawns, no lost retry consumption, and unchanged final outcome. |
| SC-010 | Covered | Batch-atomic Wave review preparation and fault tests verify all required packets/requests publish or zero become spawnable. |
| SC-011 | Covered | Status/program parity properties and benchmark checkpoints assert agreement on readiness, roster gaps/evidence failures, panel need, completion eligibility, and one next action. |
| SC-012 | Covered | Remediation fixtures handle additions/modifications/renames/deletions/absent paths and verify zero unauthorized or Run Directory evidence paths staged. |
| SC-013 | Covered | Verification injects missing, inherited, and mismatched model/Skill bindings and requires existing gates to reject them. |
| SC-014 | Covered | Context packet/reference design and benchmark counters verify parent spawn payloads contain zero repeated full fixed rules/contracts. |
| SC-015 | Covered | Command/skill documentation cutover and verification require zero parent-executable Bash/JSON journal recipes for deterministic orchestration now owned by Loom. |
