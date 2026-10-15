# PR #94 remediation (review-and-fix round 1)

- **Branch:** `feat/stop-check-plan-pilot`
- **Scope:** `all`, the 17 files of the PR diff against `main`
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261015-pr94`
  - 7 reviewer slots, all captured
  - Emitted: 0 critical, 6 advisory. After refutation: 0 surviving critical, 0 refuted, 6 advisory.
- **Policy publication:** `policy-20261015-pr94`, initial revision, disposition digest `0509d446145e0cba6959f2c8e1695145eb02dcc2ac5feb1e81e5667a894a15c6` (DECLARED)

## Surviving criticals

None, so the defect family is `not-required`. There are no repair groups, siblings, selected checks or Historical RED declarations.

## Refuted criticals

None.

## Advisory dispositions (all accepted)

| ID | Disposition | Fix |
|---|---|---|
| comment-analyzer-1 | accepted | Spec NFR-001 now says "read-only helper pattern: `KNOWN_HANDLERS.helper` only, not `WHITELISTED_HELPERS`". |
| comment-analyzer-2 | accepted | The pilot plan's spec outline is marked as the pre-pilot draft, names the committed spec as the requirement authority, and lists the numbering differences. |
| architecture-tech-lead-1 | accepted | `docs/operations.md` no longer says the plan "cannot disagree" with the check. It names the per-stop state the plan does not read: the block counter cap, the repository root and the runner lock. The shared-planner deepening (one pure prefix of `decideStop` used by both the hook and the view) would modify the piloted hook; it is scoped into G4 slice 2. |
| code-simplifier-1 | accepted | `tests/core/stop-check-plan.test.ts` imports `NonEmpty` from `core/orchestration-contract` instead of redeclaring it. |
| code-simplifier-2 | accepted | The handler declares `let graph: TaskGraph`. |
| code-simplifier-3 | accepted | `runStopCheckPlanCli` lives in `tests/fixtures/stop-check-plan-fixtures.ts`. The acceptance test and the handler fidelity test both use it; the CT-1 freeze ended with the orchestration teardown. |

## Validation

- `npx tsc --noEmit` (engine/)
- Focused tests: the core, acceptance, handler and `tests/linter` suites (21 files, 1047 tests)
- `npm run verify` (root)

## Support paths outside the reviewed scope

This plan file is the only one: `.claude/plans/2026-10-15-pr94-remediation.md`.
