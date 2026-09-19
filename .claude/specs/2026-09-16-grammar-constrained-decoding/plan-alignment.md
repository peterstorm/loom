# Plan Alignment Report — revision checkpoint

**Spec:** `.claude/specs/2026-09-16-grammar-constrained-decoding/spec.md`
**Plan:** `.claude/plans/2026-09-16-grammar-constrained-decoding.md`
**Date:** 2026-09-19
**Status:** BLOCKED on feasibility/launcher prerequisites; parent-authored revision checkpoint, not a fresh independent plan-alignment pass.

## Summary

The 2026-09-16 “No gaps found” report applies only to the previous Spec/Plan and is preserved byte-for-byte in `plan-alignment-2026-09-16-superseded.md`. It must not authorize execution of the revised plan. Two execution-blocking prerequisites remain. Revised behavior and measurement obligations have explicit planned coverage, but their implementation and feasibility are not claimed complete.

The TaskGraph was returned to architecture through `helper set-phase --phase architecture --clear-artifact plan-alignment`. Existing T1 work/evidence remains historical; the pending T2–T14 descriptions and trace hashes are stale. No direct TaskGraph edit, guard disablement, fresh completion claim or new implementation dispatch occurred in this revision.

## Gaps

- **FR-008** — Actual pre-model child readiness: the installed normal subagent launcher starts print-mode Pi with its prompt already supplied. No supported pre-prompt readiness exchange has been demonstrated. Resolve the launcher hook, owning package and minimum version, then prove zero model requests under missing/inactive/misbound-tool and failed-startup controls. A parent revision check, `before_agent_start` throw or startup notification does not satisfy this requirement. Plan AD-4 and Phase 2 keep this as a blocking prerequisite; an external launcher change requires separate owned delivery rather than hidden edits to global extensions.
- **FR-002** — Exact-route schema qualification: no live provider acceptance/enforcement evidence for the exact v2/v3 reviewer and v1 judge/refutation schemas was produced by this revision. Reviewer v2 contains a root `oneOf` and Pi forwards it unchanged. Qualify the intended route/schema matrix and explicitly classify constrained, unconstrained and extraction-only routes before breadth expansion. Do not fix provider rejection by silently rewriting frozen bytes. Plan AD-2/AD-5 and Phase 2 name the work; configuration flags or byte-round-trip tests alone are not evidence.

## Coverage

| Requirement / scenario | Planned coverage | Current evidence boundary |
|---|---|---|
| FR-001/FR-008/FR-014; AS-001/AS-010/AS-020 | Issued kind/version and actual child readiness, AD-4/AD-6/AD-8 | Launcher prerequisite unresolved |
| FR-002/FR-010/FR-030; AS-005/AS-023 | Exact-route qualification and preferred strict mode, AD-2/AD-5 | Resolver behavior inspected; live qualification not run |
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
