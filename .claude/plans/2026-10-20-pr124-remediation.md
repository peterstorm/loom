# PR #124 remediation

**Branch:** `fix/stop-check-runner-env`
**Scope:** the PR's frozen diff:
- `docs/workflows.md`
- `engine/src/orchestration/completion-check-runner.ts`
- `engine/tests/orchestration/project-command-environment.test.ts`

**Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261020-pr124` (result `8eec5802…4c10`). It has 7 of 7 slots captured: 0 critical, 2 advisory, 0 refuted.
**Advisory policy:** `policy-20261020-pr124`, initial revision, disposition digest `51ace264…fa09`, DECLARED.

## Surviving criticals

None. `defectFamily` is `{"kind":"not-required"}`.

## Refuted criticals

None.

## Advisory dispositions

| ID | Decision | Reason |
|---|---|---|
| type-design-analyzer-1 | accepted | An `as const` tuple of the four names gives a closed `HookInvocationVariable` type, and the lookup set is derived from it. |
| architecture-tech-lead-1 | accepted | The environment rule is pure, so it moves to `engine/src/core/project-command-environment.ts` and is enrolled in the purity check. The runner keeps only its single spawn-site application. |

## Accepted fixes

- New file `engine/src/core/project-command-environment.ts`:
  - `HOOK_INVOCATION_VARIABLES` is now an `as const` tuple, with `HookInvocationVariable` derived from it;
  - `projectCommandEnvironment` is a pure function over a plain record.
- `completion-check-runner.ts` imports the rule and applies it at `spawn`. The rule's definition leaves the runner.
- The module is enrolled in `DEFAULT_PURE_MODULES` (`no-io-in-pure-modules.ts`).
- The test moves to `engine/tests/core/project-command-environment.test.ts`, with its imports updated. It still includes the spawn integration case.

## Support paths (outside the frozen scope)

- `engine/src/core/project-command-environment.ts`
- `engine/tests/core/project-command-environment.test.ts`
- `engine/src/linter/programmatic/no-io-in-pure-modules.ts`
- `.claude/plans/2026-10-20-pr124-remediation.md`

## Validation

- `bun scripts/typecheck.ts` (engine): clean.
- `npx vitest run` (engine): 550 files, 13481 passed, 1 skipped.
