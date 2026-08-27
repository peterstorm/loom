# Slice 3 Completion Oracle — PR Remediation Round 7

## Authority
- Reviewed HEAD: `424cf690bf2c2df5aaa93624cc318ad0f6b9f4f3`
- Review: `review-20260825T061044Z-deterministic-task-completion-oracle-verified`
- Result digest: `4fcda79057342463ec67f7a33b5ccbb28684047cea06caa7d5d265e5c42e0d04`
- Criticals: pointer rollback lease race; malformed multi_edit omission; global review witness ambiguity. All upheld.

## Critical remediation
1. Session TaskGraph pointer binding uses generation/lease state under the same no-follow lock. Same-target bind acquires a lease; rollback/release removes only its lease; previous target restores only after final lease of that generation. Different target while live leases exist fails closed. Exact cleanup and stale-state tests.
2. `piWriteTargetPaths` returns typed Result. Every multi_edit entry must parse one canonical target field or the whole batch blocks. Mixed valid/malformed and valid/out-of-scope regressions.
3. Encapsulate trusted review witnesses per session/run/root with explicit recency. Verification targets only the most recently touched run for the root; rejected current never falls back to old accepted. Accepted current is idempotent, retires older root witnesses, and session shutdown prunes. Two sequential reviews verify independently without ambiguity.

## Accepted advisories
- Add typed `redacted_thinking` block requiring non-empty opaque data.
- `StateManager.load()` and store ports retain `ParsedTaskGraph`; do not widen brands after parsing.
- TaskCompletionSuiteAuthority exact single-check tuple.
- Inline two one-use task-execution pass-through helpers.

## Validation
Focused pointer leases, multi_edit, sequential review witnesses, redacted thinking, parsed graph/suite types; full/smoke/type/lint/diff; remediation; clean rereview; PR.

## Completion record — 2026-08-25
Status: **implemented and locally validated**. No files were staged or committed. Slice 4 was not implemented.

### Critical remediation completed
- [x] Added an exact, immutable, generation/lease registry beside each session TaskGraph pointer. Registry and pointer are parsed and changed under the same no-follow lock; malformed or contradictory crash state fails closed; different targets are refused while leases live; only the final exact lease restores the previous target.
- [x] Changed `piWriteTargetPaths` to a typed all-or-nothing result. Every `multi_edit` entry must parse before scope checks run; malformed siblings block the batch and valid out-of-scope siblings remain visible to the scope gate.
- [x] Replaced process-global witness ambiguity with session/root/run aggregates carrying explicit touch recency. Verification targets only the current run, never falls back after current rejection, idempotently retires older root witnesses after acceptance, and prunes the session aggregate on shutdown.

### Accepted advisories completed
- [x] Added `redacted_thinking` with required non-empty opaque `data`.
- [x] Preserved `ParsedTaskGraph` through `StateManager.load()` and `TaskGraphStore` load/update boundaries; in-memory stores reparse persisted transformations.
- [x] Narrowed `TaskCompletionSuiteAuthority.checks` to the exact single-check tuple.
- [x] Inlined the two one-use task-execution pass-through helpers.

### Artifacts changed
- Domain/runtime: `CONTEXT.md`, `engine/src/core/claude-transcript-integrity.ts`, `engine/src/core/implementation-completion.ts`, `engine/src/handlers/subagent-start/mark-subagent-active.ts`, `engine/src/handlers/subagent-stop/store-reviewer-findings.ts`, `engine/src/handlers/subagent-stop/update-task-status.ts`, `engine/src/handlers/task-execution.ts`, `engine/src/machine/evidence.ts`, `engine/src/machine/index.ts`, `engine/src/machine/task-graph-pointer.ts`, `engine/src/state-manager.ts`, `pi/extension.ts`, `pi/subagent-result.ts`.
- Tests: `engine/tests/core/implementation-completion.property.test.ts`, `engine/tests/handlers/complete-wave-gate.test.ts`, `engine/tests/handlers/helpers/wave-spec-check-scope.test.ts`, `engine/tests/handlers/session-start/cleanup-stale-subagents.test.ts`, `engine/tests/machine/task-graph-pointer.test.ts`, `engine/tests/pi-extension-review-events.test.ts`, `engine/tests/pi-write-target-paths.test.ts`, `engine/tests/pi/attempt-authority-correlation.test.ts`, `engine/tests/pi/subagent-result.test.ts`.
- Plan: `.claude/plans/2026-08-25-pr-remediation-round7.md`.

### Validation results
- [x] Focused: 9 files, 366 tests passed.
- [x] Full unit: 224 files passed; 5,552 tests passed; 1 skipped.
- [x] Smoke: panel 22/22, review panel 19/19, standalone review PASS, orchestration façades PASS, Pi resources PASS, TaskGraph validation 23/23.
- [x] Typecheck plus unused checks: PASS.
- [x] Full-tier lint on all 11 changed production files: PASS. The separate whole-repository inventory was also run and reported 32 pre-existing violations in 22 untouched files; none is in this remediation's touched-file lint scope.
- [x] `git diff --check`: PASS; reviewed-HEAD diff inspected; no Slice 4 implementation added.
