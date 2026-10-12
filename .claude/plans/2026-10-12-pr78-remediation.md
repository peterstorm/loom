# PR #78 remediation

- **Branch:** `feat/11-structural-spec-check`
- **Scope:** the 20 files of PR #78 (the frozen diff of review run `pr78-review-1`)
- **Review run:** `.claude/reviews/review-and-fix-runs/pr78-review-1`, result digest `7ef8a0d3598454aceb0b7a669d4ff2c33ca5a4396aea36564a77e5380169fdca`
- **Result:** 0 critical emitted or admitted; 0 surviving and 0 refuted critical; 7 advisory. silent-failure-hunter and architecture-tech-lead attempt 1 were refused for incomplete read coverage and admitted on attempt 2.

## Critical findings

None survive and none were refuted, so there are no Declared Repair Groups, and `defectFamily` is `not-required`.

## Advisory dispositions (DECLARED)

Published in `pr78-policy-1` (initial, digest `b95188d5…`) and corrected in `pr78-policy-2` (correction, digest `f942ab4a…`). The correction changes only type-design-analyzer-1, from accepted to dismissed.

| Finding | Decision | Reason |
|---|---|---|
| silent-failure-hunter-1 | dismissed | On the registered path, completion already proves that the spec bytes equal the epoch's documents. A skip happens only with no epoch documents or no Spec Index, and the plan documents both cases. |
| type-design-analyzer-1 | dismissed (corrected) | Unreachable. A Task that claims anything without a Spec Index is refused (`requirement-text-unavailable`) before `scenarioTestNames` runs. The doc comment now states this invariant. |
| type-design-analyzer-2 | dismissed | `inCurrentWave` together with `completed` is a legal state: current-Wave Tasks complete before their gate. |
| comment-analyzer-1 | accepted | The preamble now names a text change, a withdrawal and an altered hash. |
| comment-analyzer-2 | accepted | The plan's status table is relabelled as the state before this change. |
| architecture-tech-lead-1 | accepted | `completedDriftOf` now goes through `driftOf`, the only place hash equality is decided. An unreadable recorded hash on a completed claim is reported as `unreadable-record` (corrupt authority), not dropped. |
| code-simplifier-1 | accepted | A single `every` over the verified hashes decides whether anything changed, and the hashes are merged only on change. |

## Changes

- `engine/src/core/requirement-coverage.ts`:
  - `CompletedClaimDrift` gains an `unreadable-record` arm.
  - `completedDriftOf` delegates to `driftOf`.
  - The renderer uses an exhaustive `match`, with a reworded preamble.
- `engine/src/core/verified-claim-hashes.ts`: simplified the same-hashes check.
- `engine/src/core/implementation-brief.ts`: the doc comment states the null-index invariant.
- Tests:
  - `requirement-coverage.test.ts` adds an unreadable-record report (with injection) and a preamble test.
  - `requirement-coverage.property.test.ts` adds an exact-kind oracle and a test that every drift kind is reachable.
- Docs: the `CONTEXT.md` and `commands/spec-check.md` drift sentences, and this plan's table heading.

## Validation

- `tsc --noEmit` is clean.
- The 7 covering test files pass (139 tests).
- Full `npm run verify` is run before registered remediation.

## Registered remediation

The zero-critical source run uses `defectFamily: not-required`. Its support path is this plan file.
