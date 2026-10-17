# PR #101 remediation — stop-check ports review

- **Branch:** `refactor/stop-check-ports`
- **Scope:** the PR's 16 changed files (frozen diff, `kind: all`)
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261017T122150Z-ef01dfbc`
  (result digest `a9f9a32781fc699c3fbe0c74d1c3efe9f60d51353070485ecddbe74a0e19693c`)
- **Counts (inspection renderer):** emitted/admitted 0 critical, 5 advisory; after refutation 0 surviving
  critical, 0 refuted critical, 5 advisory.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261017-pr101`,
  revision `initial`, disposition digest `c08fe4a54edb88de2b65d721e0fa8d6d075797d3de9e8ffbf9575a1e7e5144e0`
  (provenance DECLARED).

## Surviving criticals

None. Defect-family accounting: `{"kind":"not-required"}`. No Declared Repair Group, no selected check,
no Historical RED declaration.

## Refuted criticals

None.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| type-design-analyzer-1 | accepted | `STOP_CHECK_NAMES` drives record/clear; derive `StopCheckName` from the frozen tuple so list and union are one source of truth. |
| comment-analyzer-1 | accepted | Five stop-check tests use `UNKEPT_BLOCK_COUNTERS`, not the fake; scope the ADR sentence to tests that count blocks. |
| architecture-tech-lead-1 | accepted | The fake stored 0 on `clear` while the file adapter removes the file; make the fake delete the entry (and read 0 after a clear, preset or not), and restore the stricter `.has(key) === false` assertions. |
| architecture-tech-lead-2 | dismissed | The throwing `record` override in the parity matrix is a test-local tripwire that predates this PR; other tests import the real adapter rather than re-inlining it. |
| code-simplifier-1 | accepted | Same root as type-design-analyzer-1. |

## Accepted fixes

- `engine/src/core/affected-stop-check-types.ts`: `STOP_CHECK_NAMES = Object.freeze([...] as const)`;
  `StopCheckName = (typeof STOP_CHECK_NAMES)[number]`.
- `engine/tests/fixtures/stop-check-block-counters.ts`: `clear` deletes the entry and marks the key cleared;
  `issued` reads a recorded count, else 0 for a cleared key, else the preset.
- `engine/tests/handlers/subagent-stop/acceptance-stop-check.test.ts`: four `.has(...) === false` assertions
  restored from main; the shared unreadable counter becomes a per-test factory (a module-level instance now
  carries a `clear` from one test into the next).
- `engine/tests/handlers/stop-checks.test.ts`: clear-on-proceed assertions check absence, with a seeded prior
  count (or, for a preset, `issued` reading 0) so they cannot pass vacuously.
- `docs/adr/ADR-0028-…`: the fake is scoped to tests that count blocks; cleared counters are absent in both
  adapters.

## Validation

- `npx tsc --noEmit -p engine`
- the 20 stop-check test files (400 tests)
- `npm run verify` (root)
