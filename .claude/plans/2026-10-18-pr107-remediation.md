# PR #107 remediation: CT-2 names its one value re-export

- **Branch:** `refactor/leaf-contract-types` (base `main`)
- **Scope:** the review's frozen diff was the PR's 7 files at `refactor/leaf-contract-types` HEAD (`kind: all`).
  This remediation edits one of them and adds this plan.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261018-pr107`
  (`result.json` digest `f6858ab8ee350bcd4b491e9d8e4ed389eb3a2055f1ffdbb8179ac3e0bcf76df8`)
- **Counts (inspection renderer):** 0 critical and 1 advisory emitted and admitted. After refutation:
  0 critical surviving, 0 refuted, 1 advisory.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261018-pr107`,
  revision `initial`, disposition digest `8f927953e6a330fe4846c0d9c4841f32e64c3a35d4aba2ac0eda0ede0ca1f893`
  (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| architecture-tech-lead-1 | accepted | CT-2's types file had only type-only imports before this PR and now carries one runtime value re-export (`MAX_AFFECTED_RUNNER_TIMEOUT_MS` from `verification-manifest.ts`). The back-edge risk the reviewer names is already mechanically guarded: `orchestration-contract-acyclic.test.ts` refuses module cycles across runtime and type-only edges. CT-2's own acceptance tests import the cap from the contract surface, so removing the re-export would shrink the contract. The complete fix is the reviewer's second option: the header names the one deliberate value re-export and the guard. |

## Accepted fix

`engine/src/core/affected-stop-check-types.ts`: the header's "Types and fixed constants only" paragraph states that
every import is type-only except the one value re-export of the cap from its owner, and that the acyclicity test
refuses any import back from `verification-manifest.ts`.

## Support paths (outside the frozen scope)

- this plan

## Validation

- `tsc --noEmit --noUnusedLocals --noUnusedParameters`: nothing in `src/` or `tests/`
- `orchestration-contract-acyclic` and the CT-2 acceptance suites
- `npm run verify` (root)
