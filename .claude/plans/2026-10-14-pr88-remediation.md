# PR #88 remediation (round 1)

- **Branch:** `fix/g1-pilot-followups`, reviewed at `47760ece`
- **Scope:** `all`, the full branch diff against `main` (44 files)
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261014T130106Z-47760ece`
  - result digest `756e292214f5ff8dac4caad5f94d69e62e414807f76e5465ad6ef7669f20ea57`
- **Counts (engine inspection):** 0 critical and 12 advisories emitted and admitted; after refutation, 0 surviving criticals, 0 refuted, 12 advisories.

## Criticals

None survived; none were refuted. `defectFamily: {"kind":"not-required"}`.

## Advisory policy (published)

- **Policy run:** `.claude/reviews/review-and-fix-runs/policy-20261014T1315Z-pr88`
- **Revision:** initial
- **Disposition digest:** `90a4d9beb2d35b5e412c4f7407040f5efa952533083ef83cbf27e076a749468a`
- **Provenance:** DECLARED

All 12 advisories were accepted.

| ID | Fix |
| --- | --- |
| pr-test-analyzer-1 | `spawn-vetoes.test.ts` now sends the real default export a spawn the phase-order veto refuses, and checks the State File is unchanged. |
| pr-test-analyzer-2 | `acceptance-contract-entry-point.test.ts` runs a plan on disk, with an `**Entry point:**`, through the real `validate-task-graph` handler. |
| type-design-analyzer-1 | A test asserts that the persisted Acceptance Contract never carries `entryPoint`. |
| comment-analyzer-1 | The CONTEXT.md Tier entry and its invariant now name the immediate-tier programmatic rules. |
| comment-analyzer-2 | Corrected the `commands/loom.md` hooks table, the `scripts/lint-project.ts` usage line and the `index.test.ts` test title. |
| architecture-tech-lead-1 | The contract Task is excluded from the entry-point writer set. The two new tests are the stub-only claimant and the contract-Task-only entry point. Docs updated in CONTEXT.md, executable-models.md and the decompose template. |
| architecture-tech-lead-2 | A test asserts that `SPAWN_VETOES` equals the `hooks.json` spawn-matcher scripts other than `validate-task-execution`, in wiring order. |
| code-simplifier-1 | Deleted the leftover `loadRules` overload. |
| code-simplifier-2 | `canonicalSpecBeside` now lives in `tests/fixtures/spec-index-fixture.ts`; its three copies are reused from there. |
| code-simplifier-3 | Added one `SpawnVetoEntry` type, used in all three places. |
| code-simplifier-4 | The `no-spec-file`-only invariant is stated at the second unavailable arm. Message texts are unchanged. |
| code-simplifier-5 | The two `lintFile` cases are now one `it.each` over a `lintCoreFile` helper. |

## Support paths outside the review scope

- `.claude/plans/2026-10-14-pr88-remediation.md`
- `scripts/lint-project.ts`
- `engine/tests/linter/index.test.ts`

## Validation

`npm run verify`, run from the repository root.
