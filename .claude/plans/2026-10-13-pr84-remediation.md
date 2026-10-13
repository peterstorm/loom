# PR #84 remediation — G1 contracts before code

- **Branch:** `feat/g1-contracts-before-code` (PR #84, base `main`)
- **Review scope:** the full PR diff, split under the 240,000-unit reader budget into two registered Standalone Review Runs:
  - `run.pr84-review-src-1` — the 24 `engine/src/**` files (result `875e9c2e…14ad`)
  - `run.pr84-review-rest-1` — the 37 test, doc, template and plan files (result `5d755c30…fa20`)
- **Runs root:** `.claude/reviews/review-and-fix-runs`

## Adjudication

Both runs: 0 critical emitted, 0 surviving, 0 refuted. 16 + 13 advisories.

No surviving criticals, so no Declared Repair Groups, no repair checks and no Historical RED: the remediation start uses `defectFamily: {"kind":"not-required"}`.

## Advisory policy (published, DECLARED)

- `run.pr84-policy-src-1` — disposition digest `54dab4a0…a2d5`
- `run.pr84-policy-rest-1` — disposition digest `316216e9…e9af`

| Run | Finding | Decision | Fix / reason |
|---|---|---|---|
| src | code-reviewer-1, silent-failure-hunter-2 | accepted | Excusal is report-derived; documented precisely in `judgeAcceptance`/evaluator docs and as an `executable-models.md` residual; runner must be its own check or the last step, without exit-failing thresholds |
| src | silent-failure-hunter-1 | accepted | `FrozenPathObservation = digest \| unreadable{reason}`; drift and revision messages name the read error |
| src | pr-test-analyzer-1 (+ rest pr-test-analyzer-1) | accepted | Handler tests: claimant-Wave GREEN with a pending failure excused, a due failure blocked, post-revision re-record, contracts-changed install guard |
| src | type-design-analyzer-1 | accepted | `ContractGateExpectation` red (no roster) \| green (roster \| null); parser refuses red+roster |
| src | type-design-analyzer-2, code-simplifier-1 | accepted | One `COVERABLE_ANCHOR`/`CONTRACT_ID` grammar exported by `acceptance-contract.ts`; branding all ids out of scope |
| src | type-design-analyzer-3 | accepted | Result/receipt parser refuses an explicit acceptance observation that owes nothing |
| src | architecture-tech-lead-1 (+ rest atl-1, cs-2) | accepted | Evaluator takes the live `AcceptanceExpectation`; tests use `evaluateAsRecorded` fixture |
| src | architecture-tech-lead-2, code-simplifier-3 | accepted | One `graphAcceptanceExpectation(graph, wave)` for both shell sites |
| src | architecture-tech-lead-3 | deferred | Module split along wire/judgment/freeze seams is a separate deepen session; no wrongness |
| src | architecture-tech-lead-4 | accepted | Typed `observation-stale` refusal when the locked contract names a path the shell never observed |
| src | code-simplifier-2, -4, -5 | accepted | Early returns in `parseContract`; single-pass `frozenPathDigests`; whitespace |
| rest | type-design-analyzer-1 | accepted | Brief test digests via `parseArtifactDigest` |
| rest | comment-analyzer-1, -2 | accepted | Plan says implemented claimants; runner "own check or last step" aligned |
| rest | architecture-tech-lead-2 | accepted | One `contractWriter` owner shared by plan validation and population; load guard is a different persisted invariant |
| rest | architecture-tech-lead-3, code-simplifier-1 | accepted | `satisfiedProof` fixture in `tests/fixtures/task-lifecycle.ts`; per-scenario contract literals stay inline |
| rest | code-simplifier-3, -4, -5 | accepted | `contractFixture(mode, stage)`; `sha256Hex` instead of `node:crypto`; `anchorId` helper |
| rest | code-simplifier-6 | dismissed | Prompt templates are deliberately self-contained; the engine enforces the grammar |

## Support paths outside the src-slice source run

The remediation runs against `run.pr84-review-src-1`; every changed path outside its 24 files is registered as a support path (tests, docs, plan, and the new `tests/fixtures/completion-suite-evaluation.ts` and changed `tests/fixtures/task-lifecycle.ts`, which neither run reviewed).

## Validation

- `npm --prefix engine run verify` (typecheck, full Vitest suite, shell suites)

## Round 2

- **Review runs:** `run.pr84-review-src-2` (24 `engine/src/**` files) and `run.pr84-review-rest-2` (40 test/doc/plan files), against `60c9639a`.
- **Adjudication:** 0 critical emitted, 0 surviving, 0 refuted; 13 + 10 advisories.
- **Policy (published, DECLARED):** `run.pr84-policy-src-2` (`f80d9dde…1c47`), `run.pr84-policy-rest-2` (`d354d4cc…6b5a`).

| Run | Finding | Decision | Fix / reason |
|---|---|---|---|
| src | silent-failure-hunter-1 | dismissed | Same documented report-only excusal limit; no engine observation attributes an exit cause beyond the report |
| src | type-design-analyzer-1 | accepted | `parseContract` refuses `revised` without a revision, revisions before the freeze, and freeze paths that differ from the last revision's |
| src | type-design-analyzer-2 | dismissed | No illegal state left: red has no roster; green `roster: null` is a legal named state read through `recordsRoster` |
| src | type-design-analyzer-3, architecture-tech-lead-2 | accepted | Every contract path normalized at plan parse; absolute or `..` paths refused (`unsafe-path`) in the plan and the persisted parser; duplicates compared normalized |
| src | architecture-tech-lead-1 | deferred | One contract-role function across five sites is a deepen-session interface change |
| src | architecture-tech-lead-3 | accepted | `contract-revision.ts`, `task-revalidation.ts`, `wave-gate-registration.ts` enrolled in `DEFAULT_PURE_MODULES`; machine-purity closure green |
| src | architecture-tech-lead-4 | deferred | Module split, as in round 1 |
| src | code-simplifier-1 | accepted | `exactRecord` delegates to `plain-record`'s `parseExactRecord`/`exactRecordErrors` |
| src | code-simplifier-2 | accepted | `contractWave` and `contractClaimants` owned by `acceptance-contract.ts`, reused by Contract Revision |
| src | code-simplifier-3 | accepted | Receipt parser judges once |
| src | code-simplifier-4 | accepted | Double cast and stray blank line removed |
| src | code-simplifier-5 | accepted | `plan-paths` re-export deleted; callers import `plan-path-match` |
| rest | code-reviewer-1, code-simplifier-2 | accepted | Imports before helpers in `acceptance-contract.test.ts` |
| rest | silent-failure-hunter-1 | accepted | `recordedExpectation` throws on an unparseable recorded expectation |
| rest | comment-analyzer-1, code-simplifier-4 | accepted | `revise-contract.test.ts` hashes through `sha256Hex` |
| rest | comment-analyzer-2 | accepted | Red-window prose: authored regression waivers are kept |
| rest | code-simplifier-1 | accepted | Shared `digest`/`seen` fixtures (`tests/fixtures/acceptance-fixtures.ts`); scenario Task builders stay local |
| rest | code-simplifier-3, -5 | accepted | `acceptancePath` and `completionOutcome` helpers |
| rest | code-simplifier-6 | accepted | Two overlapping residual bullets merged; refusal lists stay per audience |
