# Feature: Grammar-Constrained Decoding for Loom's Structured Agent Payloads

**Spec ID:** 2026-09-16-grammar-constrained-decoding
**Created:** 2026-09-16
**Status:** Draft
**Owner:** Loom maintainer (roadmap churn row 1)

## Summary

Reviewer/judge/verifier payload generation is routed through provider-side structured outputs so payloads parse by construction, eliminating the syntax-level churn class at generation instead of admitting it after the fact. PR #52's fail-closed extraction is retained verbatim as the deterministic fallback, so no provider or model regresses. This spec captures WHAT the feature must do and WHY, measured against the honest no-op baseline (approach C in the brainstorm), not against plausibility.

---

## User Scenarios

### US1: [P1] Grammar-Constrained Payload Emission on Capable Providers

**As a** payload-producing agent (reviewer, judge, or verifier kind) spawned by the engine
**I want to** emit my structured payload through a per-kind emission tool whose parameters are the exact frozen payload schema
**So that** my payload conforms by construction and no retry rounds are burned on syntax-level defects

**Why this priority:** The paired core (emission tool + additive ingestion preference) is the feature; each half is meaningless without the other. It targets the largest churn class — multi-turn reviewer spawns with bounded retries — and is profile-driven so every cataloged payload-producer kind benefits now and in the future.

**Acceptance Scenarios:**
- AS-001: Given a capable provider (one that honors JSON-schema strict sampling), when a payload-agent child session runs, then a per-kind emission tool is available whose parameter schema is byte-identical to the frozen payload schema for that kind
- AS-002: Given a capable provider, when the agent calls the emission tool, then the arguments conform to the frozen schema by construction and the engine ingests them as the canonical payload
- AS-003: Given emission-tool arguments present and valid alongside a final message, when the ingestion seam selects the canonical payload, then the arguments win deterministically and final-message extraction is not consulted
- AS-004: Given a capable provider and a calibration window of payload spawns, when the syntax-level classes are audited (invalid JSON, schema non-conformance, duplicate keys, depth violations), then zero bounded-retry rounds were consumed for them

### US2: [P1] Deterministic Fail-Closed Fallback Preserved

**As an** operator running loom across providers of varying capability
**I want to** keep PR #52's fail-closed extraction as the deterministic fallback for every provider
**So that** no provider or model regresses and the engine never chooses between interpretations

**Why this priority:** The determinism thesis is closed and must not reopen; the fallback path staying fail-closed is the guarantee that capability-aware degradation creates no new failure modes.

**Acceptance Scenarios:**
- AS-005: Given a provider that ignores the constraint (no strict mode, no grammar tools), when a payload agent runs, then the pipeline behaves exactly as today's pipeline (PR #52 extraction verbatim) with no new failure modes
- AS-006: Given a model that emits a prose/fence-wrapped payload instead of calling the emission tool, when the ingestion seam selects the canonical payload, then deterministic fail-closed extraction engages and admits it (or rejects zero-candidate/ambiguity) exactly as today
- AS-007: Given the emission tool was called but its arguments fail schema validation (possible on a degraded provider), when the ingestion seam selects the canonical payload, then the arguments are never ingested and one round of the separate emission-tool bounded-retry budget is consumed

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
- AS-010: Given the emission tool is not available in a Pi payload-agent child session (extension not loaded, registration failed), when the spawn proceeds, then it fails immediately with a clear, actionable error naming the missing capability and the /reload remediation instead of running unconstrained; a Claude Code payload-producer spawn is not refused — it degrades via extraction exactly as today (capability-aware degradation per harness)
- AS-011: Given a spawn retried after the emission tool becomes available, when the payload agent runs, then behavior is identical to any successful run (idempotent — no residual state from the failed attempt)

**Note:** This hard fail is distinct from capability-aware degradation. A provider *ignoring the constraint* still degrades silently to exactly today's pipeline (US2); only a *missing emission tool* on a harness where it is providable (Pi) — the constrained path itself being unavailable — refuses to spawn. A harness without a Loom extension seam (Claude Code) cannot provide the constrained path at all and is the documented capability-aware-degradation class: its payload-producer spawns proceed via extraction exactly as today (no provider or model regresses).

### US5: [P1] Wire Contract and Docs Updated to Tool-Primary

**As an** agent author or protocol consumer
**I want to** the frozen wire contract to name the emission tool as the primary emission path, with final-message extraction described as the deterministic fallback only
**So that** there is one schema and one contract, and operators know which provider capability flags to configure

**Why this priority:** The wire contract is the frozen protocol; shipping behavior without updating it forks the contract. Docs updates (agent README, model-profile docs) ship with the feature per the interview ruling.

**Acceptance Scenarios:**
- AS-012: Given the wire contract is rendered, when its payload-emission wording is read, then it instructs calling the emission tool as the primary path and describes final-message extraction as the deterministic fallback only (replacing the previous "Emit exactly one JSON object … No other final output." wording)
- AS-013: Given the emission tool's parameter schema for any kind, when compared against the frozen payload schema bytes, then they are byte-identical (one schema, no second contract)
- AS-014: Given the agent README and model-profile docs, when consulted, then they describe the emission-tool flow and state that provider capability flags remain user-side configuration

### US6: [P2] Calibration Gate for Quality and Latency

**As an** operator declaring the feature done
**I want to** output quality and latency measured against the agreed guardrail over a calibration window
**So that** grammar-constrained decoding on the large reviewer schema is not shipped with a quality or latency regression

**Why this priority:** Constrained decoding on large schemas can affect output quality/latency on some backends; the interview ruled this a calibration gate (must be measured before done), not a design driver.

**Acceptance Scenarios:**
- AS-015: Given a calibration window on a capable provider, when per-payload wall-clock is measured p95, then it is no worse than +25% versus today's pipeline
- AS-016: Given a calibration window, when escaped-defect severity is compared against the PR #52-only baseline, then it is not worse
- AS-017: Given calibration measurement complete, when the feature is declared done, then the p95 bound and escaped-defect-severity comparisons are recorded as evidence — and if the p95 bound is violated, the feature is not done and the design is revisited before shipping

---

## Functional Requirements

### Core Requirements

- FR-001: The system MUST provide, in every payload-agent child session, a per-kind emission tool whose parameter schema is the exact frozen payload schema bytes for that kind, scoped by cataloged producer kind (profile-driven) — never by prompt text
- FR-002: The emission tool MUST carry a constraint requiring JSON-schema strict sampling, so that capable providers grammar-constrain the tool arguments
- FR-003: The ingestion seam MUST additively prefer emission-tool arguments, when present and valid, over final-message extraction — a deterministic choice, never a choice between interpretations
- FR-004: The system MUST retain PR #52's fail-closed extraction verbatim as the deterministic fallback for every provider
- FR-005: The fallback path MUST stay fail-closed for every provider (prose/fence admission, zero-candidate and ambiguity rejection, bounded retry)
- FR-006: The system MUST treat emission-tool arguments that fail schema validation as never-ingestable, consuming the separate emission-tool bounded-retry budget — bounded to the same magnitude as the existing extraction bounded-retry
- FR-007: The system MUST treat duplicate emission-tool calls within a spawn as ambiguity, rejecting fail-closed to the emission-tool bounded-retry budget
- FR-008: The system MUST refuse to spawn payload-agent sessions in which the emission tool cannot be provided, failing fast with a clear, actionable error naming the missing capability and the remediation — scoped to harnesses where the emission tool is providable (Pi, where the /reload remediation exists); harnesses without a Loom extension seam (Claude Code) are the documented capability-aware-degradation class and proceed via extraction exactly as today, so no provider or model regresses
- FR-009: The system MUST record, in engine-side metadata, the source of every ingested payload (emission-tool arguments vs final-message extraction)
- FR-010: The system MUST regress to exactly today's pipeline, with no new failure modes, when the provider ignores the constraint
- FR-011: Captured emission-tool arguments MUST inherit the existing transcript/engine payload retention; no new retention, expiration, or deletion policy is introduced
- FR-012: The ingress seam MUST retain the issuance-join checks (frozen scope, packet/generation binding, prior-assessment ordering) regardless of emission-tool availability

### Contract and Docs Requirements

- FR-020: The wire contract MUST be updated to name the emission tool as the primary emission path, describing final-message extraction as the deterministic fallback only
- FR-021: The system MUST NOT emit a second, parallel schema outside the frozen payload schema bytes (one schema, no second contract)
- FR-022: The agent README and model-profile docs MUST be updated to describe the emission-tool flow, and MUST state that provider capability flags remain user-side configuration with loom contributing documentation only

### Integration Requirements

- FR-030: The system MUST obtain constrained sampling through the agent engine's existing constrained-sampling capability, and MUST NOT build a second provider payload serialization outside it
- FR-031: Extension and engine changes MUST remain compatible with the engine's existing content-addressed revision handshake

---

## Non-Functional Requirements

### Performance

- NFR-001: Per-payload wall-clock on capable providers MUST be no worse than +25% versus today's pipeline, measured p95
- NFR-002: The emission tool MUST serve all concurrently spawned payload agents in a wave without serializing them beyond today's behavior

### Reliability

- NFR-010: The fallback path MUST remain fail-closed for every provider: prose/fence admission, zero-candidate and ambiguity rejection, bounded retry
- NFR-011: On providers that ignore the constraint, observed behavior MUST be indistinguishable from today's pipeline — zero new failure-mode classes

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: On capable providers, zero bounded-retry rounds are consumed for syntax-level classes (invalid JSON, schema non-conformance, duplicate keys, depth violations) across the calibration window
- SC-002: Per-payload wall-clock on capable providers is no worse than +25% versus today's pipeline (p95)
- SC-003: Escaped-defect severity is not worse than the PR #52-only baseline over the calibration window
- SC-004: 100% of ingested payloads record their source (emission-tool arguments vs final-message extraction) in engine-side metadata
- SC-005: Zero Pi payload-agent spawns proceed without the emission tool available (hard fail verified); Claude Code payload-producer spawns are the documented capability-aware-degradation class (extraction, exactly as today)
- SC-006: 100% of per-kind emission-tool parameter schemas byte-match the frozen payload schema bytes
- SC-007: Zero new failure-mode classes observed on constraint-ignoring providers over the calibration window

**Measurement approach:** A calibration window on a capable provider, compared against the PR #52-only baseline (approach C) for retry rounds, wall-clock p95, and escaped-defect severity; plus deterministic checks (schema byte-match, provenance recording, hard-fail on missing tool, contract wording) verified by tests.

---

## Out of Scope

Explicitly NOT part of this feature:

- OOS-001: The other churn-informed roadmap rows (rows 2–9): mutation testing, family-repair checklist, tool-schema knob minimization, per-call tool deadlines, one-owner-per-fact, retry transactions, convergence diagnosis, delta debugging, Historical RED — each is its own row
- OOS-002: Issuance-join constraint elimination (frozen scope, packet/generation binding, prior-assessment ordering) — ingress keeps those checks regardless
- OOS-003: Task-graph/decompose payloads (decompose-agent output piped via CLI stdin to populate-task-graph) — explicitly out, deferred to its own future spec/roadmap row
- OOS-004: Fugue-repo changes, LoopRegions, Best-of-N sampling, more reviewer lenses, higher reasoning budgets everywhere, any general Loom-to-Fugue rewrite

---

## Open Questions

Questions requiring stakeholder input before finalizing:

1. Forced per-request tool selection (toolChoice) would make the tool call itself deterministic — not just its arguments — fully closing the grammar class; whether the per-request plumbing is reachable from loom's extension seam is an architecture-phase question [NEEDS CLARIFICATION: technical approach TBD — architecture phase resolves]

---

## Dependencies

External factors this feature depends on:

- The agent engine's existing constrained-sampling capability (capability resolution against providers, including strict-mode and grammar-tool variants)
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
| Duplicate-call rejection could discard valid work when a model legitimately re-emits | Low | Fail-closed to the separate emission-tool bounded-retry budget; the model re-emits within budget |
| Live seam gap from the brainstorm (a spawn with no scoped Pi write grant fails confusingly at its first edit) | Med | Defect context only — belongs to a defect row/triage outside this feature's scope; named here per interview ruling |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Emission tool | Per-kind tool registered in payload-agent child sessions whose parameters are the exact frozen payload schema bytes; the constrained path for payload production |
| Payload producer | Agent kind cataloged in the engine's model profiles (reviewer, judge, verifier) that emits structured payloads |
| Capable provider | Provider that honors JSON-schema strict sampling or grammar-tool constraints so tool arguments are grammar-constrained |
| Fail-closed extraction | PR #52's deterministic final-message extraction: prose/fence admission, zero-candidate and ambiguity rejection, bounded retry |
| Ingestion seam | The subagent-stop/orchestration-result seam where the engine selects the canonical payload |
| Constrained sampling | Provider-side constraint requiring generated payloads to conform to a schema (JSON-schema strict mode or grammar variants) |
| Syntax-level churn classes | Invalid JSON, schema non-conformance, duplicate keys, depth violations — each currently burns a bounded-retry round at generation |
| Issuance-join constraints | Frozen scope, packet/generation binding, prior-assessment ordering — not expressible in a standalone schema; stay at ingress |
| Wire contract | The frozen, versioned protocol text describing how payload agents emit payloads, stamped from a single-source fragment |
| Schema digest | Content-addressed digest of the frozen payload schema bytes recorded in the reviewer protocol |
| Bounded retry | Fixed-count retry rounds before failing closed |
| Determinism thesis | The engine never chooses between interpretations; the ingestion preference is additive and deterministic |
| Capability-aware degradation | Regressing to exactly today's pipeline, with no new failure modes, when a provider ignores the constraint |
| Fallback signal | The observable indicator that the fallback path engaged — realized here as recorded payload provenance |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-09-16 | Initial draft from brainstorm + full specify interview | specify-agent |
| 2026-09-16 | FR-008/US4/SC-005 scoped per-harness: the US4 hard fail applies to Pi payload-producer spawns (where the /reload remediation exists); Claude Code payload-producer spawns are the documented capability-aware-degradation class (extraction) — gap-report re-run round 2 ruling | architecture-agent |
