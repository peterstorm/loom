# Feature: Transcript-Driven Orchestration Automation

**Spec ID:** 2026-08-09-orchestration-automation
**Created:** 2026-08-09
**Status:** Approved
**Owner:** Loom maintainers

## Summary

Loom must take ownership of deterministic orchestration that the parent Agent currently reconstructs from state, shell commands, event documents, repeated prompts, and raw Agent output. The feature provides persistent, auditable orchestration for Wave Gates, panels, Standalone Review Runs, Agent context, status, and remediation while leaving semantic implementation, review, refutation, architecture choices, and genuine policy decisions with Agents and users.

The result must reduce parent-authored orchestration command characters by at least 80% and deterministic-orchestration parent tool calls by at least 70% on the approved replay benchmark, while preserving or strengthening all existing authority, evidence, review, and fail-closed guarantees across Pi and Claude Code.

---

## User Scenarios

### US1: [P1] Execute a Wave Gate Through Engine-Owned Actions

**As a** Loom operator completing an implementation Wave
**I want to** receive only the exact external actions or user decisions currently required
**So that** I do not have to inspect protected state, prepare review artifacts, reconstruct retry policy, or manually advance the Wave Gate

**Why this priority:** Wave Gate transcripts contain the highest repeated deterministic orchestration volume, and an incorrect decision can advance incomplete work or lose blocking Findings.

**Acceptance Scenarios:**
- Given every Task in the current Wave has satisfied implementation and test prerequisites, When the operator starts or resumes the Wave Gate, Then Loom validates readiness, prepares the complete review scope, and returns the exact spec-check and reviewer spawn batch without parent-authored state queries, packet loops, model lookup loops, or prompt-contract assembly.
- Given Review Packets for multiple Tasks are required, When preparation succeeds, Then every required packet and review request is available as one coherent set; when any required item cannot be prepared, none of the batch is made spawnable.
- Given one or more expected reviewer results are missing or invalid, When the program evaluates the incomplete Review Run, Then it returns retry requests for exactly the affected slots and does not ask the parent to infer roster gaps.
- Given the completed review contains zero critical Findings, When the Wave Gate continues, Then Loom derives whether advisory triage or final completion is next and never starts an empty Refutation Panel.
- Given the completed review contains critical Findings, When the Wave Gate continues, Then Loom enters the Refutation Panel using the authoritative Finding set without a parent-authored panel journal or hand-built Finding set.
- Given advisory triage is the only remaining decision, When the operator requests the next action, Then Loom identifies the advisories requiring a genuine user decision and does not silently classify them.
- Given any completion prerequisite remains unsatisfied, When final completion is requested, Then the Wave remains blocked and the operator receives a diagnostic naming every blocking reason.

### US2: [P1] Run Persistent Architecture and Refutation Panels

**As a** Loom operator running an architecture panel or Refutation Panel
**I want to** submit each semantic result against an engine-issued request and receive the next action
**So that** I never construct, append, replay, or reconcile a Panel Program journal myself

**Why this priority:** Panels are shared by architecture, Wave Gate, and standalone review flows; reliable slot binding and interruption recovery are prerequisites for deeper automation in each flow.

**Acceptance Scenarios:**
- Given an authoritative panel manifest, When a panel starts, Then Loom derives the exact ordered candidates or Findings, lenses or criteria, model bindings, and pending spawn requests without caller reconstruction.
- Given valid results arrive in any completion order, When each is submitted against its request identity, Then Loom binds it to the canonical slot and returns the same next action regardless of completion order.
- Given a result repeats a lens or criterion that the caller claims explicitly, When its request identity binds a different canonical slot, Then the caller-supplied identity has no authority and the mismatch is rejected.
- Given a panel result is malformed, missing, stale, mismatched, duplicate, or surplus, When it is submitted, Then Loom fails closed, preserves accepted slots, and returns a diagnostic and only the retry action permitted for that slot.
- Given a panel slot fails its initial attempt, When Loom evaluates it, Then exactly one retry is permitted; if that retry also fails, the panel enters a terminal blocked state.
- Given every canonical slot succeeds, When Loom derives the next action, Then deterministic aggregation or tally becomes available; before that point, neither operation can complete.
- Given the process or parent session ends mid-panel, When the same run resumes, Then previously accepted results and retry consumption remain intact and already-published effects are not repeated.

### US3: [P1] Start and Complete a Standalone Review Without Manual Evidence Publication

**As a** developer requesting a standalone review
**I want to** start from review arguments and receive a complete reviewer spawn batch
**So that** scope, reviewer selection, run authority, model bindings, and exact transcript destinations are consistent and do not depend on parent-authored glue

**Why this priority:** Standalone reviews route large raw reviewer and verifier outputs through the parent today, creating substantial token, integrity, and path-handling risk.

**Acceptance Scenarios:**
- Given an explicit non-empty file scope, When a Standalone Review Run starts, Then one preparation operation freezes that scope, its review metadata, the exact reviewer roster, model bindings, run authority, and distinct transcript slots before returning one reviewer spawn batch.
- Given no explicit scope, When a Standalone Review Run starts, Then Loom derives the approved changed-path union; if that union is empty or cannot be determined safely, the run blocks rather than broadening scope.
- Given a selected reviewer completes through Pi or Claude Code, When the harness reports completion, Then the exact raw output is published directly to that reviewer's immutable slot without passing through a parent-authored Write, Edit, or shell command.
- Given a result is attributed to the wrong run, Agent, reservation, or slot, When capture is attempted, Then publication fails closed and no unrelated orchestration state or run artifact is changed.
- Given one expected reviewer result is missing, malformed, duplicated, or surplus, When aggregation is requested, Then aggregation remains blocked and the diagnostic identifies the exact roster discrepancy.
- Given the exact reviewer roster is complete and contains zero critical Findings, When the run continues, Then Loom publishes the canonical final review result without starting a panel.
- Given the exact reviewer roster is complete and contains critical Findings, When the run continues, Then Loom prepares the Refutation Panel from the canonical aggregate and publishes the final result only after panel completion.

### US4: [P1] Dispatch Agents With Bound Models and Immutable Context

**As a** parent Agent executing Loom actions
**I want to** receive spawn requests that already contain the required model binding and an integrity-bound context reference
**So that** I do not repeatedly resolve profiles or inline large fixed rules, plans, contracts, and review context

**Why this priority:** Exact model binding is a safety gate, and eliminating explicit per-Agent Pi profile lookup is a mandatory benchmark bar.

**Acceptance Scenarios:**
- Given Loom emits an Agent spawn request, When the parent executes it, Then the request already identifies the semantic Agent role, exact harness model binding, immutable context reference, request identity, and output slot or result contract.
- Given multiple Agents need the same fixed rules or plan context, When their requests are emitted, Then the parent carries compact integrity-bound references rather than repeated copies of that fixed context.
- Given variable Task, Review Packet, lens, criterion, or output-contract context is required, When the request is prepared, Then the referenced context contains the complete authoritative material for that Agent and cannot silently drift after spawn.
- Given a required model or Skill binding is missing or mismatched, When spawn is attempted, Then the existing model and Skill gates reject the spawn.
- Given a parent uses Pi for the approved benchmark, When it executes all emitted spawn batches, Then it performs zero explicit per-Agent model-profile lookups.

### US5: [P2] Inspect Canonical Status and One Next Action

**As a** Loom operator returning to an active run
**I want to** see canonical status and one derived next action with reasons
**So that** I can resume safely without reading internal state or rediscovering workflow rules

**Why this priority:** Status substantially reduces observability glue and recovery ambiguity, but it can follow the core program and evidence-capture capabilities it reports on.

**Acceptance Scenarios:**
- Given an active Loom flow, When the operator requests status, Then the response reports the active Phase and Wave, Task counts by lifecycle state, failed Proof Obligations, test readiness, review roster gaps, review evidence failures, Finding counts by disposition, Refutation Panel need, and Wave Gate completion readiness.
- Given multiple internal facts are relevant, When status is derived, Then exactly one next action is returned with all reasons that make it the next permissible action.
- Given advisory triage is the remaining non-deterministic step, When status is requested, Then the next action explicitly requests that user decision rather than choosing for the user.
- Given protected state or run evidence is malformed, missing, or contradictory, When status is requested, Then status reports a blocked diagnostic and never reports a permissive next action.
- Given status and an executable program inspect the same unchanged authority, When both derive readiness, Then they agree on gate eligibility, roster completeness, panel need, and next action.

### US6: [P2] Audit and Stage Standalone Review Remediation Safely

**As a** developer applying an adjudicated standalone review result
**I want to** audit remediation paths and stage exactly the authorized change set
**So that** deleted files, new regression support, pre-existing work, or run evidence cannot be mishandled by improvised staging commands

**Why this priority:** This closes a high-risk end-of-flow boundary after review automation is available, but it is not required to start or adjudicate a review.

**Acceptance Scenarios:**
- Given an authoritative standalone review result, When remediation begins, Then its exact reviewed scope becomes the initial audit authority and any added regression or support path requires explicit registration before modification or staging.
- Given a scoped file was deleted or is absent from the current revision, When dirty paths are audited and staged, Then the deletion is handled as an authorized change without requiring the file to exist.
- Given a dirty or staged path is outside the registered remediation authority, When audit or staging runs, Then the operation fails and identifies every unaudited path.
- Given run evidence exists alongside remediation changes, When staging completes, Then zero Run Directory evidence paths are staged.
- Given unrelated user changes existed before remediation, When remediation and staging complete, Then those changes remain unmodified and unstaged unless the user explicitly registered them as part of the remediation.
- Given the authorized dirty set is valid, When staging completes, Then the staged path set equals that audited dirty set exactly and canonical evidence reports the comparison.

### US7: [P2] Preserve Auditable Behavior Across Harnesses and Interruptions

**As a** Loom maintainer
**I want to** observe equivalent orchestration decisions and canonical artifacts across Pi and Claude Code
**So that** harness differences cannot weaken evidence, identity, retry, or completion guarantees

**Why this priority:** Harness parity is release-required quality for all capabilities, though it is verified after the core behavior exists.

**Acceptance Scenarios:**
- Given the same approved replay fixture and semantic Agent results, When Pi and Claude Code run it, Then both produce equivalent program transitions, request identities, canonical run artifacts, Finding dispositions, and gate decisions.
- Given a helper or harness stops during artifact publication, When the run is inspected or resumed, Then Loom exposes either the last complete state or a blocked recoverable state, never a falsely complete partial publication.
- Given accepted events are replayed during recovery, When state is derived again, Then the result is unchanged and no external effect is duplicated.
- Given a run reaches done or terminal blocked, When stale or late results arrive, Then the terminal state does not regress and the results cannot mutate the canonical outcome.
- Given a run is complete, When a later run starts, Then it receives a fresh identity and cannot implicitly consume artifacts from the older run.

---

## Functional Requirements

### Executable Orchestration Ownership

- FR-001: Loom MUST own every deterministic decision needed to inspect orchestration readiness, prepare canonical artifacts, derive rosters and slots, bind models, validate results, apply retry policy, aggregate evidence, tally decisions, persist progress, and determine the next action.
- FR-002: Loom MUST expose only externally meaningful actions to the parent: exact Agent spawn batches, genuine user decisions, typed blocked outcomes, deterministic external publications when required, or completion.
- FR-003: Loom MUST NOT require the parent to inspect State File internals, reconstruct workflow ordering, or manually advance an executable orchestration session.
- FR-004: Architecture panel, Refutation Panel, and Wave Gate behavior MUST remain distinct domain programs with separate action and state vocabularies; the feature MUST NOT create a general-purpose workflow language.
- FR-005: Loom MUST preserve semantic work as external and auditable: implementation, code review, refutation reasoning, architecture design, and user policy choices remain attributable to the Agent or user that supplied them.
- FR-006: Loom MUST NOT move deterministic orchestration mechanics into larger parent prompts or repeated prompt templates.

### Wave Gate Program

- FR-010: The Wave Gate MUST validate the current Wave, implementation proof, test evidence, required new tests, review readiness, spec alignment, active critical Findings, lifecycle obligations, and completion eligibility from canonical authority.
- FR-011: The Wave Gate MUST prepare all Task Review Packets and their review spawn requests as one batch-atomic operation: all required items become available together or none become spawnable.
- FR-012: The Wave Gate MUST return the exact spec-check and reviewer roster, model bindings, context references, request identities, and result slots required for the current Wave.
- FR-013: The Wave Gate MUST derive missing-evidence recovery from the exact active Review Run and MUST request only missing or invalid reviewer slots against the original immutable review authority.
- FR-014: The Wave Gate MUST detect whether the canonical critical Finding set is empty and MUST NOT prepare or run an empty Refutation Panel.
- FR-015: The Wave Gate MUST transition a critical-bearing review into the Refutation Panel without caller-authored Finding sets, manifests, event journals, lens ordering, or verdict-slot metadata.
- FR-016: The Wave Gate MUST identify advisory triage as a user action and MUST NOT silently accept, dismiss, or remediate an advisory.
- FR-017: The Wave Gate MUST complete only when every canonical completion prerequisite passes and MUST report all failed prerequisites otherwise.
- FR-018: Re-running or resuming the Wave Gate against unchanged accepted evidence MUST produce the same state and next action without duplicating packets, review runs, Findings, or external publications.

### Persistent Panel Sessions

- FR-020: A panel session MUST derive its immutable item set and exact ordered lenses or criteria from authoritative run inputs.
- FR-021: A panel session MUST persist its current state, accepted result identities, retry consumption, and terminal outcome across process and parent-session interruption.
- FR-022: Every emitted panel spawn request MUST have a unique request identity bound to exactly one run, Agent role, canonical slot, model binding, context reference, and attempt number.
- FR-023: A caller MUST submit a raw semantic result using only its engine-issued request identity; canonical lens, criterion, candidate, Finding, and output-slot identity MUST be inferred from that authority rather than trusted from caller repetition.
- FR-024: A panel session MUST reject malformed, stale, mismatched, duplicate, missing, and surplus results without changing unrelated accepted slots.
- FR-025: Each failed panel slot MUST permit no more than one retry, and a failed retry MUST place the session in a terminal blocked state with diagnostics.
- FR-026: Panel aggregation or tally MUST remain unavailable until every canonical slot has one valid accepted result.
- FR-027: Valid results MAY complete in any order, but completion order MUST NOT change canonical slot assignment, retry policy, final outcome, or next-action derivation.
- FR-028: Refutation Panel decisions MUST preserve the existing strict-majority rule, treat uncertainty as neither refutation nor support, favor retaining a Finding on ties, and retain every refuted Finding with its lenses and reasoning.
- FR-029: Architecture and refutation lens vocabularies MUST remain separate and MUST NOT be merged.

### Standalone Review and Automatic Raw Capture

- FR-030: One Standalone Review preparation operation MUST derive or accept an exact non-empty scope, record review metadata, select the deterministic reviewer roster, create a fresh run authority, bind exact models, reserve distinct immutable transcript slots, and return one spawn batch.
- FR-031: Standalone Review scope MUST be either the explicit user scope or the canonical changed-path union; empty, ambiguous, external, or unsafe scope MUST block rather than broaden.
- FR-032: The reviewer roster and transcript slots MUST be frozen before spawn and MUST NOT be reduced later to make incomplete evidence appear complete.
- FR-033: Pi and Claude Code MUST capture each completed standalone reviewer or verifier output directly into its engine-declared slot without the parent copying, transforming, shell-embedding, or publishing that output.
- FR-034: Captured raw output MUST remain byte-for-byte unchanged from the harness-reported Agent result.
- FR-035: Every expected transcript slot MUST be distinct and immutable, and capture MUST reject wrong-run, wrong-Agent, wrong-request, missing, duplicate, mismatched, stale, and surplus results.
- FR-036: Standalone review capture, aggregation, panel adjudication, and finalization MUST NOT read or mutate an unrelated active State File.
- FR-037: Standalone aggregation MUST begin only when the exact frozen reviewer roster is complete and every transcript is validly bound.
- FR-038: A zero-critical Standalone Review Run MUST finalize without a Refutation Panel; a critical-bearing run MUST finalize only from the completed canonical panel outcome.
- FR-039: The authoritative standalone result MUST distinguish surviving critical Findings, refuted critical Findings, and advisory Findings, retaining source Agent, scope, and adjudication evidence.

### Immutable Agent Context and Model Bindings

- FR-040: Every engine-authored spawn request MUST include the semantic Agent role and exact harness-specific model binding required for that role.
- FR-041: Every engine-authored spawn request MUST reference immutable, integrity-bound context containing the complete variable Task, plan, spec, review, lens or criterion, required Skill, output contract, and request identity applicable to that Agent.
- FR-042: The parent-facing spawn request MUST use a compact context reference and MUST NOT repeat the full fixed rules or contracts already present in the referenced context.
- FR-043: Context accepted for a spawn MUST remain unchanged for the life of that request, and context tampering or drift MUST block result acceptance.
- FR-044: Existing model and Skill gates MUST continue to validate every spawn and MUST fail closed on missing, inherited, or mismatched bindings.
- FR-045: Pi spawn requests MUST require zero explicit per-Agent model-profile lookup by the parent.

### Canonical Status and Next Action

- FR-050: `/loom --status` MUST provide both human-readable status and a machine-consumable representation of the same canonical facts.
- FR-051: Status MUST report active Phase and Wave; pending, running, implemented, blocked, and completed Tasks; failed Proof Obligations; test readiness; Review Run roster gaps and evidence failures; active, advisory, resolved, and refuted Finding counts; Refutation Panel need; and Wave Gate completion eligibility.
- FR-052: Status MUST return exactly one typed next action and the complete set of reasons supporting it.
- FR-053: Status and executable programs MUST consume the same readiness and next-action derivation; status MUST NOT introduce a second, divergent validation policy.
- FR-054: Missing, malformed, stale, or contradictory authority MUST produce a blocked status and MUST NOT be interpreted as ready, complete, or safe to advance.

### Remediation Audit and Staging

- FR-060: Remediation MUST begin from the exact scope in the authoritative standalone result and MUST maintain an auditable set of authorized remediation paths.
- FR-061: New regression-test and support paths MUST be explicitly added to remediation authority before they can be accepted for staging.
- FR-062: Dirty-path derivation MUST account for additions, modifications, renames, deletions, and scoped paths absent from the current revision.
- FR-063: Audit and staging MUST fail when any dirty or staged path falls outside remediation authority and MUST identify every discrepancy.
- FR-064: Staging MUST include exactly the audited dirty set and MUST publish canonical evidence comparing audited, dirty, and staged path sets.
- FR-065: Run Directory artifacts and review evidence MUST never be included in a remediation commit.
- FR-066: Pre-existing unrelated user changes MUST remain byte-for-byte unmodified and unstaged unless the user explicitly registers them as remediation work.
- FR-067: A failed audit or staging attempt MUST leave the existing index and unrelated user changes unchanged.

### Data, State, Access, and Audit Lifecycle

- FR-070: Every executable orchestration session MUST have a fresh unique run identity and MUST NOT implicitly reuse an older Run Directory or terminal session.
- FR-071: Run authority, request identities, exact rosters, ordered slots, immutable context, raw transcripts, accepted outcomes, retries, Findings, and final decisions MUST remain associated with their originating run.
- FR-072: Accepted run artifacts and audit history MUST remain immutable and retained until an explicit operator cleanup; this feature MUST NOT expire or delete them automatically.
- FR-073: Partial publication MUST never appear as successful completion; after interruption the run MUST expose either the last complete accepted state or a blocked recoverable state.
- FR-074: Replaying accepted program history MUST be idempotent, while re-submitting an already-consumed external result MUST be rejected as a duplicate.
- FR-075: Done and terminal blocked states MUST be monotonic: stale, late, or surplus results MUST NOT reopen or mutate them.
- FR-076: Only Loom's existing protected state authority may mutate orchestration state; this feature MUST NOT establish a second State File writer.
- FR-077: Semantic Agent output MUST have no authority until it is matched to an issued request, validated against its exact slot and run, and accepted by Loom.
- FR-078: Only the user may supply genuine advisory-triage or policy decisions; Agents and deterministic operations MUST NOT fabricate user approval.
- FR-079: Operators MUST be able to inspect the complete run history, request-to-result bindings, retries, blocked reasons, Finding dispositions, and final decision without altering them.

### Error and Recovery Behavior

- FR-080: Every blocked action MUST provide a user-visible diagnostic containing the affected run, request or slot when applicable, failure category, retry eligibility, and next permissible recovery action.
- FR-081: Missing evidence, malformed results, authority drift, stale requests, partial publication, helper failure, path mismatch, and harness attribution failure MUST all fail closed.
- FR-082: Recovery MUST preserve every previously accepted valid result and MUST request only work that remains legitimately pending.
- FR-083: No recovery path MAY broaden review scope, shrink an expected roster, lower a refutation threshold, overwrite an immutable slot, reconstruct raw evidence through the parent, or bypass a model or Skill gate.
- FR-084: A helper or harness failure MUST NOT report the affected program, review, panel, staging action, or Wave Gate as complete.

---

## Non-Functional Requirements

### Efficiency

- NFR-001: On the approved benchmark, the new interface MUST reduce parent-authored orchestration Bash/JSON command characters by at least 80% relative to the legacy interface.
- NFR-002: On the approved benchmark, the new interface MUST reduce deterministic-orchestration parent tool calls by at least 70% relative to the legacy interface.
- NFR-003: The approved benchmark MUST contain zero parent-authored `jq`, Panel Program journals, raw-output shell embedding, manual transcript publication, and explicit per-Agent Pi profile lookup.
- NFR-004: Parent-supplied Agent requests MUST contain zero repeated full copies of fixed rules or output contracts when those bytes are available through the immutable context reference.

### Reliability and Consistency

- NFR-010: All deterministic transition, artifact, roster, slot, retry, and final-decision outcomes MUST be reproducible from the same authoritative inputs.
- NFR-011: Event replay MUST be idempotent for 100% of generated replay cases, and terminal states MUST remain monotonic for 100% of generated late-result cases.
- NFR-012: Exact roster and slot conservation MUST hold for 100% of generated valid and invalid result sequences: no expected identity is lost, duplicated, invented, or silently replaced.
- NFR-013: Fault injection at every artifact-publication boundary MUST yield zero falsely complete runs and zero partially authoritative outcomes.
- NFR-014: Pi and Claude Code MUST produce equivalent canonical outcomes for 100% of approved cross-harness integration fixtures.

### Security and Integrity

- NFR-020: Authority artifacts MUST reject unsafe, external, ambiguous, or redirected paths and MUST never follow a path to unrelated protected state or run data.
- NFR-021: Untrusted Agent prose MUST appear in zero parent-authored shell commands and MUST have zero ability to choose its run, slot, lens, criterion, Finding identity, model binding, or publication destination.
- NFR-022: Duplicate, missing, malformed, mismatched, stale, and surplus evidence MUST fail closed in 100% of fault-injection cases.
- NFR-023: Run evidence MUST appear in zero remediation commits across the benchmark and integration test suites.

### Harness Parity and Auditability

- NFR-030: Pi and Claude Code MUST expose the same domain actions, blocked reasons, retry limits, and final decisions even where their native completion mechanisms differ.
- NFR-031: Every accepted semantic result MUST be traceable to exactly one run, issued request, Agent role, model binding, immutable context, canonical slot, and attempt.
- NFR-032: Documentation MUST contain zero parent-executable recipes for deterministic operations transferred to engine ownership; explanatory domain rules and genuine external actions remain documented.

---

## Success Criteria

Measurable outcomes that define done:

- SC-001: The approved replay benchmark shows at least 80% fewer parent-authored orchestration Bash/JSON command characters than the legacy interface.
- SC-002: The approved replay benchmark shows at least 70% fewer deterministic-orchestration parent tool calls than the legacy interface.
- SC-003: Across all benchmark scenarios, the parent authors exactly 0 `jq` expressions, 0 Panel Program journals, 0 shell commands embedding raw Agent output, 0 manual transcript publication operations, and 0 explicit per-Agent Pi profile lookups.
- SC-004: A normal no-critical two-Task Wave requires exactly 1 Wave Gate preparation/resume operation and 1 returned review spawn batch before semantic results are supplied, with 0 parent-authored packet, model, prompt-contract, or state-inspection loops.
- SC-005: Every Standalone Review Run requires exactly 1 preparation operation and 1 returned reviewer spawn batch before semantic results are supplied, with 0 parent transcript Write, Edit, or Bash publication calls.
- SC-006: Pi and Claude Code produce equivalent canonical artifacts, exact rosters and slots, Finding dispositions, next actions, and gate decisions for 100% of the approved replay fixtures.
- SC-007: Automatic capture preserves 100% byte equality between each harness-reported raw reviewer or verifier output and its canonical raw transcript artifact.
- SC-008: Aggregation and tally reject 100% of injected missing, duplicate, malformed, stale, mismatched, and surplus result cases before canonical finalization.
- SC-009: Interruption after every accepted action boundary resumes without duplicate publication, duplicate spawn requests for accepted slots, lost retry consumption, or changed final outcome in 100% of benchmark interruption points.
- SC-010: Batch-atomic Wave review preparation publishes either 100% of required Task packets and requests or 0 spawnable requests in every injected preparation-failure case.
- SC-011: `/loom --status` and the active executable program agree on readiness, roster gaps, panel need, completion eligibility, and one next action in 100% of generated valid states.
- SC-012: Remediation audit correctly handles all additions, modifications, renames, deletions, and absent scoped paths in the approved fixture while staging 0 unauthorized paths and 0 Run Directory evidence paths.
- SC-013: Existing model and Skill gates reject 100% of injected missing, inherited, or mismatched Agent bindings after spawn requests become engine-authored.
- SC-014: Parent Agent spawn payloads contain 0 repeated full copies of fixed Agent rules or output contracts across the approved multi-Agent fixtures.
- SC-015: Runbooks contain 0 parent-executable Bash or JSON journal recipes for deterministic orchestration now owned by this feature.

**Measurement approach:** Compare sanitized legacy and new-interface transcript replays using identical initial authority and semantic Agent outputs. Count parent Bash/JSON command characters and classify parent tool calls before execution; verify canonical artifacts and decisions after execution. Supplement replay comparison with cross-harness integration tests, property-based event and roster tests, byte-equality checks, path-set assertions, and fault injection at result-validation, persistence, publication, resumption, and staging boundaries.

### Approved Benchmark Fixture

The replay benchmark MUST include all five scenarios:

1. One two-Task Wave with no critical Findings.
2. One Wave with missing reviewer evidence and one retry.
3. One Wave with both surviving and refuted critical Findings.
4. One Standalone Review Run with six reviewers and three refutation lenses.
5. One remediation that adds a regression test and deletes a scoped file.

For comparability, legacy and new runs MUST begin from equivalent authoritative inputs, receive equivalent semantic Agent results, and be evaluated against the same final gate and artifact expectations. Parent-authored orchestration Bash/JSON command characters are the characters in parent-created shell commands and JSON orchestration documents whose content is deterministically derivable from run authority. Deterministic-orchestration parent tool calls are parent calls used only to inspect, derive, materialize, validate, persist, retry, publish, or stage facts already determined by authoritative state, artifacts, or user arguments; semantic Agent spawns and genuine user decisions are excluded from that call class.

---

## Out of Scope

Explicitly NOT part of this feature:

- Replacing semantic implementation, code review, refutation reasoning, architecture design, remediation design choices, or advisory relevance decisions with deterministic automation.
- Spawning semantic Agents invisibly; every semantic spawn remains an explicit, auditable external action.
- A general-purpose workflow language or one generic domain program shared by architecture panels, Refutation Panels, and Wave Gates.
- Merging architecture and refutation lens vocabularies.
- Weakening Review Packet immutability, Review Run identity, exact reviewer rosters, Finding identity, Refutation Panel thresholds, evidence provenance, or fail-closed gates.
- Hiding advisory triage or other genuine user decisions.
- Parent-authored finding sets, reconstructed raw evidence, hand-authored panel outcomes, or caller-selected canonical verdict slots.
- Moving deterministic orchestration into larger prompts, copied runbooks, or shell scripts that become a new source of truth.
- A second writer or alternative source of truth for the protected State File.
- Automatic cleanup, expiration, or deletion of historical Run Directories and audit artifacts.
- Automatic remediation of refuted critical Findings or unaccepted advisories.
- Broad or unrestricted source-control staging outside the audited remediation authority.
- Relaxing model or Skill binding validation for either supported harness.

---

## Open Questions

None. The approved discovery brief settles the WHAT-level scope, priorities, acceptance bars, failure behavior, integrations, and exclusions. Storage layout, delivery mechanism, command shape, compatibility sequencing, and other technical design choices belong to architecture.

---

## Dependencies

External factors and existing product capabilities this feature depends on:

- Loom's canonical Phase, Wave, Task, Proof Obligation, Review Packet, Review Run, Finding, Refutation Panel, Panel Program, Standalone Review Run, Run Directory, LLM Profile, and State File contracts.
- Existing protected-state authority and model/Skill spawn gates remaining available and fail-closed.
- Pi and Claude Code exposing attributable Agent spawn and completion identities sufficient to bind one result to one issued request.
- Semantic review, verification, architecture, and implementation Agents continuing to return their required result contracts.
- Source-control changed-path, index, and revision information being available for standalone scope and remediation audit.
- A user decision channel for advisory triage and other genuine policy choices.

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Deeper automation hides semantic Agent spawns or user decisions | High | Keep every semantic spawn and genuine decision explicit in the action vocabulary and audit history. |
| Automatic capture binds output to the wrong run or slot | High | Require exact request identity and fail closed on every attribution mismatch. |
| Interrupted publication creates an apparently complete but partial run | High | Treat publication completeness as an authority invariant and verify recovery at every boundary. |
| Status and program execution derive different readiness | High | Require one canonical derivation and parity assertions for every fixture. |
| Context compaction omits required Agent instructions | High | Bind complete immutable context to each request and reject drift before accepting results. |
| Remediation staging captures unrelated user work or run evidence | High | Audit exact path authority, preserve pre-existing changes, and compare dirty and staged sets before completion. |
| Harness-specific behavior weakens parity | High | Require equivalent transitions and canonical artifacts across the full approved replay fixture. |
| Automation merely moves procedural complexity into prompts or docs | High | Enforce benchmark character/call reductions and zero deterministic runbook recipes. |
| Historical artifacts are reused accidentally | Medium | Require fresh run identities and prohibit implicit consumption of prior Run Directories. |
| Strict fail-closed behavior increases visible blocked states | Medium | Return precise failure categories, retry eligibility, and next permissible recovery actions. |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Engine-owned action | A canonical action derived by Loom from authoritative inputs, rather than reconstructed by the parent Agent. |
| External action | Semantic Agent execution, genuine user decision, or required external publication that remains visible and auditable outside deterministic orchestration. |
| Executable orchestration session | A persistent run that owns deterministic state, accepted results, retries, next actions, and terminal outcome for one domain program. |
| Canonical slot | One exact ordered destination for a semantic result, derived from run authority and bound to an issued request. |
| Immutable context | Integrity-bound Agent context that cannot change for the life of its spawn request. |
| Automatic raw capture | Direct publication of harness-reported Agent output to its declared immutable slot without parent reconstruction or copying. |
| Deterministic-orchestration parent tool call | A parent tool call used only for work already determined by authoritative state, artifacts, or user arguments. |
| Parent-authored orchestration Bash/JSON characters | Characters in parent-created shell commands and JSON orchestration documents used to perform deterministic orchestration. |
| Batch-atomic preparation | Preparation in which every required item becomes available together, or none becomes spawnable. |
| Terminal monotonicity | A done or terminal blocked run cannot regress or change because of stale, late, duplicate, or surplus input. |
| Remediation authority | The exact audited set of paths permitted to change and be staged for an adjudicated remediation. |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-08-09 | Initial specification from approved transcript-driven orchestration discovery brief | specify-agent |
