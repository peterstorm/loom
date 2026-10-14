# PR #85 remediation — G1 acceptance deepen

- **Branch:** `refactor/g1-acceptance-deepen` (PR #85, stacked on `feat/g1-contracts-before-code` / PR #84)
- **Review scope:** the 23 added/modified files of `aacd96ec` (the deleted `core/acceptance-contract.ts` is absent from `origin/main`), passed as explicit `--files`; the engine diffs them against `merge-base origin/main` (frozen diff ≈ 171 KB, one run under the 240,000-unit budget).
- **Review run:** `run.pr85-review-1` (result `c75e47ce…17bb`), runs root `.claude/reviews/review-and-fix-runs`

## Adjudication

0 critical emitted, 0 surviving, 0 refuted; 18 advisories (code-reviewer, silent-failure-hunter and pr-test-analyzer reported none).

No surviving criticals, so no Declared Repair Groups, no repair checks and no Historical RED: the remediation start uses `defectFamily: {"kind":"not-required"}`.

## Advisory policy (published, DECLARED)

- `run.pr85-policy-1` — initial revision, disposition digest `1613a931…777b`

| Finding | Decision | Fix / reason |
|---|---|---|
| type-design-analyzer-1 | dismissed | Same shape dismissed in #84 round 2: green `roster: null` is a legal named state read only through `recordsRoster`; a split variant changes the persisted wire for no newly reachable illegal state |
| type-design-analyzer-2 | accepted | `AcceptanceObservation` is branded; only `acceptanceObservation(expectation, facts)` mints one and returns `undefined` when the expectation owes nothing; parser and `observeAcceptance` go through it |
| type-design-analyzer-3 | accepted | Plan parse adds `duplicate-anchor`; the persisted parser refuses a repeated anchor in an acceptance file or roster entry (`anchorList`); contractTask plausibility stays with the load-boundary `contractWriter` |
| comment-analyzer-1 | accepted | `ContractRole` doc names the brief as its reader and `redWindowTaskIds` as population's sibling |
| comment-analyzer-2, code-simplifier-3, architecture-tech-lead-2 | accepted | New `handlers/helpers/subagent-quiescence.ts` owns `SubagentActivity`, `subagentActiveRefusal` and `assertQuiescentUnderLock` for revise-contract, amend-spec-trace and upgrade-spec-trace; `wave-gate-replacement` keeps its interleaved orphan-recovery checks and wording |
| comment-analyzer-3, code-simplifier-5 | accepted | Doc on `recordedAcceptanceVerdict`, not its type; `verdict.excused` used directly; stray blank line removed |
| comment-analyzer-4 | accepted | Purity allowlist comment names every enrolled module, drops the "G1" label |
| comment-analyzer-5 | accepted | `docs/architecture.md` wire.ts entry: expectation and report facts; the observation envelope is parsed in `completion-suite.ts` |
| architecture-tech-lead-1 | accepted | `ACCEPTANCE_RED_WINDOW` and `COVERED_BY_ACCEPTANCE_CONTRACT` exported by `verification-policy.ts` inside its reason unions; `model.ts` re-exports, `binding.ts` imports |
| architecture-tech-lead-3 | accepted | `validate-model-bindings` reads the waiver through `parseVerificationPolicy`, typed `NewTestWaiverReason \| null` |
| architecture-tech-lead-4 | accepted | `renderContractWriterProblem` beside `contractWriter`; population reports the typed writer problems |
| code-simplifier-1 | accepted | `binding.ts` reuses `claims` (task narrowed to `id`/`spec_anchors`); `anchorClaimants` folded into `dueWaves` |
| code-simplifier-2 | dismissed | Local `freeze = Object.freeze` is the project-wide idiom (completion-suite, verification-manifest, claude-transcript-integrity, wave-completion-suite) |
| code-simplifier-4 | accepted | Brief blocks return the joined string |
| code-simplifier-6 | accepted | Double blank lines collapsed in both helper tests |

## Support paths outside the reviewed scope

`engine/src/core/parse-plan-models.ts`, `engine/src/core/verification-policy.ts`, `engine/src/handlers/helpers/subagent-quiescence.ts`, `engine/src/handlers/helpers/upgrade-spec-trace.ts`, `engine/src/handlers/helpers/wave-completion-suite.ts`, `engine/tests/core/completion-suite-acceptance.test.ts`, `engine/tests/core/parse-plan-models.test.ts`, `engine/tests/handlers/helpers/subagent-quiescence.test.ts`, `engine/tests/handlers/validate-model-bindings.test.ts`, and this plan.

## Distill pass

One move: the observation constructor uses the module's `freeze`/`freezeArray` helpers. Skipped: none further in the remediation diff.

## Validation

- `npm --prefix engine run verify` — 495 files, 12,495 tests (1 skipped), 23/23 shell suites

## Round 2 (after #84 merged as `3a69d9b6`; #85 retargeted to `main`)

- **Review run:** `run.pr85-review-2` (result `095af87a…7a55`), the full 34-file branch diff against `origin/main` in one run. silent-failure-hunter's first attempt was refused for unread pages and its retry was admitted.
- **Adjudication:** 0 critical emitted, 0 surviving, 0 refuted; 14 advisories (code-reviewer and pr-test-analyzer aside from one test gap reported none).
- **Policy (published, DECLARED):** `run.pr85-policy-2`, initial revision, disposition digest `7797dcc7…8a5a`. All 14 accepted.

| Finding | Decision | Fix |
|---|---|---|
| silent-failure-hunter-1, pr-test-analyzer-1 | accepted | Test: a malformed policy carrying the contract waiver gives binding no waiver, and the policy parser validate-task-graph runs refuses it |
| type-design-analyzer-1, architecture-tech-lead-2 | accepted | Private `claimedAnchors` in `tasks.ts` is the one claimant rule; `claims` and `contractRole` both derive from it; `contractRole` is pinned against `contractClaimants` |
| type-design-analyzer-2, architecture-tech-lead-1, code-simplifier-1 | accepted | `QuiescentOperation` closed union with per-operation settle wording (upgrade's "exact roster" restored); `createUpgradeSpecTraceHandler(subagentActive)` with an under-the-lock race test |
| architecture-tech-lead-3 | accepted | `AcceptanceObservation`, `acceptanceObservation`, `RecordedAcceptanceVerdict` and `recordedAcceptanceVerdict` moved to `acceptance-contract/gate.ts` (exported by the index); `completion-suite.ts` keeps the envelope parse |
| comment-analyzer-1 | accepted | Deepen plan move 3 reworded |
| comment-analyzer-2 | accepted | `index.ts` comment no longer lists sibling-only exports |
| comment-analyzer-3 | accepted | `docs/architecture.md` row names `kernel.ts`, `task-dependencies.ts` and the observation's new home |
| code-simplifier-2 | accepted | `renderContractProblem` no longer exported |
| code-simplifier-3 | accepted | `ACCEPTANCE_RED_WINDOW` re-exports removed; population, the brief and the test import it from `verification-policy.ts` |
| code-simplifier-4 | accepted | `decidedAnchors` helper shared by `observedRoster` and `excused` |

- **Support paths outside the reviewed scope:** `engine/src/core/task-graph-population.ts`, `engine/tests/handlers/helpers/upgrade-spec-trace.test.ts`.
- **Validation:** `npm --prefix engine run verify` — 495 files, 12,498 tests (1 skipped), 23/23 shell suites.
