# PR #261 remediation: contract writer may hold frozen bytes (ADR-0104)

- **Branch:** `fix/refreeze-unchanged-contract-files`.
- **Scope:** the PR's 25-file frozen diff against origin/main 41d1fea2.
- **Review run:** `.claude/reviews/review-and-fix-runs/pr261-review-1`. Result digest `31ae51a0…e4ac`.
  - 0 critical and 14 advisory findings.
  - 0 surviving critical and 0 refuted critical.
- **Disposition publication:** `.claude/reviews/review-and-fix-runs/pr261-policy-1` (digest `076d11dc…390e`).

## Surviving critical Findings

None. Defect family: `not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason |
|---|---|---|
| silent-failure-hunter-1 | dismissed | ADR-0104 by design: the obligation kind stays the same for exact obligation matching, the `held-for-freeze` basis records the hold, and the Acceptance Freeze judges the bytes. |
| pr-test-analyzer-1 | accepted | Add a settlement test: an unreadable frozen path blocks as infrastructure and consumes no attempt. |
| pr-test-analyzer-2 | accepted | Add `reconcileImplementationProof` tests: a held path settles satisfied; an unreadable path is refused with the State File unchanged. |
| type-design-analyzer-1 | dismissed | Contract ids and paths are plain strings engine-wide. Branding them is out of scope. |
| type-design-analyzer-2 | dismissed | Same trust model as conformance. After the bundling, one shell observer produces the value. |
| type-design-analyzer-3 | dismissed | Resolved by code-simplifier-2. The legacy wire form must stay byte-identical. |
| comment-analyzer-1 | accepted | Reword the comments: the observer yields the empty value. |
| comment-analyzer-2 | accepted | Date the T1 statement in the ADR and drop the retry-budget clause. |
| architecture-tech-lead-1 | accepted | One `observeContractTask` shell: the root is resolved once and each leaf read once. |
| architecture-tech-lead-2 | accepted | One core value, `ContractTaskObservation { conformance, heldForFreeze }`. |
| code-simplifier-1 | accepted | Hoist one `observed` and one `resultFor` test helper. |
| code-simplifier-2 | accepted | One evidence arm with an optional `basis`. |
| code-simplifier-3 | accepted | A private `parseArrayOf`; error text byte-identical. |
| code-simplifier-4 | accepted | Same deepening as architecture-tech-lead-1/2. |

## Accepted fixes applied

- **Bundled observation:**
  - New `engine/src/orchestration/contract-task-observation.ts` (`observeContractTask`).
  - `freeze-hold-observation.ts` and its test are deleted.
  - `contract-conformance-observation.ts` exports its shared pieces.
  - `ObservedProofFacts`, `IncomingImplementationEvidence` and `reconcileTaskFromStoredEvidence` each take one required `contractTask`.
- **Evidence arm** folded into one; **`parseArrayOf`** extracted; **test helpers** hoisted.
- **Docs:**
  - ADR-0104 Context dated and Decision updated.
  - ADR-0104 records that it amends ADR-0052.
  - ADR-0052 Status gains an amendment paragraph, and the removed `contractConformance` field name is now plain prose.
  - The ADR index rows are updated.
- **Tests:**
  - Settlement infrastructure block for an unreadable frozen path.
  - Reconcile over a skeleton repo: a stored failed Proof with `declared-artifact-not-changed` becomes satisfied as `held-for-freeze`; an unreadable path is refused with the State File unchanged.
  - Unit tests for the bundled observer.

## Support paths outside the reviewed scope

- `.claude/plans/2026-11-26-pr261-remediation.md`
- `engine/src/orchestration/contract-task-observation.ts`
- `engine/tests/orchestration/contract-task-observation.test.ts`
- `engine/src/orchestration/contract-conformance-observation.ts`
- `engine/tests/handlers/helpers/conformance-observation-failure.test.ts`
- `docs/adr/ADR-0052-completion-refusals-ride-declared-artifact-changed.md`

## Validation commands

From `engine/`: `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:smoke`.

Known pre-existing failures: 2 in `tests/handlers/post-tool-use/surface-stop-check-notes.test.ts`. They also fail on a clean origin/main checkout on this machine.
