# Plan Alignment Report

**Spec:** .claude/specs/2026-09-16-grammar-constrained-decoding/spec.md
**Plan:** .claude/plans/2026-09-16-grammar-constrained-decoding.md
**Date:** 2026-09-16

## Summary

5 gaps found, from two underlying divergences: (1) the spec includes judge (and refutation-verifier) payload production in the feature's scope, which the plan's single reviewer-payload registry does not cover; (2) the plan is internally contradictory on Claude Code payload-producer spawns — AD-4 declares them the US2 degradation class proceeding as today, while the spawn-admission guard design blocks every `not-provided` payload-producer spawn, a scoping the plan itself marks "(stakeholder-confirm)" and leaves unresolved. Spec Open Question 1 (per-request toolChoice) is resolved by the plan (AD-3: not reachable from the extension seam; recorded as a pi-side future direction). No executable-models policy violations: the plan needs no `## Lifecycles`/`## Pipeline` binding, and INV-1's checkable tier is regex-checkable with its rule file present (`.claude/linter/rules/inv-1-no-strict-require-constraint.json`, verified).

## Gaps

- **FR-001** — Per-kind emission tool in every payload-agent child session, scoped by cataloged producer kind: the spec includes judge and verifier payload production (summary opens "Reviewer/judge/verifier payload generation is routed through provider-side structured outputs"; US1's actor is "(reviewer, judge, or verifier kind)"; the glossary defines payload producers as "(reviewer, judge, verifier)"). The plan's `EMISSION_TOOL_SPECS` registry covers only the `"reviewer-payload"` kind — verified against the engine catalog, `isStandaloneReviewAgent` spans the "reviewer" and "review-verifier" kinds (wave-review roster + standalone reviews), both receiving frozen-schema reviewer packets. The judge kind (`arch-judge-agent`, profile "panel-judge") emits a structured `JudgeVerdict` through the separate `capturedPanelRaw`/panel-contract ingestion path, and the review-verifier kind's refutation verdict (`RefutationVerdict`, `/review-pr` panel) likewise flows outside the seam the plan modifies — neither has an emission tool, frozen schema bytes, or an ingestion fold designed. As designed, arch-judge spawns (kind "arch-panel") are not payload producers, so they proceed with no emission tool and no hard fail — the silent under-capability class US4/SC-005 exists to eliminate. If the judge inclusion is deliberate (the summary sentence reads as deliberate, and OOS-003 shows the authors explicitly excluded other structured-payload paths but not this one), the plan under-covers FR-001; if the glossary is loose, the plan's scoping needs explicit stakeholder confirmation either way.

- **US1** — Grammar-constrained payload emission on capable providers: same scope divergence at the scenario level. US1's actor explicitly includes judge and verifier kinds spawned by the engine; the plan provides the per-kind emission tool only for the reviewer-payload kind, so judge-kind child sessions receive no emission tool and their syntax-level retry rounds (AS-004's zero-retry audit) are unaddressed by the design.

- **FR-008** — Refuse to spawn payload-agent sessions in which the emission tool cannot be provided: the plan is internally contradictory on Claude Code payload-producer spawns, and the engine supports both harnesses (`HarnessCorrelatorBinding` is `"pi" | "claude"`; the capture handler has a Claude JSONL payload reader). AD-4 declares Claude Code `not-provided` and the US2 capability-aware-degradation class — "behave exactly as today; hard-failing them would regress providers that currently work via extraction" — while the spawn-admission guard as designed blocks every payload-producer spawn whose capability is `not-provided`, which hard-fails exactly those Claude Code reviewer spawns, with a pi-only `/reload` remediation that does not apply to Claude Code. FR-008's letter supports the blocking reading; the spec summary and US2 ("no provider or model regresses") support the proceeding reading. The plan itself marks the scoping "(stakeholder-confirm)" — the question is unresolved. An implementer cannot determine which behavior to implement for Claude Code payload-producer spawns.

- **US4** — Hard fail when the emission tool is missing: same contradiction at the scenario level. AS-010 requires a spawn whose child session lacks the emission tool to "fail immediately with a clear, actionable error naming the missing capability", while AD-4 specifies Claude Code child sessions "behave exactly as today" (proceed unconstrained via extraction). The hard-fail guarantee is undetermined for Claude Code child sessions.

- **SC-005** — Zero payload-agent spawns proceed without the emission tool available (hard fail verified): not satisfiable by the plan as designed. Judge-kind spawns proceed without the tool (the FR-001 divergence), and Claude Code reviewer spawns either proceed without the tool (per AD-4's US2-degradation declaration, violating the criterion) or are hard-failed (per the guard design, contradicting the plan's own no-regression argument and the spec summary's guarantee).

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| US1 | Grammar-constrained payload emission on capable providers (per-kind emission tool + additive ingestion preference) | Gap |
| US2 | Deterministic fail-closed fallback preserved (PR #52 verbatim, no new failure modes) | Covered |
| US3 | Observable provenance of payload source | Covered (scope caveat: payloads ingested via the unmodified panel/refutation paths record no source — see FR-001) |
| US4 | Hard fail when the emission tool is missing | Gap |
| US5 | Wire contract and docs updated to tool-primary | Covered |
| US6 | Calibration gate for quality and latency | Covered |
| FR-001 | Per-kind emission tool, frozen payload schema bytes, profile-driven scoping | Gap |
| FR-002 | Emission tool carries a JSON-schema strict-sampling constraint | Covered (disclosed deviation honored in substance: `strict: "prefer"` request instead of literal "require" — verified to throw on constraint-ignoring providers, violating FR-010/NFR-11; capable providers still grammar-constrain by construction) |
| FR-003 | Ingestion seam additively prefers valid emission-tool arguments over final-message extraction | Covered |
| FR-004 | PR #52's fail-closed extraction retained verbatim as the deterministic fallback | Covered |
| FR-005 | Fallback path stays fail-closed for every provider | Covered |
| FR-006 | Invalid emission arguments never-ingestable, separate bounded-retry budget of the same magnitude | Covered |
| FR-007 | Duplicate emission-tool calls treated as ambiguity, rejected fail-closed | Covered |
| FR-008 | Refuse to spawn when the emission tool cannot be provided | Gap |
| FR-009 | Record payload source in engine-side metadata | Covered |
| FR-010 | Regress to exactly today's pipeline when the provider ignores the constraint | Covered |
| FR-011 | Captured emission arguments inherit existing transcript/engine retention | Covered |
| FR-012 | Ingress seam retains issuance-join checks regardless of emission-tool availability | Covered |
| FR-020 | Wire contract names the emission tool as the primary emission path | Covered |
| FR-021 | No second parallel schema outside the frozen payload schema bytes | Covered |
| FR-022 | Agent README + model-profile docs updated; capability flags user-side | Covered |
| FR-030 | Constrained sampling via the existing capability; no second provider payload serialization | Covered |
| FR-031 | Compatible with the content-addressed revision handshake | Covered |
| NFR-001 | Per-payload wall-clock no worse than +25% p95 | Covered (P2 calibration gate, Phase 5) |
| NFR-002 | Emission tool serves concurrently spawned payload agents without serializing | Covered (`executionMode: "parallel"`, stateless per-child execute) |
| NFR-010 | Fallback path fail-closed for every provider | Covered |
| NFR-011 | Constraint-ignoring providers indistinguishable from today's pipeline | Covered |
| SC-001 | Zero bounded-retry rounds for syntax-level classes on capable providers | Covered (calibration counters, Phase 5; scope caveat: judge-path spawns — see FR-001) |
| SC-002 | Per-payload wall-clock no worse than +25% p95 | Covered |
| SC-003 | Escaped-defect severity not worse than the PR #52-only baseline | Covered |
| SC-004 | 100% of ingested payloads record their source | Covered (scope caveat: panel/refutation-path payloads — see FR-001) |
| SC-005 | Zero payload-agent spawns proceed without the emission tool | Gap |
| SC-006 | 100% of per-kind emission-tool parameter schemas byte-match the frozen bytes | Covered |
| SC-007 | Zero new failure-mode classes on constraint-ignoring providers | Covered |
