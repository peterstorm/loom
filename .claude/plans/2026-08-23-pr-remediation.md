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

---

# Round 2: post-remediation full-branch review

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 39-path branch delta `30241fd..82ad6cf`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T144824Z-deterministic-policy-rereview`
- Review result digest: `c51db2cfa9ec4763a5278cafcfcf58a0e8415e99a2861fb73648670549627cef`
- Surviving criticals: 2
- Refuted criticals: 2

## Mandatory critical remediation

1. `scripts/smoke-orchestration-facades.ts`: make Wave Gate smoke repositories create and bind a readable model-free Plan so the required `npm test` command exercises the intended review/refutation paths without weakening fail-closed Lifecycle verification.
2. `engine/src/types.ts`: remove the stale exact writer count and include `preserveAcceptedReviewRunFindings` in the documented findings-lockstep writers.

## Advisory dispositions

### Accepted

1. Reject malformed `--issue` values in `populate-task-graph` instead of silently treating them as absent; add focused handler coverage.
2. Correct `update-task-status.ts`'s header to describe proof-driven settlement rather than unconditional `implemented` status.
3. Correct `validate-task-graph.ts`'s repair enumeration to include malformed remediation resolutions.
4. Remove the second unreachable satisfied-result check in `parseSatisfiedProof` by reusing the existing explicit narrowing helper.
5. Distill `mark-tests-passed` around missing evidence arrays rather than mirrored passing/missing collections.
6. Preserve `WaveLifecycleProof`'s both-or-neither type by destructuring only inside the non-null branch.

### Deferred

1. Redesign `Task` as a status/proof discriminated union. Reason: stored graphs and every settlement writer currently use one compatibility schema, while Slice 3 introduces the engine-owned Implementation Attempt settlement reducer. The union must land with that reducer and stored migration so it cannot create a second transient status model during this verification-policy-only slice.

### Dismissed

None.

## Refuted-finding audit

Two reviewers claimed reserved Pi implementation failures remain in `executing_tasks`. The reproduction and security lenses established that production dispatch first runs `finalizeReservedImplementations`, which clears the reservation directly or through `applyUntrustedStopResolution`; `applyFailedPiResult` handles only unreserved compatibility results afterward. No Pi lifecycle change is authorized by this review.

## Support paths outside frozen review scope

- `scripts/smoke-orchestration-facades.ts`

## Validation

1. Reproduce and then pass `env -u PI_CODING_AGENT bun scripts/smoke-orchestration-facades.ts`.
2. Focused Vitest suites for populate argument parsing, Proof parsing, Wave readiness, and mark-tests-passed.
3. `npm run typecheck` including unused-code checks.
4. Full-tier Loom lint over every changed production TypeScript file.
5. `git diff --check`.
6. Required full command: `env -u PI_CODING_AGENT npm test`.
7. Registered remediation audit/install through the Orchestration Façade, then commit and push.
