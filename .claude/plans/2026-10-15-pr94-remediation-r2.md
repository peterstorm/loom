# PR #94 remediation (review-and-fix round 2)

- **Branch:** `feat/stop-check-plan-pilot`, HEAD `42136b56` at review
- **Scope:** `all`, the 18 files of the PR diff against `main`
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261015-pr94r2`
  - 7 reviewer slots, all captured on attempt 1
  - Emitted: 0 critical, 5 advisory. After refutation: 0 surviving critical, 0 refuted, 5 advisory.
- **Policy publication:** `policy-20261015-pr94r2`, initial revision, disposition digest `e3532f0d65b0717bbf17c54766e14ac6dc1b4b44e4f0f0cb36214593b28bad15` (DECLARED)

## Surviving criticals

None, so the defect family is `not-required`. There are no repair groups, siblings, selected checks or Historical RED declarations.

## Refuted criticals

None.

## Advisory dispositions

| ID | Disposition | Reason and fix |
|---|---|---|
| type-design-analyzer-1 | accepted | The claim that nested arrays are unfrozen is inaccurate: `nonEmpty` and `freezeArray` upstream freeze `owed`, `files` and `errors`. But the guarantee was unpinned, because tests asserted only top-level `Object.isFrozen`. Fix: a property test that deep-freezes each generated graph (as the State File parser does) and asserts every view and rendering is deeply frozen. A mutation check (dropping the inner `Object.freeze(reason)`) makes it fail. |
| comment-analyzer-1 | accepted | The plan's Phase 1 fixture list now names every export the committed module has, and notes that rounds 1 and 2 moved `runStopCheckPlanCli` and `offLine` there. |
| architecture-tech-lead-1 | deferred | The shared-planner deepening would modify the piloted hook (AD-2). It is the same finding as round 1's architecture-tech-lead-1 and is already scoped into G4 slice 2. `docs/operations.md` already names the per-stop state the plan does not read. |
| code-simplifier-1 | accepted | One `offLine` now lives in `tests/fixtures/stop-check-plan-fixtures.ts`, typed `StopCheckOffReason["kind"]`. The core and acceptance tests import it. |
| code-simplifier-2 | dismissed | The inner `Object.freeze(reason)` is load-bearing: `Object.freeze` is shallow, so without it the reason object would be mutable. The `command-refused` errors array is already frozen by `failure()`. The new deep-freeze property fails when that freeze is removed. |

## Validation

- `npx tsc --noEmit` (engine/)
- Focused tests: the core, acceptance and handler suites (3 files, 44 tests)
- `npm run verify` (root)

## Support paths outside the reviewed scope

This plan file is the only one: `.claude/plans/2026-10-15-pr94-remediation-r2.md`.
