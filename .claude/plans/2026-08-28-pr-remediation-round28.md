# PR Remediation Round 28

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T221007Z-deterministic-task-completion-oracle-post-remediation-32`
- Source result digest: `ab4035097fe8a4a9d45b623b20e35f1d6fcb39143e80dc7cb359a773556b47f8`
- Exact frozen scope: the source result's 76-path `.scope` array.

## Mandatory fixes
1. Exclude retained `accepted_review_authority` and issued packet registrations from authority-free legacy Pi reviewer mutation, even if `review_generation` is absent.
2. Correct failed-result documentation to state that unreserved legacy implementation failures may release proven legacy execution reservations while never storing positive evidence.
3. Correct reserved-result classifier documentation: the current classifier deliberately groups every existing non-standalone arm and a future lifecycle arm requires explicit classifier review; the type prevents typos but does not provide exhaustiveness here.

## Advisory dispositions
All unrelated architecture/type/simplification advisories remain deferred to dedicated slices; this round is the exact surviving critical set.

## Refuted-finding audit
- The Wave Gate capture-rejection no-op finding was refuted by intent and security: stale attempt-1 mutation is intentionally ignored and durable rejection still drives retry derivation.

## Validation
Focused retained-authority tests, typecheck/unused, full bounded Vitest, smoke, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
