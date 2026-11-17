# PR #202 remediation (loom#198, Cause 3: refuse an unprovable roster at population)

- Branch: `fix/graph-checks-rescope` (worktree `loom-graph-checks`)
- Scope: the full PR diff at `8404548a` (`kind: all`)
- Review run: `.claude/reviews/review-and-fix-runs/pr202-review-1`
- Policy publication: `.claude/reviews/review-and-fix-runs/pr202-policy-1`

## Critical findings

None surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix / reason |
|---|---|---|
| code-reviewer-1 | dismissed | Mocha's xunit reporter writes a `file` attribute (Flexii's own report carries it on every testcase); the JUnit parser prefers it over classname |
| silent-failure-hunter-1 | accepted | `observeRunnerFacts` reads only absence as "no package.json"; an unreadable, invalid or non-object one is `packageJsonProblem`, which `affectedRunnerHint` names |
| pr-test-analyzer-1 | accepted | `populate-task-graph.test.ts`: a runnerless I6 refusal carries the detected preset; an unowned-Requirement refusal carries no hint |
| pr-test-analyzer-2 | accepted | new `tests/utils/repository-runner-facts.test.ts`: absent, malformed, array/string root, refused file, directory, non-string script, both Bun lockfiles |
| pr-test-analyzer-3 | accepted | `task-scope-rules.test.ts`: a contribution does not own a Requirement; one refusal names a missing test file and an unowned Requirement |
| pr-test-analyzer-4 | accepted | plural "are not" refusal tested in `run-tests.test.ts`. Deviation: the pre-I6 case is tested on `frozenNonTestFiles` in the core, because the freezer cannot produce a manifest that has an `affectedRunner` but no classification, and a hand-stripped one fails the State File's manifest-digest check, so `run-tests` can never reach that state |
| pr-test-analyzer-5 | accepted | `task-scope-rules.ts` header says the rules are exported for a scope-editing operation, not that one exists |
| type-design-analyzer-1 | accepted | `ScopeAuthority {manifest, contracts}`: the rules derive the era themselves |
| type-design-analyzer-2 | deferred | the frozen runner type is branded and minted only by its parser; every preset is pinned through the real parser by a test |
| type-design-analyzer-3 | accepted | `unownedRequirements` returns `SpecEntryId<"FR"> \| SpecEntryId<"AS">` |
| type-design-analyzer-4 | accepted | the refusal carries `problems`; the populate shell reads the repository lazily and appends the hint only for a `no-engine-runner` problem |
| comment-analyzer-1 | accepted | as pr-test-analyzer-5 |
| comment-analyzer-2 | accepted | the contract-writer fixture comment names the runner-declaring manifest |
| comment-analyzer-3 | accepted | header attributes the runner refusal to Cause 3 and the evidence to Cause 1 |
| architecture-tech-lead-1 | accepted | `frozenNonTestFiles` lives in `core/task-scope-rules.ts`; `run-tests` calls it |
| architecture-tech-lead-2 | accepted | as type-design-analyzer-4 |
| architecture-tech-lead-3 | accepted | population collects scope and ownership problems into one refusal |
| code-simplifier-1 | accepted | unused fixture imports removed from four test files |
| code-simplifier-2 | accepted | one `preset` constructor taking the report path |
| code-simplifier-3 | accepted | detection rules are plain pairs; the mocha preset is computed once |
| code-simplifier-4 | accepted | `rosterScopeProblems` partitions the owing Tasks once |
| code-simplifier-5 | accepted | as architecture-tech-lead-1 |
| code-simplifier-6 | accepted | `PackageRunnerFacts` named; `RepositoryRunnerFacts` extends it |
| code-simplifier-7 | accepted | `ownerOfRemaining` returns a list; `ownerList` deleted |

## CI failures on `8404548a` (fixed here)

- **static**: `scripts/typecheck.ts` (`noUnusedLocals`) reported fixture imports left unused when fixtures moved to `i6RunnerManifest`; removed in seven test files (code-simplifier-1 covered four of them).
- **unit**: `pi-ledger-capture.acceptance.test.ts` populated an I6-owing Task under the engine default manifest, which population now refuses; it populates under `i6RunnerManifest()` and drops engine-run mode with the shared `agentCommandGraph`.
- **smoke**: `test-validate-task-graph.sh`'s layout payload had an I6-owing Task with no test file and owned no Requirement; T1 now owns FR-001/AS-001 and waives new tests, since those cases pin State File layouts, not I6.

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-17-pr202-remediation.md`
- `engine/tests/utils/repository-runner-facts.test.ts` (pr-test-analyzer-2)
- `engine/tests/acceptance/pi-ledger-capture.acceptance.test.ts` (CI unit)
- `artifacts/tests/test-validate-task-graph.sh` (CI smoke)

## Validation (mine, not remediation evidence)

Run as CI runs it (root and engine `bun install --frozen-lockfile`, Node 22): `scripts/typecheck.ts` 0 errors; `scripts/lint-project.ts` no violations; unit suite 20250 passed, 3 failed in two files (`project-snapshot`, `surface-stop-check-notes`) that fail identically on clean main locally and are not in this diff; `test:smoke` exit 0.
