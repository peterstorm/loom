# PR #67 deferred advisories (2026-10-08)

- **Branch:** `fix/pr67-deferred-advisories`, cut from `main` at `455fd273` (the PR #67 merge, tree `b469710b`, identical to
  the reviewed head `bde4282f`).
- **Source review:** the registered read-coverage standalone review of PR #67 (`eee48bf2..bde4282f`), four slices
  `raf-pr67-p01` … `raf-pr67-p04`. 25 reviewers plus one bounded retry, every one credited with full read coverage.
- **Result:** 0 surviving criticals, 0 refuted criticals, 19 advisories. `defectFamily` is `{ "kind": "not-required" }`.

## Advisory dispositions (P5, DECLARED)

1. **Initial revision, at merge time:** all 19 deferred (policy runs `raf-pr67-pNN-policy`), so the merged code stayed the
   reviewed code.
2. **Correction revision, after merge:** the operator asked for every one to be fixed. All 19 are now **accepted**, in policy
   runs `raf-pr67-pNN-policy-correction`, each chained to its initial revision by digest.

## Implementation

| WS | Commit | Area | Advisories |
|---|---|---|---|
| Y0 | 33d609ba | Docs and tests. `withBatchSubjects` doc states the contract, not a false history; ADR-0014 names "the gate's ADT"; one `durableCheckpoint()` per test; the readiness property drops assertions its exact call oracle implies; no parameter shadows the `value` unwrap. | 5 |
| Y1 | c9df0906 | `WindowInputs.of` returns a Result folded into `resolveWindowInputs`' problems (plus a total `WindowInputs.EMPTY`); one `flatMap(...).at(0)` idiom in `implementation-window.ts`; one shared, stateless artifact-baseline entry-point instance behind the type-only brand. | 4 |
| Y2 | 00593722 | Legacy panel settlement returns `ProgramParse<true>`; `canonicalPanelStateJson` takes `PanelAuthorityRosterFields<Authority>`, so a missing or non-roster field is a compile error; direct `canonicalExactRosterJson` suite. | 4 |
| Y3 | aad1ab5b | One Git run seam (`runGit` / `spawnGit`) owns argv, env and spawn options; `withShadowGit` hands a bound runner; `hardenedGitInvocation` and `GIT_OUTPUT_LIMIT` are private; `workspace-digest.ts` and `remediation-candidate.ts` use the seam. | 2 |
| Y4 | eb65d588 | Spawn claims: one refusal rule (duplicate roster entries refused); one `claimOrCompensate` combinator releases whatever a refused claim left unowned; lifecycle-level refusal tests; settlement carries an `OwnedPiSpawnReservation` parsed against the owner session. | 4 |

## Deliberate behaviour changes

- **Y3:** the workspace digest and the remediation ignore audits now run Git under the full execution policy
  (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, …), so an operator's global `core.excludesFile` no longer shapes
  them. This matches the leaf enumerator, which already ignored it; a test pins the agreement.
- **Y4:** compensation-failure text uses the ledger's release labels; a reservation naming another session is refused at
  stop resolution instead of being settled under the owner's session.

## Follow-ups found during implementation, fixed on this branch (operator instruction)

| WS | Commit | Change |
|---|---|---|
| Z1 | 257e617b | Every engine Git spawn goes through `runGit` / `spawnGit`. The modules moved here are `utils/git.ts` (root, context, HEAD), `config.ts`, `completion-check-runner.ts`, `declared-artifact-snapshot.ts`, `review-packet.ts`, `changed-paths.ts`, `model-calibration.ts`, `populate-task-graph.ts`, `reconcile-implementation-proof.ts` and `git-remediation.ts`. A static guard test refuses any Git spawn outside the seam; its allowlist has 4 justified non-Git spawns. The report reset's `check-ignore` now agrees with the remediation ignore audit. |
| Z2 | ce300348 | Session shutdown releases through the same `releaseHeldSpawnClaims` path as settlement, against the owned reservation, so a foreign reservation is left as debt. A failed compensating release is kept as an `OrphanedSpawnClaim` and retried at every settlement and shutdown. The witness-run compensation is tested through the lifecycle. |
| Z3 | 3bf2ddf8 | The Ubuntu `Timeout calling "onTaskUpdate"` flake is fixed by a suite-wide `afterEach` event-loop turn. The cause: runs of back-to-back synchronous tests never let the worker read the RPC reply before its 60 s timer fired. It was reproduced locally, and a regression test pins it. The 15 s test timeout moves into `vitest.config.ts`, and workers are capped at the CPU count. The load-sensitive tests are made cheaper, or given justified budgets. 37 local unwrap helpers now use `tests/fixtures/parse-result.ts`. `hasExactPlainKeys` replaces two private strict predicates. |

Further behaviour change from Z1: the operator's system and global Git config no longer applies to engine observations. That
includes `core.excludesFile`, `safe.directory`, `includeIf`, `diff.renames`, `core.quotePath` and `core.autocrlf`. A
repository owned by another uid now fails Git's ownership check loudly, rather than passing through a global
`safe.directory`.

## Not in scope, reported

- AD-11 (the calibration release) still needs a qualified route that enforces constraints; it is not a code defect.
- The Z3 flake fix is verified locally only; CI must confirm it.

## Validation

- `npm run verify` from the repository root.
- Registered remediation from `raf-pr67-p01` (frozen head `bde4282f`), every changed path outside that slice's frozen
  scope named as a `supportPath`, with `defectFamily: {"kind":"not-required"}`.
