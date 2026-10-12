# PR #76 remediation: retire an abandoned run fully on trace upgrade (#57 D6)

- **Branch:** `fix/57-d6-retire-scope` (PR #76)
- **Scope:** `all`, 6 frozen files at `0c15d5f5`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr76-review-20261012T124319Z`. All seven reviewers were admitted on their first attempt.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr76-policy-20261012T125500Z`, revision `initial`, with disposition digest `5153fa59410901497bef4a7cf3823ce1039717a23907f4cbcbae23148b861c71`

## Adjudication

- Emitted and admitted: 0 critical, 4 advisory. The code-reviewer, silent-failure-hunter and type-design-analyzer returned no findings.
- After refutation: 0 surviving critical, 0 refuted critical, 4 advisory.
- `defectFamily` is `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | The test that another Wave's spec-check and block survive is now a table over both paths: over a tombstone, and over residue with no gate registered. The upgrade case where a tombstone is already present was already pinned by the existing terminal-abandoned retirement test. |
| comment-analyzer-1 | accepted | `docs/operations.md` now says retirement works "as a successor install would, except that another Wave's `spec_check` and its block are left alone". |
| architecture-tech-lead-1 | dismissed | Putting Wave scoping inside `resetWaveGateReviewAuthority` and `supersedeAbandonedWaveGateReview` would change what restart, orphan recovery and successor install clear. That is a behaviour change outside this fix, with no defect behind it. |
| code-simplifier-1 | accepted | One `withOtherWaveSpecCheckHeld` helper holds the spec-check aside, retires, and restores it. It replaces three coupled locals. |

## Validation

- `npm run typecheck`; the registration, upgrade and amendment suites
- full `npm run verify`
- CI green on both runners

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan.
