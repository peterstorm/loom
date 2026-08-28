# PR Remediation Round 29

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T223300Z-deterministic-task-completion-oracle-post-remediation-33`
- Source result digest: `deaa14d77536f70b6f87cec675c9ec69768fc671561c22c9a8ede866849f1bf1`
- Exact frozen scope: the source result's 77-path `.scope` array.

## Mandatory fixes
1. `reviewAuthorityForTask` returns a legacy Pi capability only for a never-generated Task with no active, accepted, or issued review authority; retained modern authority without a run returns no spawn capability.
2. Claude readable-transcript resolution derives retained generation authority from `review_generation`, `accepted_review_authority`, or issued packet registrations before selecting legacy parsing.

## Advisory dispositions
Unrelated scanner/module/type/test-deepening advisories remain deferred to dedicated slices.

## Refuted-finding audit
- No critical finding was refuted; both are mandatory.

## Validation
Focused retained-authority spawn/parser regressions, typecheck/unused, full bounded Vitest, smoke, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
