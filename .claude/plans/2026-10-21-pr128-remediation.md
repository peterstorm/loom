# PR 128 remediation: contract-writer I6 exemption

Source review `pr128-review-20261021222700` against `bcd6d847`: 0 critical, 7 advisory (the same after refutation; with no critical the Refutation Panel did not run). Policy `pr128-policy-20261021223800` (digest `67023559`). Remediation `pr128-remediation-20261021230000`, defect family `not-required`, verified index `94b089c4`. Fix commit `664156d0`.

| Finding | Decision | Change |
|---|---|---|
| pr-test-analyzer-1 | accepted | New test: a graph with an Acceptance Contract gives every Task a frozen Proof, the premise ADR-0026's amendment relies on. |
| type-design-analyzer-1 | accepted | The scope maps each contract writer to its contract id; `writtenContract` is its one reader, used by both `taskRedThenGreenEra` and the status reason, so they cannot disagree. |
| architecture-tech-lead-1 | accepted | Same change, plus a test that status shows `contract-writer` for exactly the Tasks the exemption covers. |
| code-simplifier-1 | accepted | Same change. |
| comment-analyzer-1 | accepted | `docs/operations.md`: "A Task that owes I6" replaces the ambiguous "Such a Task". |
| code-simplifier-2 | accepted | The two red-then-green Proof helpers become one pure shared fixture, `engine/tests/fixtures/red-then-green-proof.ts`. |
| architecture-tech-lead-2 | dismissed | The loader and the operator validator already share the parsers and the scope builder; they differ only on malformed input, by design, documented and tested. A shared wrapper would parse twice in the loader or remove the validator's deliberate fallback. |

## Follow-up commit

- `.claude/linter/rules/inv-6-one-red-then-green-era-test.json` and its byte-identical `.pi` copy: the description now says population, the State File obligation-match check and the operator validator ask per Task through `taskRedThenGreenEra`, which exempts Acceptance Contract writers. The pattern is unchanged; both directories pass `helper validate-lint-rules`.
- This plan file (the review session could not write under `.claude/`).

## Validation

- Root `npm run verify`: 557 files, 13,625 passed, 1 skipped; all six smokes pass.
- CI green on Ubuntu and macOS for `664156d0`.
