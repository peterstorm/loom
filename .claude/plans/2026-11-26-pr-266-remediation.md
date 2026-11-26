# PR #266 remediation: share every workspace package's node_modules

- **Branch:** `fix/265-workspace-node-modules` (peterstorm/loom PR #266, fixes #265)
- **Scope:** `all`, frozen by the review run (7 files: `engine/src/core/owner-verification/node-modules-directories.ts`, `engine/src/orchestration/owner-mutation-workspace.ts`, their two tests, `docs/verification.md`, `docs/executable-models-enforcement.md`, `docs/feature-guard-map.md`)
- **Review run:** `.claude/reviews/review-and-fix-runs/pr266-review-1`. Seven reviewers. Inspection counts: 5 total, 0 surviving critical, 0 refuted critical, 5 advisory.
- **Policy publication:** `.claude/reviews/review-and-fix-runs/pr266-policy-1`, disposition digest `9de8bfe10c17ce01742d4d767f8ac62d45648d1195249789594adfe1f40fdbd8`

## Critical findings

There are none, so there are no repair groups. The remediation starts with `defectFamily: {"kind":"not-required"}`.

## Refuted findings

None.

## Advisory dispositions (DECLARED, all accepted)

| Finding | Decision | Reason and fix |
|---|---|---|
| pr-test-analyzer-1 | accepted | The shell's refusal arm was untested. **Fix:** a workspace test with a leading-space package directory, which `parseReviewPath` refuses. It asserts `worktree-failed` naming the holder, that nothing runs, and that no worktree is left behind. |
| pr-test-analyzer-2 | accepted | This exposed a real gap. Git lists a partly committed package `node_modules` entry by entry, never whole, so it was never linked. **Fix:** the holder is now the directory of the outermost `node_modules` segment of any ignored entry. A committed-package fixture test pins this. |
| comment-analyzer-1 | accepted | "every installed" overstated what is shared. **Fix:** the module header, the workspace header, `docs/verification.md` and `docs/executable-models-enforcement.md` now name exactly what is shared, and state that a `node_modules` inside a wholly ignored parent is not. |
| architecture-tech-lead-1 | accepted | The share set was split between the core and the shell. **Fix:** `sharedNodeModulesDirectories(listing, runnerCwd)` now returns the whole set (root, runner cwd normalised to its outer holder, listed holders), so the shell only lists and links. |
| architecture-tech-lead-2 | accepted | A mid-loop refusal dropped the links already made. **Fix:** `shareNodeModules` now unlinks them before returning (`unlinkAll`, shared with `remove`). The per-workspace listing is unchanged: it was measured at about 12 ms on a 13-package repository, so threading one listing through the runners is not worth widening the spec. |

## Validation (local, mine; the remediation run is the engine's check)

- `npx vitest run tests/docs/facts.test.ts tests/core/owner-verification-node-modules-directories.test.ts tests/orchestration/owner-mutation-workspace.test.ts tests/orchestration/task-mutation-runner.test.ts tests/orchestration/owner-verification-runner.test.ts`
  - Every TypeScript case passes.
  - The 6 Java owner-verification cases fail locally only because the borrowed `node_modules` lacks `java-parser`. They passed in CI on the previous head.
- `npx tsc --noEmit -p engine` shows no errors in the changed files.
- The CI run on the pushed commit is authoritative.
