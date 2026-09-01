# PR Remediation Round 24

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T200608Z-deterministic-task-completion-oracle-post-remediation-28`
- Source result digest: `0c770e37401e9c72a2fce368f41a92549bb379d0bbff79a43d07801af5e6eb0e`
- Exact frozen scope: the source result's 72-path `.scope` array.

## Mandatory fix
1. Capture failed-review authority at Pi reservation time as Task id + review generation + packet + reviewer slot + attempt, and require exact equality inside the locked failure update before mutating current review evidence.

## Advisory dispositions
### Accepted
- Recognize executable Vitest/Jest `it.each`, `test.each`, and `.concurrent` test declarations with regressions.
- Correct the Pi StateManager-callback comment so it does not claim the existing closed-over diagnostic arrays are side-effect free.

### Deferred
- Wave retry/restart integration coverage, HookResult non-empty diagnostic type, Task review-state ADT, hidden raw descriptor redesign, pure Pi settlement extraction, TaskGraph codec/config-runtime splits, and Start/Stop parser deduplication: independent architecture/test slices.

## Refuted-finding audit
- The sole critical was unanimously upheld and is mandatory.

## Validation
Focused stale failed-review and parameterized-test regressions, Pi integration coverage for reservation capture, typecheck/unused, full bounded Vitest, smoke with inherited Pi variables unset, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
