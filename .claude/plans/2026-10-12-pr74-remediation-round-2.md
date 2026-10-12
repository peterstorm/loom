# PR #74 remediation, round 2: status recovery for abandoned Wave Gate runs

- **Branch:** `fix/abandoned-run-recovery-status` (PR #74)
- **Scope:** `all`, 12 frozen files at `90bf897d`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr74-review-r2-20261012T081829Z`
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr74-policy-r2-20261012T082108Z`, revision `initial`, with disposition digest `1c715d8cbfe13c5ebdfbbcac26fcd2f6925a41f12ccfb2a08f86c74bd5ed86d3`

## Adjudication

- Emitted and admitted: 0 critical, 1 advisory. Six of seven reviewers returned no findings.
- After refutation: 0 surviving critical, 0 refuted critical, 1 advisory.
- `defectFamily` is `{"kind":"not-required"}`: there are no repair groups, siblings, checks or Historical RED declarations.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| architecture-tech-lead-1 | accepted | Round-trip test at the real seam. Status prints the replay for an unstamped marker whose reason carries `'`, `$(…)`, backticks and a `--`-shaped token. The test splits the printed command with `bash`, runs it through the real `abandon` CLI, and asserts it exits cleanly and tombstones the registration with the exact recorded reason. Any drift between the replay shape and the abandon parser now fails a test, without moving CLI grammar into the core |

## Validation

- `npm run typecheck`; the abandon-stamp suite
- full `npm run verify`

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan.
