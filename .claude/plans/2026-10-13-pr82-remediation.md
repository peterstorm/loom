# PR #82 remediation — G5a invariant ownership

**Branch:** `feat/g5a-invariant-ownership`
**Scope:** the 25-file frozen PR diff (`kind: all`, `files: null`)
**Review run:** `.claude/reviews/review-and-fix-runs/run.pr82-review-1` (result digest `cc6b027d…f1378`)
**Advisory policy:** `run.pr82-policy-1`, initial revision, disposition digest `123b61d1…438ed`

## Adjudication

The inspection renderer reports:
- **Emitted and admitted:** 0 critical, 12 advisory.
- **After refutation:** 0 surviving critical, 0 refuted critical, 12 advisory.
- **Defect family:** `not-required`, because there are no surviving criticals.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason / fix |
|---|---|---|
| code-reviewer-1 | accepted | `fieldValue` used `\s*`, so an empty label captured the next line. It now uses `[ \t]*(.*)` and never crosses the line break. |
| type-design-analyzer-1 | accepted | Same root cause as code-reviewer-1; fixed by the same change. |
| type-design-analyzer-2 | accepted | The `malformed` problems are now `NonEmpty<OwnershipProblem>`. A missing owner is reported together with a malformed sibling line. |
| comment-analyzer-1 | accepted | The `types.ts` comment now states the real re-export surface, and notes that the `parsers` barrel no longer exposes the grammar. |
| code-simplifier-1 | accepted | `core/parse-plan-models.ts` re-exports only `PlanInvariant`, `PlanModels` and `Stray`. |
| architecture-tech-lead-1 | accepted | `invariantRoles` and `changesFamily` in `core/plan-paths.ts` are now the single role classifier, used by both the validator and the brief. |
| code-simplifier-2 | accepted | `ownershipErrors` composes four named checks: `unresolvedPathErrors`, `duplicateRoleErrors`, `matrixTestErrors` and `ownerFirstErrors`. Error order is unchanged. |
| code-simplifier-3 | accepted | An `invariant(overrides)` factory replaces the repeated literals, and `ownedInvariant` is renamed to `modelsWithOwnership`. |
| pr-test-analyzer-1 | accepted | Added "from plan text to verdict" seam tests covering accept, reject and empty-owner cases. |
| pr-test-analyzer-2 | accepted | Added an `it.each` that asserts every `OwnershipProblem` message. |
| pr-test-analyzer-3 | accepted | Pinned the sibling grammar edges. A blank line before the first item is now allowed. CRLF, hyphen, en-dash, em-dash and hyphen-in-path cases are covered. A `- none` item and a path containing a space are refused. |
| architecture-tech-lead-2 | dismissed | Refusing the brief when the recorded plan is unreadable is intended fail-closed behavior, and it is tested. The per-brief read has no measured cost, and caching it would add a staleness seam. |

## Historical RED (DECLARED)

Against the committed parser (`ccffe495`), 7 of the new parser tests fail:
- the empty-label captures for owner, matrix test and Tier;
- the missing-owner plus malformed-sibling collection;
- the blank line before sibling items;
- the `- none` item.

All 7 pass after the fix.

## Files

**Changed in scope:**
- `engine/src/core/parse-plan-models.ts`
- `engine/src/core/plan-paths.ts`
- `engine/src/core/implementation-brief.ts`
- `engine/src/handlers/helpers/validate-model-bindings.ts`
- `engine/src/types.ts`
- `engine/tests/core/parse-plan-models.test.ts`
- `engine/tests/handlers/validate-model-bindings.test.ts`

**Support paths** (outside the frozen scope):
- `engine/tests/core/plan-paths.test.ts`
- `.claude/plans/2026-10-13-pr82-remediation.md`

## Validation

- `npx tsc --noEmit -p .` is clean.
- `npm run verify` (in `engine/`) is green: 487 files, 12,320 passed, 1 skipped.
