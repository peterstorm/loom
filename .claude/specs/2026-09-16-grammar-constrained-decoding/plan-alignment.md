# Plan Alignment Report — revision checkpoint

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md`
**Plan:** `.claude/plans/2026-09-16-grammar-constrained-decoding.md`
**Date:** 2026-09-19
**Status:** BLOCKED on feasibility/launcher prerequisites; parent-authored revision checkpoint, not a fresh independent plan-alignment pass.

## Summary

The 2026-09-16 “No gaps found” report applies only to the previous Spec/Plan and is preserved byte-for-byte in `plan-alignment-2026-09-16-superseded.md`. It must not authorize execution of the revised plan. **Both execution-blocking prerequisites are now resolved and recorded** (see Gaps): the launcher readiness seam (FR-008) is proven mechanism-wise with the launcher change separately owned, and the exact-route qualification (FR-002) is qualified for the live local route as unconstrained emission with the engine authoritative. Revised behavior and measurement obligations have explicit planned coverage, but their implementation and feasibility are not claimed complete.

The TaskGraph was returned to architecture through `helper set-phase --phase architecture --clear-artifact plan-alignment`. Existing T1 work/evidence remains historical; the pending T2–T14 descriptions and trace hashes are stale. No direct TaskGraph edit, guard disablement, fresh completion claim or new implementation dispatch occurred in this revision.

## Gaps

- **FR-002 — RESOLVED for the live local route (qualified 2026-09-19; requalification triggers recorded):** route `desktop-vllm` (vLLM) · `glm-5.3-flash-spark-tp2-v14` · all four frozen schemas. All four accepted (HTTP 200) with the production registration shape; `strict: true` requested on the wire and the wire parameters are STRUCTURALLY EQUAL to the frozen bytes for all four (the strictifier is a no-op — the zod bytes are already strict-compatible, including across v2's root `oneOf`). The route classifies **unconstrained emission**: vLLM ignores the OpenAI tool-level `strict` flag (decisive forced-tool-choice adversarial calls carried `score: 12` and `verdict: "partially_upheld"` through at HTTP 200; v2/v3 direct calls conforming is model compliance, recorded inconclusive). Engine-authoritative mode per FR-003/FR-006/FR-010/FR-018 — the planned design holds on this route; no extraction-only classification. Pi-side gates verified live: canonical fixtures pass `validateToolArguments` against the exact wire parameters for all four; malformed emissions were refused with precise per-branch errors; execute round-trip proven for judge/refutation. Discoveries recorded: pi's in-child validation-retry loop (calibration latency + FR-006 boundary note); vLLM-native enforcement is a pi-ai resolver capability (FR-030 keeps it out of loom's scope). Evidence: `probes/emission-qualification/` (fixtures, driver, README, `recordings/`). NOT yet qualified: any cloud route (openai-codex unspent), any future served-model switch (requalify — the routing policy makes route identity `(provider, served model, digest)` explicit).
- **FR-008 — RESOLVED (mechanism proven 2026-09-19, integration allocated):** the supported launcher seam is `pi --mode rpc` with an extension-command readiness exchange: the launcher spawns the child headless with no prompt, discovers the readiness command via `get_commands`, invokes it (extension commands execute with **no model request**), and receives the bound readiness payload through `entry_appended` (exact tool, schema digest, revision, child identity, active flag from `pi.getActiveTools()`); the gate is a pure comparison plus a fail-closed `set_model` route binding, and only a matching readiness prompts the child. Missing/contradictory readiness and absent/stale extensions all yield **zero model requests**; the in-child awaited `before_agent_start` hold is proven as the defense-in-depth layer (a throw is NOT a stop — `emit()` catches and continues; the hold is the gate). Evidence: `probes/emission-readiness/` (driver + child extension + README), `PROBE PASS` 4/4 variants twice against installed pi 0.83.0 with a counting provider substitute. Ownership: seam primitives `@earendil-works/pi-coding-agent` (proven on installed 0.83.0; true upstream minimum unverified); the launcher itself lives in `~/.dotfiles/pi/extensions/subagent/index.ts` — the launcher edit is a separately owned change, not a hidden global-extension edit. Remaining allocated work: the dotfiles launcher gate, the loom child-extension readiness command, and the full AS-020 negative-control matrix through the production path.

## Coverage

| Requirement / scenario | Planned coverage | Current evidence boundary |
|---|---|---|
| FR-001/FR-008/FR-014; AS-001/AS-010/AS-020 | Issued kind/version and actual child readiness, AD-4/AD-6/AD-8 | Readiness seam proven (`probes/emission-readiness/`); launcher gate + loom readiness command are allocated integration work |
| FR-002/FR-010/FR-030; AS-005/AS-023 | Exact-route qualification and preferred strict mode, AD-2/AD-5 | **Qualified unconstrained** on the live vLLM route (`probes/emission-qualification/`); requalification triggers recorded; cloud route unspent |
| FR-003–FR-007; AS-003/AS-006/AS-007/AS-019 | Explicit selection/attempt table, AD-8/AD-9 | Existing T1 selection needs binding/refusal-diagnostic changes |
| FR-009/FR-011; AS-008/AS-009 | Selection-owned source and existing publication/replay seams | Integration remains planned |
| FR-012; AS-002/AS-018 | Existing schema parser and issued-contract joins retained | Local probe confirms JSON Schema can accept engine-refused whitespace prose |
| FR-013; AS-021 | Pi terminating success and tool-only capture, AD-3 | Installed API/example inspected; production integration not built |
| FR-020–FR-022; AS-012–AS-014 | New-issuance route-aware wording, unchanged frozen schemas, docs | Planned Phase 5; archived contracts preserved |
| FR-031 | Existing revision handshake and normal activation | Helper loop-back succeeded using the loaded main-package CLI |
| FR-032; AS-022 | Feasibility then real vertical acceptance with negative controls | Planned Phases 2/3; not helper-only completion |
| AS-004/AS-015–AS-017; SC-001–SC-003/SC-007 | Preregistered matched route/schema calibration, AD-11 | Not measured |
| SC-004–SC-006/SC-008; NFR-002/NFR-010/NFR-011 | All-path provenance, registered-schema checks, startup/acceptance and degradation tests | Planned runtime verification, not inferred from T1 tests |

## Corrections made in this revision

- Provider-enforced JSON Schema constraints are separated from engine-only refinements, issuance checks and unobservable raw duplicate-key behavior.
- The contradictory separate emission retry budget is replaced explicitly with existing request-slot attempts 1/2. One refused call with usable final extraction can complete without retry; duplicate calls reject even with valid final text.
- Child readiness is a pre-model launcher requirement, not a logged startup error.
- Successful emission uses terminating tool results; forced tool choice is not claimed.
- Acceptance precedes broad implementation, with one real reviewer path before expanding to all kinds.
- The fallback-equivalence property applies only to extraction-selected states; rejection branches get their own assertions.
- Calibration includes startup, follow-up turns, retries and terminal failures, plus independent quality comparison.

## Required next action

Resolve and record the two prerequisites, rerun independent plan alignment against these revised bytes, then use supported decomposition/reconciliation for the remaining Tasks. Preserve original T1 receipts and explicitly allocate any changed T1 contract work. Do not resume the original T2 brief or interpret this checkpoint as a completed alignment or Wave Gate.
