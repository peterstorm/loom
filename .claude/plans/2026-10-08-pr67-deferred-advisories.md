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

## Not in scope, reported

- Other Git spawns still use the ambient environment: `resolveRepositoryRoot`, `repositoryContext`, `observeExactHead` in
  `utils/git.ts`, `completion-check-runner.ts`, `declared-artifact-snapshot.ts`, `review-packet.ts`, `changed-paths.ts`,
  `config.ts`, `model-calibration.ts`, `populate-task-graph.ts`, `reconcile-implementation-proof.ts`, `git-remediation`.
- `pi/session-shutdown.ts` removes roster entries under `reservation.sessionId` rather than the owned reservation.
- A failed compensating release is reported in the refusal text but not retained as cleanup debt.
- The witness-run compensation is tested at the `claimOrCompensate` interface, not through the lifecycle.
- Load-sensitive tests at the 5 s default: `reviewer-protocol-history` (seven-reviewers-retry), the unseeded
  `persistent-panel-kernel.property`, and the `pi-extension-review-events` drift test.

## Validation

- `npm run verify` from the repository root.
- Registered remediation from `raf-pr67-p01` (frozen head `bde4282f`), every changed path outside that slice's frozen
  scope named as a `supportPath`, with `defectFamily: {"kind":"not-required"}`.
