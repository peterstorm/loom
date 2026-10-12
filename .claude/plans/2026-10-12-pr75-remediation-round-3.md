# PR #75 remediation, round 3: amend a v2 Requirement trace in place

- **Branch:** `feat/amend-spec-trace` (PR #75)
- **Scope:** `all`, 23 frozen files at `abafa384`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr75-review-r3-20261012T114310Z`. All seven reviewers were admitted on their first attempt.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr75-policy-r3-20261012T120000Z`, revision `initial`, with disposition digest `3135e51015181e982c32b530811bfa3ccafa43f1637b2cb9c588b77aac62ec12`

## Adjudication

- Emitted and admitted: 0 critical, 7 advisory. The code-reviewer, silent-failure-hunter, pr-test-analyzer and type-design-analyzer returned no findings.
- After refutation: 0 surviving critical, 0 refuted critical, 7 advisory.
- `defectFamily` is `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| comment-analyzer-1 | accepted | The `retireWaveReviewAuthority` comment now says a forgotten reset field fails nothing, and that such a field needs both a clause and a test row. `docs/operations.md` now separates the tombstone path, which matches a successor install, from the gate-less path, which runs only when residue remains. It also names the chaining check. |
| architecture-tech-lead-1 | dismissed | Every sibling locked helper aborts `updateAndReturn` by throwing and renders one error message. No caller consumes the refusal kind, and the core is tested by kind directly. |
| architecture-tech-lead-2 | dismissed | `resetWaveGateReviewAuthority` is shared with restart and orphan recovery, and it clears `spec_check` for any Wave. A predicate derived from it cannot express the current-Wave scope. The round-2 shape stands, and its comment now states its limit honestly. |
| architecture-tech-lead-3 | accepted | The audit-to-trace rule is now a pure `amendmentHistoryError` in `core/spec-trace.ts`. The State File parser calls it, and the core property test asserts it on every accepted amendment. |
| code-simplifier-1 | accepted | The wire parser is renamed `parseOwnershipRecord`. A named `TraceFields` shape replaces the inline type literal cast. |
| code-simplifier-2 | accepted | `amendedAnchorHashes` decides retained versus added once, from `before.spec_anchors`. The unreachable unavailable-index fallback is documented. |
| code-simplifier-3 | accepted | The replay test keeps the identity assertion behind a narrowing guard. |

## Validation

- `npm run typecheck`, plus the amendment, registration and migration suites
- full `npm run verify`
- CI green on both runners

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan.
