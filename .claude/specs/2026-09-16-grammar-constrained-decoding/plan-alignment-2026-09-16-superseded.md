# Plan Alignment Report

**Spec:** .claude/specs/2026-09-16-grammar-constrained-decoding/spec.md
**Plan:** .claude/plans/2026-09-16-grammar-constrained-decoding.md
**Date:** 2026-09-16

## Summary

No gaps found. Round 2 re-verification: both round-1 divergence areas are now covered — (1) payload scope is up (AD-6/AD-8: per-kind emission tools for all three cataloged producer payload kinds — reviewer-payload, judge-verdict, refutation-verdict — with catalog-derived `PayloadProducerKind` scoping, new frozen verdict schemas, and per-path ingestion folds), so US1/AS-004/SC-001 now cover judge-kind and verdict-slot spawns; and (2) Claude Code spawn behavior is resolved per the amended spec (AD-4/AD-7: the US4 hard fail is scoped to Pi payload-producer spawns with the `/reload` remediation; Claude Code declares `not-provided` with degradation `extraction` and proceeds exactly as today), so FR-008/US4/SC-005 are covered. One disclosed deviation is documented in the plan, not a gap: FR-002's literal "requiring" wording is realized as `strict: "prefer"` (AD-2) because `require` throws on constraint-ignoring providers — the requirement's substance (capable providers grammar-constrain the tool arguments) is satisfied and the deviation is explicitly documented. The executable-models policy check passed: INV-1 is correctly tiered `checkable` (a regex lint rule can check the stated property, and it is validated); the plan describes no prose lifecycle ("no second state model") and no unbound pipeline — its data flow threads new data through existing engine seams.

## Gaps

None.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| US1 | Grammar-constrained payload emission on capable providers (per-kind emission tool, additive ingestion preference, zero-retry syntax classes) | Covered |
| US2 | Deterministic fail-closed fallback preserved (PR #52 extraction verbatim, no new failure modes) | Covered |
| US3 | Observable provenance of payload source (emission-tool arguments vs final-message extraction) | Covered |
| US4 | Hard fail when the emission tool is missing (Pi refuses with /reload remediation; Claude Code degrades via extraction) | Covered |
| US5 | Wire contract and docs updated to tool-primary | Covered |
| US6 | Calibration gate for quality and latency (p95 +25%, escaped-defect severity, evidence recorded before done) | Covered |
| FR-001 | Per-kind emission tool in every payload-agent child session, exact frozen schema bytes, cataloged producer-kind (profile-driven) scoping, never prompt text | Covered |
| FR-002 | Emission tool carries a strict-sampling constraint so capable providers grammar-constrain the tool arguments | Covered (disclosed deviation: `strict: "prefer"` replaces the literal "requiring" wording — AD-2; `require` throws on constraint-ignoring providers, violating FR-010/NFR-011) |
| FR-003 | Ingestion seam additively prefers valid emission-tool arguments over final-message extraction — deterministic, never a choice between interpretations | Covered |
| FR-004 | PR #52's fail-closed extraction retained verbatim as the deterministic fallback | Covered |
| FR-005 | Fallback path stays fail-closed (prose/fence admission, zero-candidate and ambiguity rejection, bounded retry) | Covered |
| FR-006 | Invalid emission-tool arguments never-ingestable; separate emission-tool bounded-retry budget bounded to the same magnitude as the existing extraction bounded-retry | Covered |
| FR-007 | Duplicate emission-tool calls treated as ambiguity, fail-closed to the emission-tool bounded-retry budget | Covered |
| FR-008 | Refuse to spawn payload-agent sessions where the emission tool cannot be provided, per-harness scoped (Pi refuses with actionable error + /reload remediation; Claude Code proceeds via extraction exactly as today) | Covered |
| FR-009 | Engine-side metadata records the source of every ingested payload | Covered |
| FR-010 | Regress to exactly today's pipeline, no new failure modes, when the provider ignores the constraint | Covered |
| FR-011 | Captured emission-tool arguments inherit existing retention; no new retention, expiration, or deletion policy | Covered |
| FR-012 | Ingress seam retains the issuance-join checks (frozen scope, packet/generation binding, prior-assessment ordering) regardless of emission-tool availability | Covered |
| FR-020 | Wire contract names the emission tool as the primary emission path, extraction as the deterministic fallback only | Covered |
| FR-021 | No second, parallel schema outside the frozen payload schema bytes | Covered |
| FR-022 | Agent README and model-profile docs describe the emission-tool flow; capability flags remain user-side configuration | Covered |
| FR-030 | Constrained sampling via the engine's existing constrained-sampling capability; no second provider payload serialization | Covered |
| FR-031 | Extension and engine changes compatible with the content-addressed revision handshake | Covered |
| NFR-001 | Per-payload wall-clock on capable providers no worse than +25% versus today's pipeline, measured p95 | Covered (P2 calibration gate — US6 / Phase 6 / SC-002) |
| NFR-002 | Emission tool serves all concurrently spawned payload agents without serializing beyond today's behavior | Covered (`executionMode: "parallel"`, stateless per-child execute — holds by construction) |
| NFR-010 | Fallback path fail-closed for every provider: prose/fence admission, zero-candidate and ambiguity rejection, bounded retry | Covered |
| NFR-011 | Constraint-ignoring providers indistinguishable from today's pipeline — zero new failure-mode classes | Covered (containment invariant, fast-check property over all input combinations) |
| SC-001 | Zero bounded-retry rounds consumed for syntax-level classes across the calibration window | Covered (Phase 6 calibration counters across reviewer, judge-kind, and verdict-slot spawns) |
| SC-002 | Per-payload wall-clock no worse than +25% p95 on capable providers | Covered (Phase 6 calibration gate; p95 violation blocks done per AS-017) |
| SC-003 | Escaped-defect severity not worse than the PR #52-only baseline over the calibration window | Covered (Phase 6 calibration gate) |
| SC-004 | 100% of ingested payloads record their source in engine-side metadata | Covered (provenance sidecar on the reviewer path; additive `source` field on accepted-verdict journal events + operation artifacts on the panel path) |
| SC-005 | Zero Pi payload-agent spawns proceed without the emission tool available (hard fail verified); Claude Code spawns are the documented capability-aware-degradation class | Covered (spawn-admission tests: capability gate, per-harness degradation, hard fail, AS-011 idempotency; AD-7) |
| SC-006 | 100% of per-kind emission-tool parameter schemas byte-match the frozen payload schema bytes | Covered (deterministic JSON.stringify byte-match guard, three kinds — AD-5) |
| SC-007 | Zero new failure-mode classes observed on constraint-ignoring providers over the calibration window | Covered (containment by construction: fallback byte-for-byte identical in every input combination; fallback-preservation tests) |
