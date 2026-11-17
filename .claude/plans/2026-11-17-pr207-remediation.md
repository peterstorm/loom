# PR #207 remediation (loom#198, Cause 5: recovery ergonomics)

- Branch: `fix/recovery-ergonomics` (worktree `loom-recovery-ux`)
- Scope: the full PR diff at the review (`kind: all`, 15 files)
- Review run: `.claude/reviews/review-and-fix-runs/pr207-review-1`
- Policy publication: `.claude/reviews/review-and-fix-runs/pr207-policy-1`

## Critical findings

None surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix / reason |
|---|---|---|
| code-reviewer-1 | dismissed | the manifest parser refuses an absolute executable, so no candidate is absolute by spelling; a test pins the refusal |
| silent-failure-hunter-1 | accepted | the unresolved-executable warning prints only after a create, replace or unchanged outcome |
| silent-failure-hunter-2 | accepted | a roster read failure other than absence is named on stderr |
| silent-failure-hunter-3 | accepted | the doc states the forced exit bounds the drain and any stray handle together |
| pr-test-analyzer-1 | accepted | `unresolvedExecutablesWarning(manifest, PATH dirs, exists)` owns the rule; tested with a fake `exists` over project, PATH and acceptanceRunner cases |
| pr-test-analyzer-2 | accepted | `tests/cli-exit-codes.test.ts`: 0 / 1 / 2 through the CLI |
| pr-test-analyzer-3 | accepted | the stray-handle case asserts the exit took at least `FORCED_EXIT_MS`; the defect pin stays (1 MiB exceeds every pipe buffer and the reader is paused) |
| pr-test-analyzer-4 | accepted | unprobeable transcript, unparseable session id, empty roster, injected observer |
| type-design-analyzer-1 | accepted | `exitAfterFlush`'s doc: it returns, so call it last |
| type-design-analyzer-2 | deferred | a parsed Claude Code agent id and a millisecond type are a separate typing pass |
| comment-analyzer-1 | accepted | the `.active` sentences are their own paragraph |
| comment-analyzer-2 | accepted | as silent-failure-hunter-3 and type-design-analyzer-1 |
| comment-analyzer-3 | accepted | the empty roster is named among the cases that judge nothing |
| architecture-tech-lead-1 | accepted | as pr-test-analyzer-1 |
| architecture-tech-lead-2 | accepted | as silent-failure-hunter-1 |
| architecture-tech-lead-3 | accepted | `neverStartedRosterEntries` takes an injectable observer and has no side effect; the skipping and pruning callers say so |
| code-simplifier-1 | accepted | as architecture-tech-lead-3 |
| code-simplifier-2 | accepted | the test imports `TranscriptPresence` |
| code-simplifier-3 | accepted | the abandonment label and next step come from one branch |

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-17-pr207-remediation.md`
- `engine/tests/cli-exit-codes.test.ts` (pr-test-analyzer-2)

## Validation (mine, not remediation evidence)

As CI runs it (root and engine deps installed, Node 22): `scripts/typecheck.ts`, `scripts/lint-project.ts`, the touched suites, the full unit suite (against the two files that fail on clean main locally) and `test:smoke`.
