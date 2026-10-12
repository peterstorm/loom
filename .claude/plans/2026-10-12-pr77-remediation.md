# PR #77 remediation: name the remediate command in escalation status

- **Branch:** `fix/escalation-remediate-hint` (PR #77)
- **Scope:** `all`, 5 frozen files at `03e02e20`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr77-review-20261012T142213Z`. All seven reviewers were admitted on their first attempt.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr77-policy-20261012T143000Z`, revision `initial`, with disposition digest `d8efce80970515fd687764e4b8df37d8644b92f95dec25b0a61d3185b5f43d9c`

## Adjudication

- Emitted and admitted: 0 critical, 1 advisory. Six of seven reviewers returned no findings.
- After refutation: 0 surviving critical, 0 refuted critical, 1 advisory.
- `defectFamily` is `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| code-simplifier-1 | accepted | The `--reason` placeholder is now a module constant, `REMEDIATE_REASON_PLACEHOLDER`, holding its already-quoted literal. Behaviour is unchanged, and the existing tests pin the literal. |

## Validation

- `npm run typecheck`; the implementation-window and complete-wave-gate suites
- full `npm run verify`
- CI green on both runners

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan.
