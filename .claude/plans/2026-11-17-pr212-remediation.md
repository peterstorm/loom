# PR #212 remediation (loom#199 Causes 2 and 3: plan edits, coupled file sets)

- Branch: `fix/active-wave-plan-edits` (worktree `loom-plan-edits`)
- Scope: the full PR diff, 33 files (`kind: all`)
- Review run: `.claude/reviews/review-and-fix-runs/pr212-review-1` (result digest `93e83852…f4a`)
- Policy publication: `.claude/reviews/review-and-fix-runs/pr212-policy-1`

## Engine-observed counts
17 findings: 1 surviving critical, 0 refuted, 16 advisory.

## Surviving critical (DECLARED accounting)
`architecture-tech-lead-1`: repaired, group `group.same-wave-predecessor-output`.

- **Root cause.** `predecessorOutputs` required every dependency to be `completed`. Status and registration release a same-Wave dependent once its dependency is `implemented`, so the brief refused a Task the other two consumers released.
- **Invariant.** Status, registration and the brief judge a `depends_on` edge by the same rule. A same-Wave dependency is satisfied once it settles its implementation, and an earlier-Wave dependency once it is `completed`.
- **Siblings.** `dependencyExecutionBlock` (registration) and `dispatchHoldOf` (status and brief gating) already apply the rule and are pinned by tests. No other `depends_on` consumer gates dispatch: `implementation-brief.ts` reads only `predecessorOutputs`.
- **Repair.** `predecessorOutputs` accepts a settled same-Wave dependency and marks it `awaiting-wave-gate`; the brief says it is not yet reviewed. A new error kind, `dependency-not-settled`, covers a same-Wave dependency that has not settled.
- **Check.** `project:verify`.
- **Historical RED (DECLARED).** `task-implementation-brief.integration.test.ts`, "briefs a dependent whose same-Wave dependency has settled", fails against the reviewed bytes: the brief is refused with `dependency-not-completed`.

## Advisory dispositions (DECLARED)
- **Accepted (14):**
  - code-reviewer-1: the coupled check applies only to sets the edit touches.
  - silent-failure-hunter-1: comment.
  - pr-test-analyzer-1, -2, -3: new tests.
  - type-design-analyzer-1: `RescopeAddition`.
  - type-design-analyzer-2: `sealed` is NonEmpty.
  - type-design-analyzer-4, code-simplifier-3: per-blocker escalation.
  - comment-analyzer-1, -2, -3 and architecture-tech-lead-2: comments and help text.
  - code-simplifier-1: shared `waveReopeningRefusalMessage`.
- **Dismissed (1):** type-design-analyzer-3. The strict `wave_plan_edits` parse in the same `parseTaskGraph` call guards the load.
- **Deferred (1):** code-simplifier-2. A shared flag walker would also touch Forward Fix parsing and its messages.

## Support paths (outside the reviewed scope)
- `.claude/plans/2026-11-17-pr212-remediation.md`
- `engine/src/core/predecessor-output.ts`
- `engine/src/core/task-revalidation.ts`
- `engine/tests/core/predecessor-output.test.ts`
- `engine/tests/orchestration/task-implementation-brief.integration.test.ts`

## Validation (mine, not remediation evidence)
- `tsc --noEmit` reports 0 errors.
- Lint is clean.
- The related set passes: 205 files, 4,558 tests.

## Remediation run 1 blocked; fixed and superseded by run 2
`pr212-remediation-1` blocked because `project:verify` failed 1 of 20,613 tests: `tests/linter/doc-references/project-snapshot.test.ts`, "a worktree whose .git points nowhere". The failure predates this PR (the same test fails on `fix/failure-attribution`) and is specific to this machine's git:
- Apple Git 2.39 words a dangling `.git` file as "not a git repository: /nowhere/...".
- `gitListing` read that wording as "outside a repository" and fell back to the disk instead of failing closed.

Fix (support path `engine/src/linter/doc-references/project-snapshot.ts`): the run counts as "outside a repository" only when no `.git` entry sits at the root or above. All linter tests pass: 46 files, 2,178 tests.
