# PR #116 remediation: the live input carries no root without a readable epoch

- **Branch:** `feat/g4-slice-2-pilot` (base `main`). It adds `helper red-then-green-status`, the G4 slice 2 pilot vehicle.
- **Scope:** the PR's 10 files (`kind: all`), one registered review run.
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr116-review-1`, result digest `b0db6f1fc546ac495a9deb2d1d032cbf7c0f0a36ad5f071994eb2c311b4a6bcc`. 7 slots issued and 7 captured, each under the engine-enforced read-coverage obligation.
- **Counts:** 0 critical and 8 advisory emitted and admitted. After refutation, 0 critical survive and 0 were refuted. No Refutation Panel ran.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/run.pr116-policy-1`, revision `initial` (DECLARED).

## Surviving and refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| type-design-analyzer-1 | accepted | The `live` input arm fabricated `repositoryRoot: ""` beside an unreadable ledger. `RedThenGreenLiveInput` now has an `unreadable { reason }` arm, and `live` carries the read `events` with the root, so the sentinel cannot be built. |
| architecture-tech-lead-1 | accepted | Same defect as type-design-analyzer-1, fixed by the same split. The handler resolves the root only for a readable ledger, and a new test pins that. |
| comment-analyzer-1 | accepted | `LIVE_NOT_JUDGED` read `not judged (I6 not owed)` even when the header said `I6 undeterminable`. It now reads `not judged (no I6 obligation to judge it by)`, and the `LiveView` comment and the docs bullet name both duties. |
| comment-analyzer-2 | accepted | The plan's `classifyTaskFiles` call, `status` type and purity enrolment drifted from the code. The plan now carries an "As shipped" note. |
| code-simplifier-1 | accepted | About 70 lines of fixtures were duplicated across the core and helper tests. They now live in `engine/tests/fixtures/red-then-green-status-fixtures.ts`. Each test file keeps only what is unique to it: the core keeps its `SHOWN_EVENTS`, which has a leading read so its indices differ. |
| code-simplifier-2 | accepted | `flatMap(...)[0]` encoded first-match-or-none through an array. `redThenGreenResult` now returns `StoredView \| undefined`, read with `map(...).find(...)`. |
| type-design-analyzer-2 | deferred | Its main point, that the not-owed reason is derived a second time beside `redThenGreenDuty`, needs the duty's `not-owed` arm to carry its cause. That is an interface change to settlement's shared `implementation-application.ts`, outside this feature PR. The spec's FR-005 split was deliberate. The `failureKind` union belongs with that deepening. |
| architecture-tech-lead-2 | deferred | It asks to make `redThenGreenDuty` the single owner of both the verdict and its reason. That is the same cross-module interface change, recorded for a deepen pass. |

Also fixed, from the Wave 2 gate's deferred advisory (`T3-comment-analyzer-1`, run `wg-pilot-w2-20261020`): `docs/operations.md` now documents the fourth not-owed reason.

## Support paths outside the reviewed scope

- `.claude/plans/2026-10-20-pr116-remediation.md` (this plan)
- `engine/tests/fixtures/red-then-green-status-fixtures.ts` (the shared fixtures module)

## Validation

- `bun engine/scripts/typecheck.ts`: clean.
- Focused: `npx vitest run tests/core/red-then-green-status.test.ts tests/handlers/helpers/red-then-green-status.test.ts`, 68 passed.
- Full: `npm --prefix engine run verify`.
