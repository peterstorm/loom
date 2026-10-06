# feat/grammar-constrained-decoding second delta-review remediation

- **Branch:** `feat/grammar-constrained-decoding`, reviewed at `74e9ad76`.
- **Why a delta review:** everything up to `c87af014` was already reviewed and remediated: slices s1–s4 at `96603e4c`, then the first delta review. See `2026-10-05-grammar-partitioned-remediation.md` and `2026-10-05-grammar-delta-remediation.md`.
  - The only unreviewed commit is `74e9ad76`, the first delta's remediation.
  - The loaded runtime (main checkout, `d83084b8`) still lacks this branch's `2cda3379` start guard. A whole-branch review would again produce Context Packets over the 16 MiB lineage and remediation read bound (the two earlier attempts reached 45.8 MB and 47.8 MB).
- **Exact scope:** the 20 paths in `git diff --name-only c87af014..74e9ad76`, with kind `all`.
- **Review Run:** `.claude/reviews/review-and-fix-runs/raf-grammar-20261006-delta-c87af014`, `result.json` sha256 `93392490e267028385c8e236027cc41993ad054bc8231108cde3f4f1684c8b59`.
  - Seven reviewers, all captured on attempt 1, none rejected.
  - Emitted and admitted: 0 critical, 5 advisory.
  - After refutation: 0 surviving critical, 0 refuted critical, 5 advisory. The Refutation Panel was not needed.

## Surviving criticals

None. Remediation uses `defectFamily: {"kind":"not-required"}`.

## Advisory dispositions

Published immutably as policy Run `raf-grammar-20261006-delta-c87af014-policy`, revision `initial`, disposition digest `9844a9f90043bddf2566d4d75008f34c72571d02575a358ce9802ca5a95c6e49`. All are DECLARED.

| ID | Decision | Fix or reason |
| --- | --- | --- |
| `pr-test-analyzer-1` | accepted | Before the fix, `mixedEachTables` read only an inline array-literal argument. It now also reads an identifier through the file's single `const` binding to an array literal, with `as const`, `satisfies` and parentheses unwrapped. The guard's header and fixtures state what stays out of scope: computed tables, imported bindings, `let` bindings, names bound more than once, and tables with spread rows. The repo-wide scan stays green with the wider reading. |
| `comment-analyzer-1` | accepted | The `legacy-panel-decisions.ts` header no longer says "Pure module". It now says the module is pure in behavior but not enrolled, and gives the reason (ADR-0018). It also lists every exported entry point. |
| `architecture-tech-lead-1` | accepted, scoped | Same header rewording. In addition, the new `engine/tests/core/legacy-panel-decisions-purity.test.ts` runs the shipped `no-io-in-pure-modules` rule over this file's own text. Probe rows (`node:fs`, `Date.now()`, `Math.random()`) prove the check fails on an impurity added to the file. Enrolling the module in the closure is declined: `machine-purity.test.ts` audits the transitive closure of every `DEFAULT_PURE_MODULES` entry, which would pull in the emission transport and `legacy-archive`, and ADR-0018 forbids pure modules from importing the emission modules. |
| `architecture-tech-lead-2` | dismissed | `orchestration.ts` already imports core decision modules directly next to program adapters (`core/panel-program` reducers, `core/harness-capture`, `core/orchestration-contract`). A re-export facade in `programs/legacy-panel` would add an indirection the file uses nowhere else, for one consumer. |
| `code-simplifier-1` | dismissed | The reviewer itself concludes that this is not a simplification. Merging the three one-line adapters needs a generic Parsed-constructor parameter, which would change the `plain-record` interface to save three lines. |

## Refuted findings

None.

## Changed files

- `engine/tests/test-table-rows.test.ts` (in scope)
- `engine/src/core/legacy-panel-decisions.ts` (in scope)
- `engine/tests/core/legacy-panel-decisions-purity.test.ts` (support path)
- `.claude/plans/2026-10-06-grammar-delta-2-remediation.md` (support path)

## Validation (development; not P3 evidence)

- `npx vitest run tests/test-table-rows.test.ts` and `bun test tests/test-table-rows.test.ts` (engine): 4/4 pass under each runner.
- `npx vitest run tests/core/legacy-panel-decisions-purity.test.ts` (engine): 4/4 pass.
- `npm run verify` from the repository root: see the session report.
- The registered remediation run (`helper orchestration start remediation`, zero criticals) must audit the candidate and install the verified index before the commit.
