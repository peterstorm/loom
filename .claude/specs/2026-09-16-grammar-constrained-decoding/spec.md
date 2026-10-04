# Feature: Grammar-Constrained Decoding for Loom's Structured Agent Payloads

**Spec ID:** 2026-09-16-grammar-constrained-decoding
**Created:** 2026-09-16
**Status:** Revised 2026-09-19 — feasibility and fresh plan alignment required before execution
**Owner:** Loom maintainer (roadmap churn row 1)

## Summary

Reviewer/judge/verifier payload generation uses per-kind emission tools and provider-side structured outputs where the exact issued schema is supported. This reduces generation failures for constraints the provider actually enforces; engine-only refinements, issuance joins, refusals and incomplete output still require engine validation. PR #52's fail-closed final-message extraction remains unchanged on the extraction path. New emission ambiguity rules are explicit rather than described as identical to the old pipeline. Success is measured against an extraction-only baseline on matched current-runtime tasks, not inferred from schema byte identity or model agreement.

---

## User Scenarios

### US1: [P1] Grammar-Constrained Payload Emission on Capable Providers

**As a** payload-producing agent (reviewer, judge, or verifier kind) spawned by the engine
**I want to** emit my structured payload through a per-kind emission tool whose parameters are the exact frozen payload schema
**So that** provider-enforced structural constraints hold during generation and fewer payload-format retries are needed

**Why this priority:** The paired core (emission tool + ingestion preference) is the feature; each half is meaningless without the other. It serves every cataloged producer kind, but this feature does not claim that payload formatting is the dominant source of implementation defects.

**Acceptance Scenarios:**
- AS-001: Given a Pi request enabled for emission on a qualified provider/model/schema route, when its child session starts model execution, then the exact issued producer kind/version tool is registered and active and its parameter schema byte-matches the issued frozen schema
- AS-002: Given a capable route and one emission call, when the complete arguments satisfy both the engine parser and the existing issuance joins, then they are ingested as the canonical payload; provider JSON Schema conformity alone is not engine acceptance
- AS-003: Given emission-tool arguments present and valid alongside a final message, when the ingestion seam selects the canonical payload, then the arguments win deterministically and final-message extraction is not consulted
- AS-004: Given a declared capable route and a calibration window, when completed emission calls are audited, then zero retries are attributed to violations of the JSON Schema constraints that route was verified to enforce; engine-only refusals, extraction failures, non-emission, duplicate calls and unavailable raw-argument observations are reported separately

### US2: [P1] Deterministic Fail-Closed Fallback Preserved

**As an** operator running loom across providers of varying capability
**I want to** keep PR #52's fail-closed extraction as the deterministic fallback for every provider
**So that** extraction remains available on routes without constrained sampling and the engine never chooses between competing emission interpretations

**Why this priority:** Capability-aware degradation must preserve the old extraction behavior without pretending that the newly introduced emission-call rules are part of the no-op baseline.

**Acceptance Scenarios:**
- AS-005: Given a route without strict sampling, when a producer runs, then requesting preferred constraints does not fail merely because strict mode is unsupported; zero emission calls uses the old extraction path unchanged, while any observed emission calls follow FR-003/FR-006/FR-007
- AS-006: Given a model that emits a prose/fence-wrapped payload instead of calling the emission tool, when the ingestion seam selects the canonical payload, then deterministic fail-closed extraction engages and admits it (or rejects zero-candidate/ambiguity) exactly as today
- AS-007: Given exactly one emission call whose arguments the engine refuses, when selection runs, then those arguments are never ingested; a usable final message may be accepted through unchanged extraction with the emission refusal recorded, otherwise one rejection consumes the existing request-slot attempt, with at most attempt 2 and no separate emission retry budget

### US3: [P1] Observable Provenance of Payload Source

**As an** operator auditing ingested payloads
**I want to** every payload to record its source (emission-tool arguments vs final-message extraction)
**So that** fallback engagement and capability degradation are observable without new user-facing UI

**Why this priority:** Provenance was chosen as the fallback signal in the interview; without a recorded source, fallback engagement is silent and unauditable, which hides the exact behavior the feature exists to improve.

**Acceptance Scenarios:**
- AS-008: Given any ingested payload, when its engine-side metadata is inspected, then it records the payload's source (emission-tool arguments vs final-message extraction)
- AS-009: Given fallback engaged (prose/fence admission or capability degradation), when the ingested payload's recorded source is inspected, then it shows extraction, making fallback engagement observable

### US4: [P1] Hard Fail When the Emission Tool Is Missing

**As an** operator spawning payload agents
**I want to** payload-agent spawns to refuse to run when the emission tool cannot be provided
**So that** silent under-capability never produces confusing failures downstream

**Why this priority:** A spawn that proceeds without the tool runs unconstrained with no signal — the "under-planned batch spawns a writer with no capability and fails confusingly at its first edit" confusion class. Failing fast and loud is a deliberate ruling from the interview.

**Acceptance Scenarios:**
- AS-010: Given an emission-enabled Pi request whose exact tool is unavailable, inactive or bound to the wrong schema, when child startup is attempted, then no model request is sent and the parent receives a bounded actionable startup failure; a notification, swallowed hook exception or parent revision match alone is insufficient. Explicit extraction-only routes, including Claude Code, remain admitted
- AS-011: Given a spawn retried after the emission tool becomes available, when the payload agent runs, then behavior is identical to any successful run (idempotent — no residual state from the failed attempt)

**Note:** Route selection and startup failure are different facts. A provider ignoring preferred strict sampling may still use unconstrained emission tools. A route that cannot accept the exact tool schema is explicitly extraction-only and must not advertise that tool. Claude Code and historical reviewer protocols without a supported emission schema are extraction-only. Once issuance selects an emission-enabled Pi route, a missing child capability is an infrastructure failure, not permission to silently change that route. Remediation names the actual cause; `/reload` is appropriate for stale Loom resources, not a universal cure for provider schema rejection.

### US5: [P1] Wire Contract and Docs Updated to Tool-Primary

**As an** agent author or protocol consumer
**I want to** the frozen wire contract to name the emission tool as the primary emission path, with final-message extraction described as the deterministic fallback only
**So that** there is one schema and one contract, and operators know which provider capability flags to configure

**Why this priority:** The wire contract is the frozen protocol; shipping behavior without updating it forks the contract. Docs updates (agent README, model-profile docs) ship with the feature per the interview ruling.

**Acceptance Scenarios:**
- AS-012: Given a newly issued emission-enabled request, when its wire instructions are rendered, then they name the exact tool as the primary final action, prohibit re-emitting within the same spawn, and describe extraction as fallback; explicit extraction-only requests retain final-message instructions, and archived issued contracts are not rewritten
- AS-013: Given the emission tool's parameter schema for any kind, when compared against the frozen payload schema bytes, then they are byte-identical (one schema, no second contract)
- AS-014: Given the agent README and model-profile docs, when consulted, then they describe the emission-tool flow and state that provider capability flags remain user-side configuration

### US6: [P2] Calibration Gate for Quality and Latency

**As an** operator declaring the feature done
**I want to** output quality and latency measured against the agreed guardrail over a calibration window
**So that** grammar-constrained decoding on the large reviewer schema is not shipped with a quality or latency regression

**Why this priority:** Constrained decoding on large schemas can affect output quality/latency on some backends; the interview ruled this a calibration gate (must be measured before done), not a design driver.

**Acceptance Scenarios:**
- AS-015: Given matched calibration workloads, when wall-clock from initial producer dispatch through accepted ingestion is measured including startup, follow-up turns and retries, then p95 is no worse than +25% versus extraction-only operation on the same runtime; terminal failures are separately reported and never silently dropped
- AS-016: Given a calibration window, when escaped-defect severity is compared against the PR #52-only baseline, then it is not worse
- AS-017: Given calibration measurement complete, when the feature is declared done, then the preregistered workload, sample size, route/schema matrix, fallback and retry rates, latency distribution, terminal failures and escaped-defect-severity comparisons are retained; a violated guardrail or missing required measurement blocks a done claim
- AS-018: Given arguments that conform to the frozen JSON Schema but violate an engine-only refinement, when the tool or ingestion parser evaluates them, then they are refused and not reported as provider-guaranteed valid; whitespace-only reviewer prose is one regression case
- AS-019: Given two distinct emission calls in one request attempt, including an invalid call followed by a corrected call, when capture selects a source, then ambiguity rejects the attempt even if a final message is valid; exact transport replay of one call is not a second model call
- AS-020: Given missing, stale, contradictory or wrong-request child readiness, when startup is exercised against a counting provider substitute, then zero model requests occur and only matching reservations are cleaned up
- AS-021: Given successful tool execution as the sole terminal tool result, when the child settles, then ingestion succeeds without an extra assistant final message or follow-up model turn; mixed-tool batches retain Pi's documented termination semantics and duplicate detection
- AS-022: Given the first production vertical slice, when its acceptance controls bypass canonical selection or replace acceptance with always-accept/always-reject behavior, then the relevant tests fail; helper-only tests do not establish production integration
- AS-023: Given the exact v2/v3 reviewer and v1 judge/refutation schemas on each declared route, when qualification runs, then actual request acceptance and observed constraint support are recorded; unsupported routes are explicitly extraction-only without schema rewriting or provider-specific payload construction

---

## Functional Requirements

### Core Requirements

- FR-001: Each emission-enabled Pi request MUST provide its exact issued producer kind/version tool with parameters derived from the issued frozen schema bytes; catalog and authenticated request context determine identity, never unverified prompt text. Explicit extraction-only requests advertise no unsupported emission tool
- FR-002: The emission tool MUST request JSON-schema constrained sampling with preferred rather than required strict support, using the harness capability resolver; only independently qualified provider/model/schema routes may be described as capable
- FR-003: The ingestion seam MUST additively prefer emission-tool arguments, when present and valid, over final-message extraction — a deterministic choice, never a choice between interpretations
- FR-004: The system MUST retain PR #52's fail-closed extraction verbatim as the deterministic fallback for every provider
- FR-005: The fallback path MUST stay fail-closed for every provider (prose/fence admission, zero-candidate and ambiguity rejection, bounded retry)
- FR-006: Exactly one refused emission call MUST never supply ingested arguments. Selection MUST retain its refusal reason and use unchanged final-message extraction; usable fallback consumes no retry, while failed fallback rejects once through the existing request-slot attempt budget. Attempt 1 may advance to a fresh attempt-2 spawn; attempt-2 failure is terminal. No separate emission counter or same-spawn semantic retry is introduced
- FR-007: Two or more distinct emission calls within one issued request attempt MUST reject as ambiguity regardless of validity or final-message contents. Replay of the same observed call MUST be idempotent; contradictory records sharing call identity MUST refuse rather than deduplicate silently
- FR-008: An emission-enabled Pi child MUST NOT send a model request before its actual registered and active tool matches the issued request, producer kind, version and schema digest. Startup observation MUST be bounded and fail explicitly on absent or contradictory readiness, without consuming semantic evidence retry authority; parent admission and the runtime revision handshake alone are not readiness proof
- FR-009: The system MUST record, in engine-side metadata, the source of every ingested payload (emission-tool arguments vs final-message extraction)
- FR-010: Unsupported strict sampling MUST NOT itself fail a producer request. Explicit extraction-only routes and attempts with zero emission calls MUST preserve existing extraction results; attempts with emission calls follow the new deterministic selection rules, not a claimed universal no-op equivalence
- FR-011: Captured emission-tool arguments MUST inherit the existing transcript/engine payload retention; no new retention, expiration, or deletion policy is introduced
- FR-012: The ingress seam MUST retain the issuance-join checks (frozen scope, packet/generation binding, prior-assessment ordering) regardless of emission-tool availability
- FR-013: Successful emission execution MUST return a minimal acknowledgment and use the harness's terminating-tool mechanism; it MUST NOT require an additional assistant final message. Failed validation remains an explicit refusal, never a successful tool result
- FR-014: Emission observations MUST be bound to the issued request attempt and tool-call identity, preserving complete versus incomplete/failed observations. Unexpected producer kinds or schema versions MUST NOT select their own decoder or silently become absence

### Contract and Docs Requirements

- FR-020: Newly issued emission-enabled wire instructions MUST name the exact tool as the primary final action and extraction as fallback; extraction-only and archived issued contracts MUST preserve their appropriate final-message contract
- FR-021: The system MUST NOT emit a second, parallel schema outside the frozen payload schema bytes (one schema, no second contract)
- FR-022: The agent README and model-profile docs MUST be updated to describe the emission-tool flow, and MUST state that provider capability flags remain user-side configuration with loom contributing documentation only

### Integration Requirements

- FR-030: The system MUST obtain constrained sampling through the agent engine's existing constrained-sampling capability, and MUST NOT build a second provider payload serialization outside it
- FR-031: Extension and engine changes MUST remain compatible with the engine's existing content-addressed revision handshake
- FR-032: Before broad integration, the feature MUST qualify its exact schema/provider routes and demonstrate one real request-to-ingestion vertical slice with discriminating success and failure controls. Missing provider access or launcher capability MUST remain an explicit implementation prerequisite, not a claimed pass

---

## Non-Functional Requirements

### Performance

- NFR-001: Dispatch-to-accepted-ingestion wall-clock on capable routes MUST be no worse than +25% versus the matched extraction-only baseline, measured p95 including retries; terminal-failure rate MUST NOT increase
- NFR-002: The emission tool MUST serve all concurrently spawned payload agents in a wave without serializing them beyond today's behavior

### Reliability

- NFR-010: The fallback path MUST remain fail-closed for every provider: prose/fence admission, zero-candidate and ambiguity rejection, bounded retry
- NFR-011: Extraction-only routes and zero-emission observations MUST preserve the prior extraction contract. Lack of strict support MUST NOT introduce a request failure; emission-call refusals and ambiguity remain explicit new protocol outcomes

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: On qualified capable routes, zero retries are caused by violations of the verified provider-enforced JSON Schema constraints in complete emission calls; engine-only refinements, incomplete output, duplicate calls, extraction failures and raw-byte observation limits are accounted separately
- SC-002: Dispatch-to-accepted-ingestion wall-clock on capable routes, including retries, is no worse than +25% versus the matched extraction-only baseline (p95), without an increased terminal-failure rate
- SC-003: Escaped-defect severity is not worse than the PR #52-only baseline over the calibration window
- SC-004: 100% of ingested payloads record their source (emission-tool arguments vs final-message extraction) in engine-side metadata
- SC-005: Zero emission-enabled Pi children send model requests without exact child readiness; explicit extraction-only routes, including Claude Code, retain extraction behavior
- SC-006: 100% of per-kind emission-tool parameter schemas byte-match the frozen payload schema bytes
- SC-007: No strict-capability request failures or changed extraction outcomes occur on the qualified degraded routes; observed emission-specific failures are reported rather than hidden as baseline equivalence
- SC-008: The production vertical slice passes success/refusal acceptance and fails its relevant bypass/always-accept/always-reject controls before breadth expansion

**Measurement approach:** Preregister matched inputs, provider/model/runtime identity, exact schema digests, sample size and latency/quality methodology before collecting results. Compare emission-enabled versus extraction-only operation on the same frozen runtime and input corpus; retain PR #52 as the extraction contract, not an unrelated historical environment. Measure dispatch-to-accepted-ingestion latency, all terminal failures, tool-use/fallback rates, retry causes, and independent quality judgments. Report engine validation separately from provider guarantees, and never infer unobserved raw duplicate-key behavior from already parsed arguments.

---

## Out of Scope

Explicitly NOT part of this feature:

- OOS-001: General infrastructure for the other churn-informed roadmap rows (rows 2–9), including a mutation-testing platform, family-repair checklist, tool-schema minimization, generic deadlines, retry transactions, convergence diagnosis, delta debugging and Historical RED. Feature-local acceptance controls and bounded startup observation are in scope; implementing the vault's G5 sequence is not
- OOS-002: Issuance-join constraint elimination (frozen scope, packet/generation binding, prior-assessment ordering) — ingress keeps those checks regardless
- OOS-003: Task-graph/decompose payloads (decompose-agent output piped via CLI stdin to populate-task-graph) — explicitly out, deferred to its own future spec/roadmap row
- OOS-004: Fugue-repo changes, LoopRegions, Best-of-N sampling, more reviewer lenses, higher reasoning budgets everywhere, any general Loom-to-Fugue rewrite

---

## Open Questions

Forced per-request tool selection is not part of this design: tool calls remain model-initiated, with extraction fallback. `terminate: true` addresses the extra turn after a successful emission, not forced selection.

Two technical prerequisites must be discharged before broad implementation: live acceptance of the exact schemas on the intended routes, and an actual pre-model child readiness barrier in the launcher. The revised Plan names the probes, blockers and ownership decision; neither is assumed from a capability flag or parent revision hash.

---

## Dependencies

External factors this feature depends on:

- The harness's existing JSON-schema constrained-sampling resolver; grammar-only backend support does not automatically imply support for this JSON-schema tool configuration
- The frozen payload schema bytes and their content-addressed digest recorded in the reviewer protocol, stamped from a single-source fragment via the stamp script
- PR #52's fail-closed extraction, already merged, retained verbatim as the deterministic fallback
- Cataloged payload-producer kinds in the engine's model profiles
- Loom's extension loading in spawned child sessions (global package) and its existing custom-tool registration seam
- Operator-side provider capability configuration (user-side model compat flags)

---

## Risks

Known risks and mitigation thoughts (not solutions):

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Constrained decoding on the large reviewer schema can affect output quality/latency on some backends | Med | P2 calibration gate (US6); revisit before ship if the +25% p95 bound is violated |
| Hard fail on a missing emission tool makes the observed extension-load failure class louder: a spawn fails where it previously degraded silently | Med | Clear, actionable error naming the missing capability; loud-and-immediate is preferred over silent-and-confusing, and the deterministic fallback still covers provider-capability gaps |
| Provenance metadata could drift from the actual source if fallback logic changes later | Low | Provenance is recorded at ingestion time by the same deterministic seam that selects the source |
| Duplicate-call rejection discards same-spawn corrections | Med | Explicitly prohibit same-spawn re-emission; recover through usable final-message fallback after one refusal or a fresh engine-issued attempt, within the existing slot budget |
| Frozen JSON Schema is rejected by a provider or omits Zod refinements | High | Qualify exact route/schema pairs before breadth expansion; retain engine parsing and explicit extraction-only routes without rewriting frozen schema bytes |
| Startup diagnostics do not actually stop a child | High | Require an observed pre-model readiness barrier and zero-request negative controls; missing launcher support blocks integration |
| Live seam gap from the brainstorm (a spawn with no scoped Pi write grant fails confusingly at its first edit) | Med | Defect context only — belongs to a defect row/triage outside this feature's scope; named here per interview ruling |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Emission tool | Per-kind tool registered in payload-agent child sessions whose parameters are the exact frozen payload schema bytes; the constrained path for payload production |
| Payload producer | Agent kind cataloged in the engine's model profiles (reviewer, judge, verifier) that emits structured payloads |
| Capable route | Exact provider/model/API and schema-digest combination qualified to accept and enforce the declared JSON Schema constraints; a generic capability flag is insufficient |
| Fail-closed extraction | PR #52's deterministic final-message extraction: prose/fence admission, zero-candidate and ambiguity rejection, bounded retry |
| Ingestion seam | The subagent-stop/orchestration-result seam where the engine selects the canonical payload |
| Constrained sampling | Preferred provider-side JSON Schema constraint through the harness resolver; not a promise that engine-only refinements or issuance joins hold |
| Provider-enforced structure | The supported JSON Schema constraints demonstrated for a capable route; separate from descriptions, non-JSON-Schema Zod refinements, global byte bounds and issuance joins |
| Issuance-join constraints | Frozen scope, packet/generation binding, prior-assessment ordering — not expressible in a standalone schema; stay at ingress |
| Wire contract | The frozen, versioned protocol text describing how payload agents emit payloads, stamped from a single-source fragment |
| Schema digest | Content-addressed digest of the frozen payload schema bytes recorded in the reviewer protocol |
| Bounded retry | The existing request-slot semantic attempts 1 and 2; emission and extraction failures share this budget, with separately recorded causes |
| Determinism thesis | The engine never chooses between interpretations; the ingestion preference is additive and deterministic |
| Capability-aware degradation | Explicit extraction-only routing when the exact tool schema cannot be supported, or unconstrained tools when preferred strict mode is unavailable; zero-emission extraction preserves the prior contract |
| Fallback signal | The observable indicator that the fallback path engaged — realized here as recorded payload provenance |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-16 | Initial draft from brainstorm + full specify interview | specify-agent |
| 2026-09-16 | FR-008/US4/SC-005 scoped per-harness: the US4 hard fail applies to Pi payload-producer spawns (where the /reload remediation exists); Claude Code payload-producer spawns are the documented capability-aware-degradation class (extraction) — gap-report re-run round 2 ruling | architecture-agent |
| 2026-09-19 | User-authorized revision: distinguish provider structure from engine acceptance; resolve emission/fallback retry semantics using the existing slot budget; require actual child readiness and terminating emission; add exact-route qualification, early production acceptance and bounded calibration. FR-006/FR-007 replace the earlier separate-budget wording; explicit unsupported-schema extraction routing refines FR-001/FR-008/FR-010. G5 unchanged | coding assistant |
