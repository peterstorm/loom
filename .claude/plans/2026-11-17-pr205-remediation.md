# PR #205 remediation (loom#198, Cause 4: engine revision pin)

- Branch: `fix/engine-revision-pin` (worktree `loom-engine-revision`)
- Scope: the full PR diff at the first push (`kind: all`, 16 files)
- Review run: `.claude/reviews/review-and-fix-runs/pr205-review-1`
- Policy publication: `.claude/reviews/review-and-fix-runs/pr205-policy-1`

## Critical findings

None surviving, none refuted. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Fix / reason |
|---|---|---|
| silent-failure-hunter-1 | accepted | `populationEngineRevision`: re-population keeps an existing pin, so a different engine is refused at the write boundary and only adoption moves a graph between engines |
| pr-test-analyzer-1 | accepted | `observeEngineRevision` takes the identity as a parameter; tested on its self-hosted, pinned and non-repository arms |
| pr-test-analyzer-2 | accepted | population tests: an existing pin and its adoptions survive re-population; a graph without one takes the observed pin; not-observed leaves it unpinned |
| type-design-analyzer-1 | accepted | `EngineRevision` is a branded type minted by `isEngineRevision` and `engineRevisionOf`; pins and adoptions hold it |
| type-design-analyzer-2 | accepted | the population command's `engineRevision` is required: `observed` with a pin, or `not-observed` with a cause, like `proofBoundary` |
| type-design-analyzer-3 | accepted | `isSelfHosted` handles a repository root that already ends in the separator |
| comment-analyzer-1 | accepted | the write boundary judges the pin against the strict-boundary identity explicitly; `runningEngineIdentity`'s doc says so |
| comment-analyzer-2 | accepted | the module header states the standing rule; the incident stays in loom#198 |
| architecture-tech-lead-1 | accepted | as comment-analyzer-1 |
| architecture-tech-lead-2 | accepted | as type-design-analyzer-2 |
| code-simplifier-1 | accepted | the population core imports the observation type from the pin module, no second types import |
| code-simplifier-2 | accepted | `isAdoptionReason` is the one reason rule the adoption and the parser share |
| code-simplifier-3 | accepted | the pin types sit below the import block |
| code-simplifier-4 | accepted | `isEngineRevision` has its own test with negative cases |

The pure-core population tests now state `engineRevision: { kind: "not-observed", cause: "fixture" }` beside their `proofBoundary`, as the required field asks.

## Support paths (outside the frozen scope)

- `.claude/plans/2026-11-17-pr205-remediation.md`
- the population-core test files that gained the required field: `engine/tests/state-file-wire-skeletons.test.ts`, `engine/tests/core/task-rescope.test.ts`, `engine/tests/core/task-graph-population-spec-authority.test.ts`, `engine/tests/core/task-graph-population-owner-obligations.test.ts`, `engine/tests/core/acceptance-contract-load.test.ts`, `engine/tests/core/proof-obligations-red-then-green.test.ts`, `engine/tests/core/task-graph-population.test.ts`, `engine/tests/core/task-scope-rules.test.ts`, `engine/tests/core/owner-obligations.matrix.test.ts`, `engine/tests/core/red-then-green-era.matrix.test.ts`, `engine/tests/core/task-graph-population-distill.test.ts`, `engine/tests/core/contract-writer-i6.test.ts`, `engine/tests/acceptance/pi-ledger-capture.acceptance.test.ts`, `engine/tests/acceptance/red-then-green.acceptance.test.ts`, `engine/tests/handlers/i6-settlement.matrix.test.ts`

## Validation (mine, not remediation evidence)

As CI runs it (root and engine deps installed, Node 22): `scripts/typecheck.ts`, `scripts/lint-project.ts`, the touched suites, the full unit suite (against the two files that fail on clean main locally) and `test:smoke`.
