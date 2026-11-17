# PR #201 remediation (loom#198, Cause 1: engine-run test evidence)

- Branch: `fix/manifest-runner-evidence` (worktree `loom-runner-model`)
- Scope: the full PR diff, 83 files (`kind: all`)
- Review run: `.claude/reviews/review-and-fix-runs/pr201-review-1` (result digest `7afd7750…f389f`)
- Policy publication: `.claude/reviews/review-and-fix-runs/pr201-policy-1` (disposition digest `62cb407e…2aeb`)

## Critical findings

None surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix / reason |
|---|---|---|
| silent-failure-hunter-1 | accepted | `run-tests` refuses (no receipt) when the produced report cannot be read back, is not UTF-8, or changed after the runner wrote it; it no longer becomes a runner-crash red |
| silent-failure-hunter-2 | deferred | fails closed; ledger lines are engine-written; the pure parser has no I/O for a diagnostic. The shared binding parser removes the realistic demotion path |
| silent-failure-hunter-3 | accepted | `populate-task-graph` prints `testEvidenceModeNotice` (stderr and the session message) |
| pr-test-analyzer-1 | accepted | engine-run graph cases in the I6 settlement matrix (both harnesses) and the status helper |
| pr-test-analyzer-2 | accepted | `tests/utils/engine-run-shell.test.ts`: symlinked root, unresolvable root |
| pr-test-analyzer-3 | accepted | same file: real CLI by relative path and symlink, look-alike, missing |
| pr-test-analyzer-4 | accepted | ledger origin cases in `engine-run-test-evidence.test.ts` |
| pr-test-analyzer-5 | accepted | `mutationRunFiles` extracted into the duty module and tested |
| pr-test-analyzer-6 | accepted | `tests/handlers/helpers/adopt-engine-run-tests.test.ts` |
| type-design-analyzer-1 | accepted | the status view receives the policy from its shell (`testEvidencePolicyAt`); a brand is not reachable (CanonicalRepositoryRoot is in utils) |
| type-design-analyzer-2 | accepted | `parseEngineRunBinding` in `core/engine-test-run.ts`, used by the receipt and the ledger origin |
| type-design-analyzer-3 | accepted | receipt refuses runner-crash with exit 0; ledger nulls a runner-crash report on a non-engine origin |
| type-design-analyzer-4 | dismissed | the stored digest binds the mode to its manifest and is what the loader checks |
| comment-analyzer-1 | accepted | extract-evidence comment rewritten |
| comment-analyzer-2 | accepted | `bunCollectionError` renamed `collectionErrorResult` with a two-use comment |
| architecture-tech-lead-1 | accepted | as type-design-analyzer-1 |
| architecture-tech-lead-2 | accepted | as type-design-analyzer-2 |
| code-simplifier-1 | accepted | tests use `AGENT_COMMAND_ORIGIN` |
| code-simplifier-2 | accepted | `engineRunnable` returns manifest and runner; both re-narrowing guards gone |
| code-simplifier-3 | accepted | `isRecord` from `core/plain-record` |
| code-simplifier-4 | accepted | as type-design-analyzer-2 |
| code-simplifier-5 | accepted | `hasExactKeys` from `core/plain-record` at all sites |
| code-simplifier-6 | accepted | `run`/`outcome` returned from the try block as consts |
| code-simplifier-7 | accepted | `named` computed once in `engineRunSection` |
| code-simplifier-8 | accepted | `mutationRunFiles` builds the tuple directly |

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-17-pr-remediation.md`
- `engine/src/handlers/helpers/populate-task-graph.ts` (silent-failure-hunter-3)
- `engine/src/handlers/helpers/red-then-green-status.ts` (type-design-analyzer-1)
- `engine/tests/handlers/helpers/adopt-engine-run-tests.test.ts` (pr-test-analyzer-6)
- `engine/tests/utils/engine-run-shell.test.ts` (pr-test-analyzer-2, -3)

## Validation (mine, not remediation evidence)

`tsc --noEmit`, `scripts/lint-project.ts`, the touched suites, and the full engine suite compared against a clean origin/main worktree.
