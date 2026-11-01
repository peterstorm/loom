# PR 140 remediation: the G5b review deferrals (#132–#136)

Branch `refactor/g5b-deferrals`, reviewed head `6f18be39`. The frozen diff against `origin/main` is 266 KB, over one reviewer's budget, so it was reviewed as two themed slices that cover all 50 changed files exactly once. Each slice had 7 reviewers under `.claude/reviews/review-and-fix-runs`.

- **Slice a:** #136 owner duties and #134 briefs, with most of the docs (28 files).
- **Slice b:** #135 status, #133 coverage and #132 completion suite (22 files).

| Slice | Review run | Emitted/admitted | After refutation | Policy run | Disposition digest |
|---|---|---|---|---|---|
| a | `pr140-a-6f18be39` | 0 critical, 8 advisory | 0 surviving, 0 refuted | `pr140-a-policy-6f18be39` | `78d69d9a` |
| b | `pr140-b-6f18be39` | 0 critical, 9 advisory | 0 surviving, 0 refuted | `pr140-b-policy-6f18be39` | `8acff119` |

No slice has a surviving or refuted critical. So there is no Declared Repair Group, no Historical RED and no selected check, and the remediation start declares `defectFamily: not-required`. Three reviewers per slice-attempt hit the engine's read-coverage refusal once (a: pr-test-analyzer, comment-analyzer; b: pr-test-analyzer). Each was re-issued and captured on attempt 2.

The advisory dispositions are `DECLARED` and published as each slice's initial P5 revision. Each policy run's `artifacts/disposition.json` holds the exact reasons.

## Slice a advisories (8: all accepted)

- **type-design-analyzer-1, architecture-tech-lead-2 and code-simplifier-2:** plan-integrity invented a `drifted` agreement for an unstamped duty.
  - That put the absent-stamp-is-drift rule outside `obligations.ts`.
  - Fix: `stampAgreement(duty, models)` in `obligations.ts` answers an unstamped duty as `drifted`. Plan integrity matches only the three real agreements.
- **type-design-analyzer-2:** the stamped `WaveOwnerDuty` carried an `agreementWith` closure, so duties were not structurally comparable data.
  - Fix: the stamp sits under a module-private symbol key that only `stampAgreement` reads.
  - A test pins that two duties of the same graph and Wave are `toEqual`.
- **architecture-tech-lead-1 and code-simplifier-1:** the stamped-or-plan brief source was chosen in both the shell and the test fixture.
  - Fix: one pure chooser, `invariantOwnershipSourceOf(duty, readPlanInvariants)`, in `core/implementation-brief.ts`.
  - The shell passes its plan read lazily, and the fixture calls the same function.
  - Unit tests pin three behaviours: a stamped duty never reads the plan, an unstamped duty reads it once, and a read refusal passes through unchanged.
- **comment-analyzer-1:** ADR-0034 and ADR-0032 said the shell hands the renderer the `TaskOwnerDuty` and decides nothing else.
  - Both now say the renderer receives an `InvariantOwnershipSource`, matching ADR-0040.
- **comment-analyzer-2:** the matrix header now says an unstamped graph gets no owner map and no owner duties, but still renders the plan's ownership blocks.

## Slice b advisories (9: all accepted)

- **code-reviewer-1 and code-simplifier-4:** a perl edit dropped a template placeholder (`got ${evaluation.cause}`). Restored.
- **pr-test-analyzer-1:** the exit branch of `receiptOwnerError` was untested, and it turned out to be unreachable.
  - An accepted receipt's observation carries no finding, so it derives exit 0.
  - `parseAcceptedChecks` already refuses any other exit. Only acceptance facts excuse an exit, and they must bind a produced report, which the owner check never has.
  - Fix: remove the dead branch and document where the exit is proven. Add a test that a re-signed receipt with a flipped owner exit is refused.
- **type-design-analyzer-1:** the `infrastructure` rejection arm admitted only-owner-undecided failures.
  - Fix: it now holds `NonEmpty<Exclude<…, OwnerUndecidedFailure>>`, with a nullable `ownerUndecided` beside it, as in the semantic arm. Tested.
- **comment-analyzer-1:** ADR-0031's Status paragraph still described the pre-#135 remedy trigger.
  - Rewritten to cite `ownerVerificationRemedies`. #135 added to the amendment line.
- **code-simplifier-1:** readiness builds `ownerVerificationRemedies` with `isNonEmpty` in one expression.
- **code-simplifier-2:** `coverage.ts` exports one `MODULE_ABSENT`, declared before use, and the runner imports it.
- **code-simplifier-3:** `withOwnerVerificationRemedies` binds the rejected readiness once.
- **code-simplifier-5:** the property tests destructure `rejectionFailures` once per block, into a non-shadowing `failures`.

## Validation

- `bun engine/scripts/typecheck.ts`
- Targeted vitest for every touched suite.
- Full-tier lint (`bun scripts/lint-project.ts`): 77 violations, the same baseline as `main`.
- Root `npm run verify`.
- Registered remediation:
  - One schema-v2 run against `pr140-a-6f18be39` with `defectFamily: not-required`.
  - Its `supportPaths` name this plan and every touched path outside slice a's frozen scope (the slice b files).
  - A separate run against `pr140-b-6f18be39` is not needed, because one installation covers the whole candidate (the PR #137 precedent).

# Round 2 (reviewed head `7c7be87d`)

The same two slices were reviewed again. The plan file joins slice b.

| Slice | Review run | Emitted/admitted | After refutation | Policy run | Disposition digest |
|---|---|---|---|---|---|
| a | `pr140-r2-a-7c7be87d` | 0 critical, 5 advisory | 0 surviving, 0 refuted | `pr140-r2-a-policy-7c7be87d` | `78f1441a` |
| b | `pr140-r2-b-7c7be87d` | 0 critical, 10 advisory | 0 surviving, 0 refuted | `pr140-r2-b-policy-7c7be87d` | `00428aba` |

All 15 advisories were accepted, and the remediation is again `defectFamily: not-required`.

## Slice a, round 2 (5: all accepted)

- **architecture-tech-lead-1:** the symbol-keyed stamp was a hidden precondition, because a clone would drop it.
  - Fix: the duty carries `obligationsDigest` as an ordinary field.
  - `stampAgreement` compares the canonical digest of the plan-derived obligations with it, so the duty is truly plain data.
- **architecture-tech-lead-2 and code-simplifier-1:** `owed` and `check.owed` were parallel fields.
  - Fix: the stamped duty is `{ obligationsDigest, owed }`.
  - `ownerCheckAuthorityOf(duty)` derives the check (null when unstamped) at one point. Every caller uses it.
- **comment-analyzer-1:** ADR-0034 now frames #136 one way: the `OwnerScope` seam and its selections became two duties, and the check is derived.
- **code-simplifier-2:** removed the first-cut narration from ADR-0034.

## Slice b, round 2 (10: all accepted)

- **architecture-tech-lead-1 and code-simplifier-1:** one exported `engineCheckResult(checkId, exitCode)` in `completion-suite.ts`.
  - `ownerCheckResult` and the lint path both build through it.
- **architecture-tech-lead-2:** `pathAliasesOf`, `nearestTsconfig` and `extendedConfig` read through `ReadModule`.
  - They return a typed `AliasConfigError`: `unreadable` with that read's failure, or `unresolvable` with a reason.
  - The runner's side array is gone. Tests cover a refused nearest config and a refused `extends` parent.
- **architecture-tech-lead-3:** the 1000-run property now compares against an independent reference reach in the test, so it can fail. ADR-0035 says so.
- **code-simplifier-2:** the `coverageOverFiles` (bounded) and `reachedFiles` (unbounded) declarations, plus the `CoverageOverFilesFn` doc, now state the bound semantics.
- **comment-analyzer-1, comment-analyzer-2 and code-simplifier-5:** renamed the bound to `COVERAGE_READ_BOUND`.
  - Reworded its detail message and replaced the removed-frontier wording in code, tests, ADR-0035, operations.md, architecture.md and the INV reference.
- **code-simplifier-3:** the `@ts-expect-error` proof is followed by `void empty`, not a tautological assertion.
- **code-simplifier-4:** named the `isOtherInfrastructure` guard.

## Round 2 validation

- Typecheck, full-tier lint (77, baseline) and root `npm run verify`.
- Registered remediation `pr140-r2-remed-7c7be87d`:
  - Run against `pr140-r2-a-7c7be87d` with `defectFamily: not-required`.
  - `supportPaths` name every touched path outside slice a's scope.
