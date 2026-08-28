# PR Remediation Round 14

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T134606Z-deterministic-task-completion-oracle-post-remediation-18`
- Result digest: `bb1ab4b027c9d80f8000ec5ff135442c953d696ca460b3c1ea5b214c3bc5c40e`

## Mandatory critical remediation
1. Bind Claude spec-check settlement to capture-correlated Agent Request Authority in dispatch and recheck exact run/Wave/slot/attempt inside the locked State File update. Direct modern invocation without authority and stale attempt-1 evidence after attempt 2 both fail closed unchanged.
2. Add direct-handler regressions proving recognized implementation stops return contextual errors for absent and malformed TaskGraph session authority.

## Advisory dispositions
### Accepted
- Catch direct `readEvidence` failures and label evidence `snapshot-read-failed`.
- Correct the misleading parser-only spec-check test comment.
### Deferred
- Couple `ReviewRun.slot_authority` and `expected_agents` in one ADT: broad persisted-schema/type migration.
- Convert `MissingReservedResults` to a run-bound/non-run-bound ADT: useful type deepening, separate slice.
- Split Wave Gate, TaskGraph parser/persistence, and config policy/runtime: broad architecture slices.
- Deduplicate Pi review-resolution update loops: behavior-preserving cleanup outside the authority critical.

## Validation
Focused authority tests, typecheck/unused, full bounded Vitest, smoke 23/23, changed-production lint, and `git diff --check`; then registered exact-index remediation, commit/push, and fresh canonical review/refutation.
