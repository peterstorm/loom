# PR Remediation Round 19

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source: `review-20260828T173821Z-deterministic-task-completion-oracle-post-remediation-23`

## Mandatory fixes
1. Add context-aware JavaScript regex-literal lexical state, including escapes and character classes, so regex contents cannot become test/assertion evidence.
2. Distinguish TSX generic-arrow parameter lists from JSX tags so generic helpers do not suppress later executable tests.
3. Require a matching reserved Task before a failed Pi reviewer result can mutate protected review state; unreserved failures remain diagnostic-only.
4. Correct the Claude reviewer transcript comment to document the real supplied-path-first resolver contract instead of claiming payload independence.

## Advisory dispositions
### Accepted
- Add positive executable Rust `#[test]` coverage.
- Reconcile Wave facade spec-check writes with `wave_gates` (same consistency issue as the refuted direct-handler finding, but independently valid in this write path).
- Replace `AssertionLexicalState` independent fields with a discriminated lexical-mode model only if achievable without destabilizing the focused scanner; otherwise retain as deferred below.

### Deferred
- Lexical-state ADT conversion: broader parser refactor after correctness regressions are green.
- Branded `WaveSpecCheckSlotAuthority.slot_id`: persisted-type migration.
- Config, StateManager, Wave Gate, and Pi witness deepening advisories: standalone architecture work.
- StateManager pointer helper and orchestration-test env helper: low-risk cleanup outside this correctness remediation.

### Dismissed
- Inline `firstFailureErrors`: the helper expresses first-failure ordering and remains clearer than duplicating union narrowing.

## Refuted finding
- Direct `store-spec-check-findings` corruption claim: atomic parse-before-write prevents invalid persistence; prior graph remains intact.

## Validation
Typecheck/unused, focused evidence and Pi result tests, full bounded Vitest, smoke, changed-production lint, diff check, registered remediation/index installation, commit/push, fresh canonical review/refutation.
