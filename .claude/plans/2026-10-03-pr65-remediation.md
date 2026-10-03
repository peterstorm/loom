# PR #65 remediation — directory artifact snapshots

- Branch: `fix/artifact-baseline-directory-artifacts` (reviewed head `6dff2236`)
- Review Run: `.claude/reviews/review-and-fix-runs/run.pr65-review-1`
  (result digest `f0d0522169c0cf893f69cc470df7825d603c8f25ac2843b71adb386cb0a5dbcf`)
- Scope (frozen by the engine): `engine/src/core/artifact-baseline.ts`,
  `engine/src/core/implementation-application.ts`, `engine/src/core/validate-task-execution.ts`,
  `engine/src/utils/artifact-baseline.ts`, and their five test files.
- Reviewers: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
  architecture-tech-lead (deepen), code-simplifier (distill).

## Adjudication

- Emitted/admitted: 0 critical, 5 advisory. After refutation: 0 surviving, 0 refuted, 5 advisory.
- Surviving critical dispositions: none. Declared Repair Groups: none.
  Defect family: `{"kind":"not-required"}`.
- Refuted critical audit: none.

## Advisory policy (DECLARED)

Published through the P5 publisher: `.claude/reviews/review-and-fix-runs/run.pr65-policy-1`,
revision `initial`, disposition digest
`02c25aeb938821e39efe604b49a6a772b62ed0e619c1172d7e6fbe4afaf1fe8a`.

| Finding | Decision | Reason |
| --- | --- | --- |
| silent-failure-hunter-1 | accepted | Worktree walk hashes Git-ignored files that `git ls-tree` never lists, so an ignored cache below a directory artifact over-reports a change against `start_sha`. |
| type-design-analyzer-1 | deferred | Call sites are correct and tested; branding artifacts vs written paths ripples through persisted `Task` string fields and legacy callers — a separate type migration. |
| architecture-tech-lead-1 | accepted | Same root cause as silent-failure-hunter-1; fixed by restricting the worktree adapter to Git-visible leaves and pinning parity with a test. |
| architecture-tech-lead-2 | dismissed | The prefix rule already lives in one function (`artifactCovers`); its callers use distinct semantics, so an `ArtifactScope` wrapper fails the deletion test. |
| code-simplifier-1 | accepted | Three identical `execFileSync` option blocks; extract one private Git output helper. |

## Accepted fixes

1. `engine/src/utils/artifact-baseline.ts`: the worktree directory walk collects leaves, drops
   Git-ignored ones with a single `git check-ignore --stdin -z` (tracked files are never reported
   ignored, matching Git), then hashes the remainder. A fifo that Git does not ignore still throws.
   Untracked, non-ignored files still count — they are genuinely new relative to any revision.
2. Same file: one private `gitOutput(root, args, input?)` owns cwd, buffer encoding, stdio and the
   100 MiB limit for `gitTreeLeaves`, `readArtifactObject` and `nulSeparatedGitPaths`.
3. `engine/tests/utils/artifact-baseline.test.ts`: an ignored file inside a committed directory
   artifact leaves worktree and revision snapshots equal, and editing it reports no change; an
   ignored fifo does not throw.

## Validation

- `npm --prefix engine run typecheck`
- `cd engine && npx vitest run tests/utils/artifact-baseline.test.ts tests/core/artifact-baseline.test.ts tests/handlers/helpers/task-local-completion.integration.test.ts`
- `npm --prefix engine run test:unit`
- Registered zero-critical remediation run with this plan as a support path.
