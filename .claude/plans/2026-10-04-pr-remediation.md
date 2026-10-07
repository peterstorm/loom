# PR remediation — feat/grammar-constrained-decoding (2026-10-04)

## Source review
- Branch: `feat/grammar-constrained-decoding`
- Review Run: `.claude/reviews/review-and-fix-runs/raf-grammar-20261004T1` (standalone-review, Reviewer Protocol v2)
- Result digest: `9aa3fa0012c383807c2d8e9fea09e6f68b5360e9ad8fa9ab6f3b01f51f978683`
- Scope: the engine-frozen 104 paths (branch-committed union against `main`)
- Roster: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
  comment-analyzer, architecture-tech-lead (deepen), code-simplifier (distill) — 7/7 captured
- Emitted/admitted: 0 critical; 3 advisory. After refutation: 0 surviving, 0 refuted critical.

## Surviving criticals
None. `defectFamily: not-required`.

## Advisory dispositions (DECLARED)
Published as standalone-disposition Run `raf-grammar-policy-20261004T1` (revision: initial).

| Finding | Decision | Reason |
| --- | --- | --- |
| type-design-analyzer-1 | accepted | `CellOutcome.guardrails` repeated each outcome's id under a `GuardrailId` key, aligned only by `outcome()`. `GuardrailOutcome` is now parameterised by its id and the record is a mapped `GuardrailRecord`, so a key/id mismatch is unrepresentable. Passed-cell evidence reuses the measured record behind an `allPassing` guard instead of a cast `Object.fromEntries`. |
| architecture-tech-lead-1 | accepted | `artifact-baseline.ts` re-exported `artifactCovers`/`scopeCovers` from `path-coverage.ts`. Callers and tests now import from `path-coverage.ts` and the pass-through re-export is deleted. |
| architecture-tech-lead-2 | dismissed | Consumers use ~30 `pilot-core.ts` entry points, each its own subset; the other exports are component types of those signatures. A file split moves code without narrowing any caller's interface. |

## Accepted advisory fixes (files)
- `calibration/grammar-constrained-decoding/pilot-core.ts`
- `engine/src/core/artifact-baseline.ts`, `engine/src/core/findings.ts`, `engine/src/core/review-output.ts`,
  `engine/src/core/reviewed-workspace.ts`, `engine/src/core/validate-task-execution.ts`,
  `engine/src/core/implementation-application.ts`, `engine/src/handlers/helpers/reconcile-implementation-proof.ts`
- `engine/tests/core/artifact-baseline.test.ts`, `engine/tests/core/review-scope.test.ts`

## Refuted findings
None.

## Validation
- `bun engine/scripts/typecheck.ts` (exit 0)
- Targeted: `vitest run tests/core/artifact-baseline.test.ts tests/core/review-scope.test.ts ../calibration/grammar-constrained-decoding`
- Full: `npm run verify` (typecheck, entire Vitest suite, all six smokes)
