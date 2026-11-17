# PR #203 remediation (loom#198, Cause 3b: orchestration rescope-task)

- Branch: `fix/rescope-task` (worktree `loom-graph-checks`)
- Scope: the full PR diff at the first push (`kind: all`, 16 files)
- Review run: `.claude/reviews/review-and-fix-runs/pr203-review-1`
- Policy publication: `.claude/reviews/review-and-fix-runs/pr203-policy-1`

## Critical findings

None surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix / reason |
|---|---|---|
| silent-failure-hunter-1 | accepted | `rescopeTask` refuses (`path-not-removable`) a removal naming a path the Task does not list, unless an earlier audited edit of that Task removed it, so a typo is never read as success and a replay stays idempotent |
| pr-test-analyzer-1 | accepted | on a populated graph: export-bound removal, contract-frozen addition, contract-writer refusal |
| pr-test-analyzer-2 | accepted | distill-task, attested, completed-wave and implementation-active refusals |
| pr-test-analyzer-3 | accepted | skeleton outcome of a removed path dropped and the rest kept, plus adding a file to a Task with outcomes, each reloaded |
| type-design-analyzer-1 | accepted | `core/wave-plan-edit.ts`: `taskRescopedEdit` is the one constructor the command and the State File parser both build an edit through |
| comment-analyzer-1 | accepted | `baselineRevision` doc: null when nothing was added or there was no baseline |
| comment-analyzer-2 | accepted | recovery doc and `rescopeBaselineDuty` doc: the no-`start_sha` refusal applies to a request that adds a file |
| architecture-tech-lead-1 | accepted | the reason rule and bound live in the leaf `core/wave-plan-edit.ts`; the parser no longer imports the command module |
| architecture-tech-lead-2 | accepted | `parseWavePlanEdit` dispatches on `kind` |
| code-simplifier-1 | accepted | fresh arrays frozen directly |
| code-simplifier-2 | accepted | one `parsePlanEditReason` for the CLI and the parser |
| code-simplifier-3 | dismissed | `WavePlanEdit` is the declared seam for loom#199's further edit kinds, which the parser now dispatches on |
| code-simplifier-4 | accepted | `i6PendingTaskFixture` in `tests/fixtures/task-lifecycle.ts`, used by both suites |
| code-simplifier-5 | accepted | one `baselineRevisionFor` rule feeds the read duty, the refusal and the audit |

Also fixed while there: the State File parser cast `record.reason as string` on wire data; it now parses the reason with `parsePlanEditReason`.

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-17-pr203-remediation.md`
- `engine/src/core/wave-plan-edit.ts` (type-design-analyzer-1, architecture-tech-lead-1)
- `engine/tests/fixtures/task-lifecycle.ts` (code-simplifier-4)

## Validation (mine, not remediation evidence)

As CI runs it (root and engine deps installed, Node 22): `scripts/typecheck.ts`, `scripts/lint-project.ts`, the touched suites, the full unit suite (compared against the two files that fail on clean main locally: `project-snapshot`, `surface-stop-check-notes`) and `test:smoke`.
