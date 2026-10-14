# PR #90 remediation, round 2: Acceptance Stop Check review

- **Branch:** `feat/g4-acceptance-stop-check` (reviewed head `e9038589`)
- **Scope:** the frozen diff of PR #90, which covers 17 files (`kind: all`, `files: null`).
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261014T181946Z-e9038589`
  - Reviewer Protocol v2, 7 reviewers.
  - Result digest `a1eb2ecb0fff295e6b0c08a2412215ecb8b5ae8d89f09b424829f04c534d0303`.
- **Critical findings:** 0 surviving and 0 refuted, so no Refutation Panel ran.
  - Defect family: `not-required`. There are no Declared Repair Groups and no Historical RED declarations.
- **Advisory policy:**
  - Published by `.claude/reviews/review-and-fix-runs/policy-20261014-pr90-r2`.
  - Revision `initial`, provenance DECLARED.
  - Disposition digest `076a5f77f2638be6887783520d25f29be12deb34d4a7ce7489d9eea617df29d5`.

## Advisory dispositions (all 13 accepted)

| ID | Disposition | Fix |
|----|-------------|-----|
| silent-failure-hunter-1 | accepted | A runner that timed out or was killed by a signal becomes a note before its partial report is judged. |
| silent-failure-hunter-2 | accepted | `RunnerLock.release` returns its fault (`string \| null`). ENOENT counts as released; any other fault is appended to the note, or turns a pass into a note. |
| pr-test-analyzer-1 | accepted | Pi's `reportAcceptanceStopCheck` is exported with injectable ports. It is tested for a failing claimant (one report-only line), a null Task, a crash, and no counter. There is a hooks.json budget test, and a frozen engine-default form carrying a runner is refused. |
| type-design-analyzer-1 | accepted | `VerificationManifest` is a union: a schema-1 manifest has no runner (`acceptanceRunner?: never`), and a schema-2 manifest may carry one. |
| type-design-analyzer-2 | accepted | The stale reap renames the lock to a unique name, deletes it only if it still holds the stale bytes, and links back a lock another stop took. `LockHolder` = live \| stale{bytes} \| gone. |
| comment-analyzer-1 | accepted | The `did-not-run` doc now names an owed file that produced no testcase. |
| comment-analyzer-2 | accepted | operations.md lists the cap note, the timeout and signal note, and the release-fault note. |
| architecture-tech-lead-1 | accepted | Same fix as type-design-analyzer-2, with a deterministic `reapStaleRunnerLock` test of the reaped, retaken and absent paths. |
| architecture-tech-lead-2 | accepted | `hooks-sync.test.ts` asserts that the SubagentStop dispatch timeout is at least `MAX_ACCEPTANCE_RUNNER_TIMEOUT_MS` + 60 s. |
| architecture-tech-lead-3 | accepted | `FrozenVerificationManifest` is a union: the engine-default variant has `projectChecks: readonly []` and no runner. `frozenManifest` takes a tagged `FrozenAuthority`. |
| code-simplifier-1 | accepted | `declaresRunner` is shared by both parsers, and the source parser probes the record once. |
| code-simplifier-2 | accepted | `resolveSessionManager` returns a resolved \| unresolved union, so dispatch binds `manager` as a const with no alias. |
| code-simplifier-3 | accepted | `didNotDecide` is hoisted to module level. The cap wording stays distinct on purpose, because it is operator text. |

## Residual (DECLARED)

The rename-verify reap leaves one race. It needs three stops: two reap the same stale lock, and a third locks in the instant between the rename and the link-back. The check stays fail-open and non-authoritative, and the Wave Gate judges every claimant.

## Validation

- `npx tsc --noEmit` passes in `engine`.
- The targeted vitest files pass:
  - stop-check shell;
  - dispatch stop-check;
  - Pi report;
  - hooks-sync;
  - core stop-check;
  - verification-manifest.
- `npm run verify` covers prerequisites, typecheck, the full Vitest suite and all six smokes.

## Remediation

Start a registered remediation run with `defectFamily: not-required`. Its `supportPaths` are this plan file, the new `engine/tests/pi/acceptance-stop-check-report.test.ts`, and `engine/tests/machine/hooks-sync.test.ts`.
