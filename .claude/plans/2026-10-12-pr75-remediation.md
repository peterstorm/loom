# PR #75 remediation: amend a v2 Requirement trace in place

- **Branch:** `feat/amend-spec-trace` (PR #75)
- **Scope:** `all`, 18 frozen files at `51f61f3a`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr75-review-r1b-20261012T105105Z`
- **Superseded run:** `pr75-review-20261012T104440Z`, which ended terminal-blocked because the type-design-analyzer's second attempt did not conform to the issued v2 schema. It was abandoned with `--superseded-by pr75-review-r1b-20261012T105105Z`; none of its findings are used.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr75-policy-20261012T110000Z`, revision `initial`, with disposition digest `48333e2b5369fecd4458bd2fd4f4f1659853019fee229550fbea586190228567`

## Adjudication

- Emitted and admitted: 0 critical, 10 advisory. The code-reviewer returned no findings.
- After refutation: 0 surviving critical, 0 refuted critical, 10 advisory.
- `defectFamily` is `{"kind":"not-required"}`: there are no repair groups, siblings, checks or Historical RED declarations.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| silent-failure-hunter-1 | accepted | `amendSpecTrace` refuses a Task array that repeats an id as `invalid-input`, before the set comparison could read it as an unchanged replay. `upgrade-spec-trace` is unchanged. |
| pr-test-analyzer-1 | accepted | The unavailable-index test now also adds a Contribution only, and expects `spec-index-unavailable`. |
| pr-test-analyzer-2 | accepted | Two new helper tests. The first: a subagent appearing between the pre-lock check and the in-lock re-check is refused without writing; a delegating `vi.mock` of the ledger makes that window reachable. The second: a live successor gate is refused through StateManager with the abandon guidance, and the file is unchanged. |
| type-design-analyzer-1 | dismissed | `kind` is already a closed union. The `{kind, message}` refusal record matches the sibling trace commands, and no caller consumes typed detail. |
| comment-analyzer-1 | accepted | The plan's Preconditions now list the implemented order and mark the refusals added during implementation. The stale bullets are corrected: the hash-key load check, the property wording and the docs section title. |
| architecture-tech-lead-1 | accepted | `retireWaveReviewResidue(graph, wave)` in `wave-gate-registration.ts` owns both the residue predicate and the reset. The amendment calls it when there is no tombstone. |
| architecture-tech-lead-2 | accepted | One `parseTraceOwnership` beside `sameRequirementTrace` in `core/spec-trace.ts`. The helper-input parser and the wire parser both build through it, and both keep their messages. |
| code-simplifier-1 | accepted | Same fix as architecture-tech-lead-2. |
| code-simplifier-2 | accepted | The amendment specification text moved to `tests/fixtures/amendment-spec.ts`, and both suites import it. |
| code-simplifier-3 | accepted | `changesOf` carries each changed Task with its change, so `completedWaveRefusal` and the candidate build need no second lookup or non-null assertion. The audit shape is unchanged. |

## Validation

- `npm run typecheck`, plus the amendment, migration and registration suites
- full `npm run verify`

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan and the new `engine/tests/fixtures/amendment-spec.ts`.
