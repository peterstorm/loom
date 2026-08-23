# PR Remediation: deterministic verification policy

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 32-path scope frozen by the Standalone Review Run
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T133952Z-deterministic-policy`
- Review result digest: `a2c3e326cd3f3166094b5d8c51edb25ad547ec5a96f8dbff1d3398ba532c7b69`
- Surviving criticals: 5
- Refuted criticals: 0

## Mandatory critical remediation

1. `engine/src/core/wave-gate-machine.ts`: make absent plan-model authority fail closed at the Wave Gate. Remove the implicit legacy pass; a missing plan is not evidence that no Lifecycle Machine was declared.
2. `pi/subagent-result.ts`: require the `messages` member at the Pi result parser boundary and remove downstream nullish-to-empty transcript coercions so missing/null evidence cannot become a valid empty transcript.
3. `pi/subagent-result.ts` tests: pin malformed-result positional preservation directly and through reservation-aware Pi extension coverage.
4. `pi/subagent-result.ts`: correct trusted-verdict documentation to state the byte-change/revalidation exceptions.
5. `engine/src/handlers/helpers/validate-task-graph.ts`: require authored decompose payloads to include explicit `file_list`; `[]` remains the explicit no-declared-artifact representation.

## Advisory dispositions

### Accepted

1. Report non-Git new-test evidence collection failure to the operator while retaining fail-closed unsatisfied evidence.
2. Add asymmetric Verification Policy tests for `reconcileTaskFromStoredEvidence`.
3. Add asymmetric Verification Policy tests for `mark-tests-passed`.
4. Correct the stale revalidation comment in `update-task-status.ts`.
5. Correct the coupled-test comment in `proof-obligations.ts`.
6. Correct the state/decompose scope comment in `validate-task-graph.ts`.
7. Remove unreachable fallback/coercion expressions from `parseTaskTestResult` after successful parsing.
8. Replace the repeated impossible satisfied-result filtering with one explicit narrowing helper.

### Deferred

1. Extract the engine-owned Implementation Completion Oracle. Reason: the accepted architecture explicitly lands attempt authority and settlement together in Slice 3. Pulling only settlement into this remediation would create test-only authority and violate the staged plan.

### Dismissed

None.

## Refuted-finding audit

The canonical panel refuted no critical findings. One intent lens disputed missing-plan failure because a legacy test pinned the skip, but the finding survived reproduction and blast-radius lenses. This remediation follows the surviving fail-closed verdict and updates that legacy test.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-23-pr-remediation.md`
- `engine/tests/handlers/check-lifecycle-artifacts.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `engine/tests/handlers/helpers/reconcile-implementation-proof.test.ts`
- `engine/tests/handlers/helpers/mark-tests-passed.test.ts`
- `engine/tests/handlers/complete-wave-gate.test.ts`
- `engine/tests/handlers/helpers/orchestration.test.ts`
- `artifacts/tests/integration-hooks.sh`

## Validation

1. Focused Vitest suites for lifecycle artifacts, TaskGraph validation/population, Pi result parsing/extension reservation binding, proof obligations, reconciliation, mark-tests-passed, and Claude/Pi settlement.
2. `npm run typecheck`
3. Full-tier Loom lint over every changed production TypeScript file.
4. `git diff --check`
5. Full Vitest suite with a bounded worker pool: `env -u PI_CODING_AGENT npx vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=15000`
6. Registered remediation audit/install through the Orchestration Façade.
