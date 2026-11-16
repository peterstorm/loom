# PR #195 remediation: read absolute report paths against the run root

- **Branch:** `fix/absolute-report-paths` (worktree `~/dev/claude-plugins/loom-report-paths`)
- **Scope reviewed:** the PR diff against `origin/main` (15 files, kind `all`)
- **Review Run:** `.claude/reviews/review-and-fix-runs/run.pr195-review`
  (result digest `a06d8c42e5ad689cab9b38022bc2271960a553be5c015c0b50f8925cbbfffcc3`)
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/run.pr195-policy`
  (disposition digest `d101b4adb9716b9ebb21179cffa700133f3156054cb738f133c50a108883a271`)

## Engine-observed counts

The engine admitted 0 critical and 7 advisory Findings. After refutation, 0 criticals survived and 0 were refuted.

## Surviving criticals

None. The remediation start uses `defectFamily: {"kind":"not-required"}`.

## Refuted criticals

None.

## Advisory dispositions (DECLARED, all accepted)

| Finding | Decision | Fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | Stop-check tests add a `mocha-report` runner case, covering acceptance and affected, blocked and passing. Wave-suite tests add a `mocha:` completion mode, covering contract-Wave RED and an already-passing testcase that gets named. Each test fails against `origin/main`'s shell. |
| pr-test-analyzer-2 | accepted | The owner-verification fixture runner gains a `mocha` mode that writes absolute files from its own cwd. The runner test verifies 5 of 5 kills in the isolated worktree and fails with `origin/main`'s classifier. |
| type-design-analyzer-1 | accepted | `runRoot` is a core `RunRoot` brand minted by `parseRunRoot`. `CanonicalRepositoryRoot` is now `RunRoot & …`, so every shell root qualifies by construction. |
| type-design-analyzer-2 | accepted | `testcasesUnderRunRoot` is no longer exported. `parseJunitTestcasesUnder` is the only entry point. |
| architecture-tech-lead-1 | accepted | New project lint rule `.claude/linter/rules/inv-9-one-rooted-report-parse.json` refuses any other engine call of the raw `parseJunitTestcases`. A probe file confirmed the rule fires. |
| code-simplifier-1 | accepted | Same change as type-design-analyzer-2. The tests now drive `parseJunitTestcasesUnder` with generated report bytes. |
| code-simplifier-2 | accepted | Shared fixture `engine/tests/fixtures/mocha-report.ts` provides `mochaXunit` and a canonical `RUN_ROOT`, replacing three builders and five root constants. |

## Support paths (outside the reviewed scope)

- `.claude/plans/2026-11-16-pr195-remediation.md`
- `.claude/linter/rules/inv-9-one-rooted-report-parse.json`
- `engine/src/utils/workspace-digest.ts`
- `engine/tests/fixtures/mocha-report.ts`
- `engine/tests/fixtures/owner-verification-repo.ts`
- `engine/tests/handlers/stop-checks.test.ts`
- `engine/tests/handlers/helpers/wave-completion-suite.test.ts`

## Validation (mine, not remediation evidence)

- `bun scripts/typecheck.ts`: exit 0.
- `bun ../scripts/lint-project.ts`: no violations.
- `npx vitest run` over 18 files, 648 tests, all passing: report-run-root, owner-verification outcome and core acceptance, task-mutation-check and runner, owner-verification runner, report-file attribution, acceptance-contract, affected-stop-check, stop-checks (including mutation), acceptance-stop-check, wave-completion-suite (including owner and parity), owner-verification gate acceptance, stop-check-plan, and workspace-digest.
- RED against `origin/main`: the stop-check, wave-suite and owner-runner Mocha tests each fail with `main`'s shell or classifier restored, and pass with this branch's.
