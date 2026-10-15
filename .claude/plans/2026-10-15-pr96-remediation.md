# PR #96 remediation (review-and-fix round 1)

- **Branch:** `refactor/shared-stop-check-planner`. HEAD at review: `950cfe82`.
- **Scope:** `all`, the 7 files of the PR diff against `main`.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261015-pr96`.
  - All 7 reviewer slots were captured on attempt 1.
  - Reviewers emitted 0 critical and 1 advisory finding. After refutation: 0 critical survived, 0 were refuted, and the 1 advisory remains.
- **Policy publication (DECLARED):**
  - Initial revision: `policy-20261015-pr96`, digest `3dfb06b1520a729a0ced1752daaa72705fc1bde6cdfaab72acc6097e6ec65360`.
  - Correction: `policy-20261015-pr96-c1`, artifact sha256 `e3e4c7d8005fcb98a0cf7d7c22133cafb9b9fd040b8f20a96b8826a4fdf3a7e2`.
  - The correction replaces the first revision's reason after the barrel route proved impossible (see below).

## Surviving criticals

None, so the defect family is `not-required`. There are no repair groups, siblings, selected checks or Historical RED declarations.

## Refuted criticals

None.

## Advisory dispositions

| ID | Disposition | Reason and fix |
|---|---|---|
| architecture-tech-lead-1 | accepted | The decision core sat in the module documented as the view and renderer. `planStopCheck`, `StopCheckPlan` and `AcceptanceRunnerCommand` move to their own core module, `core/acceptance-contract/stop-check-planner.ts`. `stop-check-plan.ts` keeps only the view and the renderer. |

The reviewer's alternative was to re-export the planner from the `acceptance-contract` barrel. I tried it and reverted it. It closes a runtime import cycle, because `verification-manifest` reaches the barrel through other core modules. A full verify caught it: `orchestration-contract-acyclic.test.ts` failed, and 26 manifest and Wave-suite tests failed from the broken module initialisation order. So the hook imports the planner module directly. The reason is stated at the import and in the module header. `CONTEXT.md` and the feature plan name the new module.

## Validation

- `npx tsc --noEmit`, run in `engine/`.
- The unused-locals check, scoped to `src/` and `tests/`.
- Focused tests: the acyclic import graph, the manifest properties, the Wave completion suite, the stop-check plan, the subagent-stop handlers and the stop-check-plan helper.
- `npm run verify`, run at the repository root: 511 files, 12,684 passed, 1 skipped, all smokes, exit 0. Two earlier runs failed: the barrel attempt broke the import graph, and the new module was first left out of the pure-module list.

## Support paths outside the reviewed scope

- `.claude/plans/2026-10-15-pr96-remediation.md` (this plan)
- `engine/src/core/acceptance-contract/stop-check-planner.ts` (the planner's new module)
- `engine/src/linter/programmatic/no-io-in-pure-modules.ts` (declares the new module pure; the purity-closure test requires it)
