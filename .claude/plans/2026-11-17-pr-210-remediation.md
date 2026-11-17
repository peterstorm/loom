# PR #210 remediation: regression failure attribution (loom#199 Cause 1)

- Branch: `fix/failure-attribution` (worktree `loom-failure-attribution`)
- Scope: the `all` review of the PR diff, 7 files
- Review run: `.claude/reviews/review-and-fix-runs/pr210-review-1` (result digest `d8bb8abc…c911`)
- Policy publication: `.claude/reviews/review-and-fix-runs/pr210-policy-1` (`artifacts/disposition.json`)

## Engine-observed counts
16 findings in total: 0 surviving critical, 0 refuted, 16 advisory. There is no defect family, so the remediation carries `defectFamily: not-required`.

## Advisory dispositions (DECLARED)
15 accepted and 1 deferred (`architecture-tech-lead-3`). Each reason is in the published disposition.

Accepted fixes:
1. `regressionScope` replaces `foreignTestOwners`. The scope is a `whole-run` | `attributed` union with NonEmpty owner lists per file.
   - Files the settling Task declares itself are excluded.
   - Settledness comes from a `Record<TaskStatus, boolean>`.
2. `RegressionAttribution.stands` is a bare discriminant. The owner lookup carries the owner, so the unreachable guard is gone.
3. `resolveTestEvidence` attributes once, on the final trusted run.
4. Comments are corrected:
   - the pre-lock roster sentence in the handler and the ADR;
   - the module header states the current rule;
   - the loom#198 reference links `docs/verification.md`.
5. New handler test `engine/tests/handlers/subagent-stop/update-task-status-regression-scope.test.ts`.

## Defect found by the new test (beyond the advisories)
The settlement's Guarded Skill Machine fold judged each run by its own facts. An attributed pass therefore left code-implementer's terminal `TestRunPassed` unmet and capped the verdict at untrusted, so the original fix alone would not have unblocked the fugue-dags T28.

Fix:
- `foldEvidence`, `advance` and `tokensFor` take an optional `TestRunJudge`. Its default, `judgeRunFacts`, keeps the PreToolUse gate unchanged.
- The handler passes `attributedTestRunJudge(scope)`.
- The `TestRunJudge` type lives in `machine/test-report.ts` and is re-exported through `machine/evidence` (core's allowed import).

Support paths outside the reviewed scope:
- `engine/src/machine/{advance,evidence,index,test-report}.ts`
- `engine/tests/handlers/subagent-stop/update-task-status-regression-scope.test.ts`

## Validation
- `tsc --noEmit`: 265 errors, identical to main, none in touched files.
- `bun run lint`: clean.
- Targeted vitest: core attribution, implementation-evidence, machine, handlers/subagent-stop, update-task-status, docs. All 47 files and 1053 tests pass.
- The full suite runs in CI.
