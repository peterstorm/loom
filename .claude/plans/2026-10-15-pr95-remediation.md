# PR #95 remediation (review-and-fix round 1)

- **Branch:** `fix/g4-pilot-friction`, HEAD `1c351f43` at review
- **Scope:** `all`, the 9 files of the PR diff against `main`
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261015-pr95`
  - 7 reviewer slots, all captured on attempt 1
  - Emitted: 0 critical, 4 advisory. After refutation: 0 surviving critical, 0 refuted, 4 advisory.
- **Policy publication:** `policy-20261015-pr95`, initial revision, disposition digest `cbf5c381ebc8b95766d9f252e6ce376ada0bd637d48789933cdc6943282ab281` (DECLARED)

## Surviving criticals

None, so the defect family is `not-required`. There are no repair groups, siblings, selected checks or Historical RED declarations.

## Refuted criticals

None.

## Advisory dispositions

| ID | Disposition | Reason and fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | Only the absence of the false prerequisite was pinned. The advisory-pause end-to-end test now changes a reviewed declared file while the gate waits, asserts status reports `accepted Review Packet authority is stale`, then restores the bytes and asserts it clears before deciding. |
| pr-test-analyzer-2 | accepted | The Claude stop-hook settlement line had no test. `update-task-status-project-boundary.test.ts` now settles a byte-scope violation through `runUpdateTaskStatus` and asserts the stderr line and `failure_reason` name `src/foreign.ts`. Reverting the line to the bare kind makes it fail. |
| type-design-analyzer-1 | deferred | Storing typed failure detail on the Task would change the State File wire schema; receipts already keep the typed kinds, and nothing consumes the offending paths as data today. Revisit when a consumer needs them. |
| comment-analyzer-1 | accepted | The `describeSettlement` doc comment now says only a byte-scope violation carries detail. The F6/F8 test-comment tags stay: they point at the durable G4 pilot record in the vault note and `docs/operations.md`. |

## Validation

- `npx tsc --noEmit` (engine/)
- Focused tests: the project-boundary suite (5 tests) and the advisory-pause end-to-end test
- `npm run verify` (root)

## Support paths outside the reviewed scope

- `.claude/plans/2026-10-15-pr95-remediation.md` (this plan)
- `engine/tests/handlers/subagent-stop/update-task-status-project-boundary.test.ts` (the new stop-hook line test)
