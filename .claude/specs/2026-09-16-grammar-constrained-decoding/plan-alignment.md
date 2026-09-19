# Plan Alignment Report

**Spec:** /home/peterstorm/dev/claude-plugins/loom-grammar-constrained-decoding/.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md
**Plan:** /home/peterstorm/dev/claude-plugins/loom-grammar-constrained-decoding/.claude/plans/2026-09-16-grammar-constrained-decoding.md
**Date:** 2026-09-19

## Summary

No gaps found.

## Gaps

None.

## Executable-Models Policy Check

- **Lifecycles:** The plan describes no domain lifecycle in prose. It explicitly states it "introduces no independent lifecycle machine" and declines a second persisted retry lifecycle for readiness (Data Flow section). No `## Lifecycles` binding required.
- **Pipeline:** The plan explicitly declines the fugue bridge: "The feature is not a Fugue pipeline; no AuthoredDag bridge is selected" (Data Flow section). Satisfies the policy.
- **Invariant tiering:** INV-1 ("No tool constraint may demand strict sampling via strict-required mode") is tiered `checkable` with rule file `.claude/linter/rules/inv-1-no-strict-require-constraint.json`. Its stated property is a code-spelling property a regex lint rule can actually check (`strict: "prefer"` present, strict-required absent in constraint construction). Correctly tiered — the plan itself routes behavioral properties (schema identity, selection outcomes, readiness, provenance) to tests rather than mislabeling them as regex invariants.

No MODEL-N gaps.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| US1 | Grammar-constrained payload emission on capable providers (per-kind emission tool + ingestion preference) | Covered |
| US2 | Deterministic fail-closed fallback preserved (PR #52 extraction unchanged) | Covered |
| US3 | Observable provenance of payload source (emission vs extraction) | Covered |
| US4 | Hard fail when the emission tool is missing (Pi payload-producer spawns) | Covered |
| US5 | Wire contract and docs updated to tool-primary | Covered |
| US6 | Calibration gate for quality and latency | Covered |
| AS-001 | Exact issued tool registered/active at child start; parameter schema byte-matches frozen schema | Covered (AD-4 readiness binding, AD-5 frozen bytes, byte-identity test suite) |
| AS-002 | Engine parser + issuance joins decide acceptance; provider JSON Schema conformity alone is not acceptance | Covered (AD-8: selection then authoritative admission; FR-012 joins retained) |
| AS-003 | Emission arguments win deterministically over final-message extraction | Covered (AD-8/AD-9: "Emission, regardless of final text") |
| AS-004 | Zero retries attributed to verified provider-enforced schema violations; other causes reported separately | Covered (AD-11 retry causes, separate series; Phase 6) |
| AS-005 | No failure merely from unsupported strict mode; zero emission calls use old extraction unchanged | Covered (AD-2 preferred/unconstrained/extraction-only classes; AD-9 zero-call row) |
| AS-006 | Prose/fence payload engages fail-closed extraction exactly as today | Covered (AD-9 zero-emission row + containment law) |
| AS-007 | One refused emission call never ingested; usable fallback consumes no retry; at most attempt 2 | Covered (AD-9 rows 3–4; existing slot budget, no separate emission counter) |
| AS-008 | Every ingested payload records its source in engine-side metadata | Covered (provenance component; source returned by selection, bound at acceptance) |
| AS-009 | Fallback engagement observable via recorded extraction source | Covered (single-call refusal retained; historical absence handled honestly) |
| AS-010 | Missing/inactive/misbound tool → no model request, bounded actionable startup failure | Covered (AD-4 launcher barrier; notification/revision-hash insufficiency explicitly addressed) |
| AS-011 | Spawn retried after tool becomes available behaves identically (idempotent, no residual state) | Covered (idempotent registration for same request/kind/version/digest; only matching reservations released) |
| AS-012 | Tool-primary wire instructions; no same-spawn re-emission; extraction fallback; archived contracts untouched | Covered (AD-7 new-issuance wording + one-call rule; archived v1/v2/v3 bytes unchanged) |
| AS-013 | Emission tool parameter schema byte-identical to frozen payload schema | Covered (AD-5 byte round-trip guard; emission-tool-contract test suite) |
| AS-014 | Agent README + model-profile docs describe emission flow; capability flags stay user-side | Covered (Phase 5 files; AD-2 operator-configuration ruling) |
| AS-015 | p95 wall-clock ≤ +25% vs extraction-only baseline incl. startup/follow-ups/retries; terminal failures separate | Covered (AD-11 matched-runtime measurement; terminal-failure rate not increased) |
| AS-016 | Escaped-defect severity not worse than PR #52-only baseline | Covered (AD-11 independent rubric, blinded assessment, held-out known-defect cases) |
| AS-017 | Preregistered workload/matrix/rates/latency/quality retained; violated guardrail blocks done | Covered (AD-11 ≥100 paired requests per cell, retention, guardrail-blocks-done; Phase 6) |
| AS-018 | Schema-conforming but engine-refined-violating arguments refused; whitespace-only prose regression case | Covered (AD-5 live probe of whitespace-only case; Phase 2; testing-strategy table) |
| AS-019 | Two distinct emission calls → ambiguity rejection even with valid final; exact replay is not a second call | Covered (AD-9 ambiguity + replay rows) |
| AS-020 | Missing/stale/contradictory/wrong-request readiness → zero model requests; only matching reservations cleaned | Covered (AD-4 + Phase 2 counting-provider negative controls; probes/emission-readiness PROBE PASS 4/4) |
| AS-021 | Tool-only terminal result ingests without extra final message; mixed batches retain Pi semantics | Covered (AD-3 terminating success; mixed batch/cancellation tested, not labeled) |
| AS-022 | Vertical-slice controls: bypass/always-accept/always-reject detected; helper-only tests insufficient | Covered (AD-10 production-path negative controls; testing crosses the same policy seam as production) |
| AS-023 | Exact v2/v3 reviewer + v1 judge/refutation schemas qualified per route; unsupported routes extraction-only, no rewriting | Covered (AD-5 local-route qualification, all four schemas; AD-2 no silent rewrite; no cloud route claimed) |
| FR-001 | Exact issued kind/version tool from frozen schema bytes; catalog+authenticated context decide identity; extraction-only routes advertise nothing | Covered (AD-5 frozen bytes; AD-6 catalog eligibility; AD-7 issuance authority, prompt markers rejected) |
| FR-002 | Preferred (not required) strict sampling via harness resolver; only qualified routes called capable | Covered (AD-2 `strict: "prefer"` through Pi's resolver; per-route qualification) |
| FR-003 | Ingestion seam additively prefers valid emission arguments; deterministic | Covered (AD-8/AD-9 one pure selection policy) |
| FR-004 | PR #52 fail-closed extraction retained verbatim as fallback | Covered (AD-9 unchanged extraction; containment law vs existing parser) |
| FR-005 | Fallback stays fail-closed for every provider (prose/fence admission, zero-candidate/ambiguity rejection, bounded retry) | Covered (extraction unchanged; bounded retry = existing request slots) |
| FR-006 | One refused call: refusal retained, unchanged extraction, no retry on usable fallback, single rejection otherwise, attempt-1→attempt-2 only, no separate emission counter | Covered (AD-9 matrix + budget paragraph; explicitly supersedes old wording) |
| FR-007 | Two+ distinct calls reject as ambiguity; replay idempotent; contradictory records sharing identity refuse | Covered (AD-8 closed observation vocabulary with call identity; AD-9 replay/ambiguity rows) |
| FR-008 | No model request before registered+active tool matches issued request/kind/version/digest; bounded observation; parent hash alone insufficient | Covered (AD-4 launcher barrier; infrastructure failure does not consume semantic retry authority) |
| FR-009 | Record payload source in engine-side metadata | Covered (provenance component; source recorded with selection, durably bound) |
| FR-010 | Unsupported strict sampling must not fail request; zero-emission preserves extraction; emission calls follow new rules | Covered (AD-2 route classes; AD-9 zero-call row) |
| FR-011 | Captured arguments inherit existing retention; no new retention policy | Covered (existing publication/retention; "no new retention policy or full payload copy") |
| FR-012 | Ingress retains issuance-join checks regardless of emission availability | Covered (AD-8 authoritative admission after selection; failed-issuance emission must not fall back) |
| FR-013 | Successful emission returns minimal terminating acknowledgment; failed validation is explicit refusal | Covered (AD-3 `terminate: true` + minimal ack; execute throws at shell boundary for refusals) |
| FR-014 | Observations bound to request attempt + tool-call identity; complete vs incomplete preserved; unexpected kinds/versions never self-select or become absence | Covered (AD-8 binding, incomplete-not-absence rule, wrong-kind/version rejection before schema selection) |
| FR-020 | New emission-enabled instructions tool-primary; extraction-only and archived contracts keep final-message contract | Covered (AD-7; Phase 5 rendering from actual route/binding) |
| FR-021 | No second parallel schema outside frozen bytes | Covered (AD-5 rejected mirror/builder; AS-013 byte identity at registered surface) |
| FR-022 | Agent README + model-profile docs updated; capability flags remain user-side config | Covered (Phase 5 doc files; AD-2 operator-configuration statement) |
| FR-030 | Constrained sampling via engine's existing capability; no second provider serialization | Covered (AD-2 Pi's existing resolver; AD-1 rejected second serializer; vLLM enforcement stays in pi-ai resolver) |
| FR-031 | Compatibility with existing content-addressed revision handshake | Covered (Phase 6 final-runtime handshake match; Verification step 6 no handshake bypass) |
| FR-032 | Route qualification + real vertical slice with discriminating controls before breadth; missing access = blocker not pass | Covered (AD-2/AD-5 qualification; AD-10/Phase 3 slice; Phase 2 "remain blocked here") |
| NFR-001 | p95 dispatch-to-ingestion ≤ +25% vs matched baseline; terminal-failure rate not increased | Covered (AD-11; Phase 6) |
| NFR-002 | Emission tool serves concurrent wave without new serialization | Covered (per-child concurrency preserved; Phase 5 concurrency checks) |
| NFR-010 | Fallback path fail-closed for every provider | Covered (unchanged PR #52 extraction; AD-9) |
| NFR-011 | Extraction-only/zero-emission preserve prior contract; strict lack not a failure; new outcomes explicit | Covered (AD-2/AD-9; anti-baseline-equivalence containment law) |
| SC-001 | Zero schema-constraint retries on qualified routes; other causes accounted separately | Covered (AD-11 retry causes/separate series; Phase 6 measured) |
| SC-002 | p95 latency ≤ +25% without increased terminal failures | Covered (AD-11; Phase 6) |
| SC-003 | Escaped-defect severity not worse over calibration window | Covered (AD-11 rubric/blinding/held-out cases) |
| SC-004 | 100% of ingested payloads record source | Covered (source returned by every selection outcome; durable binding at acceptance) |
| SC-005 | Zero children send model requests without exact readiness; extraction-only routes retain behavior | Covered (AD-4 zero-request controls; Phase 4 Claude Code/historical protocol verification) |
| SC-006 | 100% of per-kind parameter schemas byte-match frozen bytes | Covered (Phase 5 registered-surface byte checks; contract test suite) |
| SC-007 | No strict-capability failures or changed extraction on degraded routes; emission failures reported not hidden | Covered (AD-9 explicit no-no-op-equivalence claim for non-containment rows; Phase 4 verification; AD-11 separate series) |
| SC-008 | Vertical slice passes success/refusal acceptance and fails bypass/always-accept/always-reject controls | Covered (AD-10; Phase 3 production-path controls before breadth) |

Out-of-scope items (OOS-001–OOS-004) were excluded from gap analysis per spec; the plan's "no G5 work, no general mutation platform" statements are consistent with them.
