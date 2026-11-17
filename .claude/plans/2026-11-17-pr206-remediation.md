# PR #206 remediation (loom#198, Cause 5: read-only git and gh invocations)

- Branch: `fix/guard-read-only-subcommands` (worktree `loom-guard-readonly`)
- Scope: the full PR diff at the first push (`kind: all`, 8 files)
- Review run: `.claude/reviews/review-and-fix-runs/pr206-review-1`
- Policy publication: `.claude/reviews/review-and-fix-runs/pr206-policy-1`

## Critical findings

None surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix / reason |
|---|---|---|
| code-reviewer-1 | accepted | `read-only-gh.ts` refuses `--editor`/`-e` (an environment-named editor) like `--web`/`-w`, in any abbreviation or bundle |
| silent-failure-hunter-1 | accepted | the contract is stated where it holds: read-only means writes no local file and runs no program, as for every `READ_ONLY_STATE_COMMANDS` head (`echo`, `printf`); both guards protect local paths only |
| pr-test-analyzer-1 | accepted | table tests for `isReadOnlyGhInvocation`: bundled `-w`, abbreviated `--we`, `-e`/`--editor`, after `--`, `--jq .web`, unlisted verbs |
| type-design-analyzer-1 | accepted | `READ_ONLY_GH_INVOCATIONS` maps a group to its verbs, with `api` as no-verb |
| type-design-analyzer-2 | deferred | a typed placeholder and a branded `StaticWords` span both guards' tokenizers; the substring rule only refuses, never admits |
| type-design-analyzer-3 | accepted | the test header names the real classifiers; trailing blank lines removed |
| comment-analyzer-1 | accepted | as type-design-analyzer-3 |
| architecture-tech-lead-1 | accepted | `isReadOnlySubcommandInvocation(segment, spell)`; the subagent authority guard calls it with its pinned spelling, so one git/gh dispatch serves both guards |
| architecture-tech-lead-2 | accepted | as silent-failure-hunter-1 |
| architecture-tech-lead-3 | accepted | as code-reviewer-1 |
| code-simplifier-1 | accepted | as type-design-analyzer-3 |
| code-simplifier-2 | accepted | `tool-vocabulary.ts` ends with one newline |
| code-simplifier-3 | accepted | the stray double blank line in `subagent-authority.ts` is gone |
| code-simplifier-4 | accepted | the verb map removes the redundant null check |
| code-simplifier-5 | dismissed | the exported string signature serves the tests and the subagent guard; the extra split runs only on segments naming guarded state |

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-17-pr206-remediation.md`

## Validation (mine, not remediation evidence)

As CI runs it (root and engine deps installed, Node 22): `scripts/typecheck.ts`, `scripts/lint-project.ts`, the guard, walker, shell and subagent-authority suites (1,447 tests), the full unit suite (against the two files that fail on clean main locally) and `test:smoke`.
