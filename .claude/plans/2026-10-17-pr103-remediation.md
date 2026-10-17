# PR #103 remediation — failure-message constructor review

- **Branch:** `fix/failure-message-constructor`
- **Scope:** the PR's 5 changed files (frozen diff, `kind: all`)
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261017T142958Z-a407d371`
- **Counts (inspection renderer):** emitted/admitted 0 critical, 3 advisory; after refutation 0 surviving
  critical, 0 refuted critical, 3 advisory.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261017-pr103`, revision
  `initial`, disposition digest `eb34e38898be9f2c1ba9acb40d25826834e1dff9f714240a66a027924316c906` (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| pr-test-analyzer-1 | accepted | Pin the report-unreadable parser arm (blank and over-length refused, valid admitted). `messageOf` is a one-line delegation covered by `boundedFailureMessage`'s property test. |
| type-design-analyzer-1 | accepted | Rename `NonEmptyString` to `FailureMessage` (11 uses, 3 files) so the brand names what its constructors enforce. |
| code-simplifier-1 | accepted | `includes("LINT ENGINE ERROR")` subsumes the `startsWith` arm; drop it. |

## Validation

- `npx tsc --noEmit -p engine`; no new unused imports
- completion-suite, wave-completion-suite, orchestration and the two new suites
- `npm run verify` (root)
