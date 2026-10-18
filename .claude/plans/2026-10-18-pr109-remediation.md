# PR #109 remediation: admission asks the per-check gate, not a faked failure

- **Branch:** `refactor/stop-check-block-kinds` (base `main`)
- **Scope:** the review's frozen diff was the PR's 6 files (`kind: all`). This remediation edits three of them
  and adds this plan.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261018-pr109`
  (`result.json` digest `d89116c43c06d8d2a57f7ca367bfd62ab7ff23e75931f5da95cce200ceaa88c8`)
- **Counts (inspection renderer):** 0 critical and 1 advisory emitted and admitted. After refutation:
  0 critical surviving, 0 refuted, 1 advisory. 7 slots issued, 7 captured.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261018-pr109`,
  revision `initial`, disposition digest `4e3aca869b04ed8bb49e762363bb5781810bf9ae7b8f352686532e29fd50c24c`
  (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| architecture-tech-lead-1 | accepted | The PR made the block decision carry real failures, and `admitted()` now faked one (`FAILING_ALONE` passed `true`) to ask a question with no failure in it: may this check still block? The complete in-scope fix exposes that per-check gate (cap reached, counter unreadable) as one pure function, `blockAdmission`, which `checkStep` and the shell's admission both use, removing the sentinel. |

## Accepted fix

- `engine/src/core/affected-stop-check.ts`: `blockAdmission(name, issued, cap): BlockAdmission`
  (`may-block` with the count the counter would record, or `fails-open` with that check's note). `checkStep`
  applies it to a failing check.
- `engine/src/handlers/subagent-stop/stop-checks.ts`: `admitted(taskId, arm, admission)` keeps a runnable arm
  only on `may-block`; `decide` passes `blockAdmission(...)` per check. `FAILING_ALONE` is gone. Notes are
  unchanged (`stop checks for <task>: <note>`).
- `engine/tests/core/affected-stop-check.test.ts`: `blockAdmission` tests for admission, the cap, an unreadable
  counter, and a property that the decision blocks a lone failing check exactly when the gate admits it, at
  the count the gate names.

## Support paths (outside the frozen scope)

- this plan

## Validation

- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: nothing in `src/`, `tests/` or `pi/`
- the covering suites: `affected-stop-check`, `stop-checks`, `tests/acceptance`, `tests/pi`
- `npm run verify` (root)
