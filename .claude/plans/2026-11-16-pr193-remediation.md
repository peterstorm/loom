# PR #193 remediation: reopening an attested Task ends attestation mode

- **Branch:** `fix/reopen-clears-attestation`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr193-review-1`
- **Scope:** `engine/src/core/task-revalidation.ts`, `engine/tests/core/task-revalidation-attestation.test.ts`, `docs/reference/recovery.md`
- **Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead (deepen), code-simplifier (distill)
- **Disposition publication:** `run.pr193-disposition-1`

## Criticals

None surfaced, so `defectFamily: {"kind":"not-required"}`.

## Advisory dispositions (9: 8 accepted, 1 deferred)

| # | Reviewer | Finding | Disposition |
|---|---|---|---|
| 1 | pr-test-analyzer | The declared-artifact expectation is untested | Accepted. A new test pins the Proof to exactly `derivePendingTaskProof` with `taskArtifactExpectation` |
| 2 | pr-test-analyzer | The policy test doesn't check which obligations are owed, and no era case exists | Accepted. Asserts regression is owed and new tests are not. The era case is omitted: with new tests waived, I6 is owed in no era |
| 3 | type-design-analyzer | Attestation is a boolean flag, not a typed mode | Deferred. It is a change to the Task model and the State File wire format |
| 4 | comment-analyzer | `obligationKinds` is misnamed | Accepted. It now returns the typed kinds |
| 5 | architecture-tech-lead | The exit is far from `armImplementationAttestation` | Accepted. The exit stays in the shared reset, cross-referenced from `attestedTask` |
| 6 | architecture-tech-lead | Duplicated `derivePendingTaskProof` calls | Accepted. One call |
| 7 | architecture-tech-lead | The test matches a JSON substring | Accepted. It matches the typed kind |
| 8 | code-simplifier | Duplicated derivation | Accepted (same fix as 6) |
| 9 | code-simplifier | The helper name doesn't match what it returns | Accepted (same fix as 4) |

## Support paths outside the reviewed scope

- `.claude/plans/2026-11-16-pr193-remediation.md` (this plan)
- `engine/src/core/implementation-lifecycle.ts` (cross-reference comment on `attestedTask`)

## Validation

```bash
cd engine
npx tsc --noEmit -p .
env -u PI_CODING_AGENT npx vitest run tests/core/task-revalidation-attestation.test.ts tests/core/task-reopening.test.ts tests/core/contract-revision.test.ts tests/handlers/helpers/reopen-task.test.ts tests/handlers/helpers/attest-implementation.test.ts
npm run lint
```
