# PR #215 remediation (loom#200: retrospectives)

- Branch: `feat/retro` (worktree `loom-retro`)
- Scope: the full PR diff, 31 files (`kind: all`)
- Review run: `.claude/reviews/review-and-fix-runs/pr215-review-1` (result digest `2e8618e8…f76`). Two reviewers were retried by the engine: one finding was outside the frozen scope, and one reviewer had incomplete read coverage.
- Policy publication: `.claude/reviews/review-and-fix-runs/pr215-policy-1`

## Engine-observed counts
23 findings: 0 critical, 23 advisory. Defect family: `not-required`.

## Advisory dispositions (DECLARED)
21 accepted, 1 deferred (type-design-analyzer-2: branding), 1 dismissed (code-simplifier-6: double path parse). Each reason is in the published disposition.

The main fixes:
- **The retro could not be written** (code-reviewer-1). `block-direct-edits` refused the session's write into `.claude/retros/` while the graph is live, and completion requires that retro. The guard now admits a Markdown file directly in the repository's retro directory; unresolved sites stay guarded.
- **Typed completion shortfalls** replace the prose string that status matched on (type-design-analyzer-1, architecture-tech-lead-1, code-simplifier-2).
- **One known-Wave rule** (`retroScopeKnown`) is shared by the helper and the State File parser. Records are compared field by field.
- **Freshness** lives in `retro-triggers.ts` as `freshRetroSuggestions`.
- **Tests:** parser refusals, per-Wave derivations, real engine adoptions, freshness, the Wave-scoped-only status case, the handler refusal and the guard admission.

## Beyond the admitted findings
- The first-attempt code-reviewer finding was refused for its out-of-scope file, but it was right: re-population now drops `retro_records` with the rest of the earlier plan's history (`task-graph-population.ts`).

## Support paths (outside the reviewed scope)
- `.claude/plans/2026-11-17-pr215-remediation.md`
- `engine/src/core/block-direct-edits.ts`
- `engine/src/core/cli-flag-token.ts`
- `engine/src/core/task-graph-population.ts`
- `engine/src/handlers/helpers/complete-orchestration.ts` (renders the typed shortfalls)
- `engine/tests/core/retro-document-write.test.ts`

## Validation (mine, not remediation evidence)
- `tsc` reports 0 errors.
- Lint is clean.
- 25 targeted files pass, 846 tests (retro, completion, status, wire, guard, population, docs).
