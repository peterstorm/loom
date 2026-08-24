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

---

# Round 3: post-remediation full-branch review

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 40-path branch delta `30241fd..2cca1ee`
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T171548Z-deterministic-policy-rereview-3`
- Review result digest: `fa76499d8ffa66f9dd9b1136664209ea919487e68d1a2859d8a3c44224368fd2`
- Surviving criticals: 1
- Refuted criticals: 0

## Mandatory critical remediation

1. `engine/src/handlers/helpers/reconcile-implementation-proof.ts`: distinguish `PostCommitStateProtectionError` from pre-commit failures so a durably committed graph is never reported as unchanged; add focused diagnostic coverage.

## Advisory dispositions

### Accepted

1. Remove `populate-task-graph`'s `existsSync` precheck, use `StateManager.fromPath`, and report present-but-unreadable graph failures contextually.
2. Make `validate-task-graph` distinguish missing input from other read failures and preserve the filesystem cause.
3. Replace `collectDiff`'s boolean untracked-file presence port with a result-returning inspection so access failures become explicit authority-unavailable errors.
4. Correct `commands/loom.md`: `mark-tests-passed` reads persisted TaskGraph evidence, not the evidence ledger directly.
5. Remove unreachable pending/evaluated Proof parser fallback mappings through explicit state narrowing.
6. Extract repeated standalone/Wave repository setup in the orchestration façade smoke without changing scenarios or assertions.

### Deferred

1. Require implemented/completed stored Tasks to carry satisfied Proof authority. Reason: validation demonstrated 88 failures across 11 legacy-compatible fixture suites; the invariant must land with the Slice 3 Task status/proof ADT and explicit stored-graph migration, not as a partial parser-only break.
2. Consolidate Claude/Pi implementation settlement behind `settleImplementationAttempt`. Reason: this is the explicitly planned Slice 3 completion-oracle work and must land with protected Task-attempt authority.
3. Split `wave-gate-machine.ts` into lifecycle/readiness/review/refutation/status modules. Reason: this broad public-interface refactor is independent of Verification Policy correctness and should follow the completion-suite slices with its own architecture checkpoint.
4. Extract the TaskGraph codec/invariants from filesystem-backed `StateManager`. Reason: this cross-module seam migration is valid but independent, and requires a dedicated dependency-boundary change rather than review-remediation churn.

### Dismissed

None.

## Refuted-finding audit

The panel refuted no critical findings. Reproduction, intent, and blast-radius lenses unanimously upheld the post-commit diagnostic contradiction.

## Support paths outside frozen review scope

- `engine/tests/handlers/collect-diff.test.ts`

## Validation

1. Focused Vitest suites for reconciliation diagnostics, TaskGraph proof lockstep, populate/validate I/O diagnostics, Diff authority, and Proof parsing.
2. `env -u PI_CODING_AGENT bun scripts/smoke-orchestration-facades.ts`.
3. `npm run typecheck` including unused-code checks.
4. Full-tier Loom lint over every changed production TypeScript file.
5. `git diff --check`.
6. Required full command: `env -u PI_CODING_AGENT npm test`.
7. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 4: post-remediation full-branch review

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 41-path branch delta `30241fd..97e3d33`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T174724Z-deterministic-policy-rereview-4`
- Review result digest: `530a7c92a0bc268ed7d0869cb12fc8df537201bae49eb5c2395fb4cd4746a1c9`
- Surviving criticals: 7
- Refuted criticals: 0

## Mandatory critical remediation

1. `pi/subagent-result.ts`: make failed implementation settlement defensively release the trusted Task binding even when a reservation is supplied. The production dispatcher already finalizes reserved failures first; the applier remains idempotent and must not overwrite that richer failure settlement.
2. `engine/src/state-manager.ts`: diagnose an absent session TaskGraph pointer before taking the intentional local compatibility fallback; preserve the existing refusal for non-absence read failures.
3. `engine/src/types.ts` and the findings/Wave submission core: represent exact-slot review evidence as a discriminated stored shape carrying `slot_id` and `attempted`; require and match it whenever a Review Run has engine-owned slot authority while preserving an explicit legacy/unbound shape for non-Wave runs.
4. `engine/src/handlers/helpers/validate-task-graph.ts`: narrow the `findingsErrorsOf` comment to the findings aggregate it actually mirrors rather than claiming all `taskUnionError` rules.
5. `engine/src/handlers/helpers/validate-task-graph.ts`: correct the findings-repair ordering documentation to match the implemented container recovery, collision repair, and salvage sequence.
6. `engine/src/handlers/helpers/validate-task-graph.ts`: correct `repairReviewRecord` documentation to say blank/duplicate failure entries clear the inconsistent review record fail-closed.
7. Pi and Claude implementation completion shells: compute attempt-baseline comparison from the current Task inside the locked `StateManager.update` transition so proof and review invalidation cannot consume observations derived from a stale Task snapshot.

## Advisory dispositions

### Accepted

1. Add a focused `messages: null` Pi regression proving malformed transcript evidence fails closed.
2. Install a frozen defensive copy of `executing_tasks` at the TaskGraph parse boundary.
3. Correct `populate-task-graph` documentation to describe `fixFull`'s complete normalization/repair role.
4. Reuse one helper for untrusted transcript fallback evidence in `resolveTestEvidence`.
5. Express Wave completion as `every` over Wave Tasks, preserving vacuous completion while removing the double negative.
6. Consolidate duplicate dropped-refutation/dropped-resolution data-loss note builders.

### Deferred

1. Move shared completion policy out of the Claude SubagentStop module into the Slice 3 engine-owned Implementation Completion Oracle. Reason: that planned interface migration must land atomically with semantic attempt authority and cross-harness settlement rather than creating another transitional seam in review remediation.

### Dismissed

None.

## Refuted-finding audit

The canonical panel refuted no critical finding. Intent lenses disputed the reserved-failure, absent-pointer, exact-slot-evidence, and findings-comment claims, but each reached the two-of-three survival threshold. Remediation therefore applies bounded defensive/type/documentation fixes without weakening the existing production dispatcher settlement, local compatibility fallback, or Wave submission authority checks.

## Support paths outside frozen review scope

- `engine/src/core/findings.ts`
- `engine/src/core/review-output.ts`
- `engine/src/handlers/helpers/programs/wave-gate.ts`
- `engine/tests/core/review-remediation-lifecycle.test.ts`
- `engine/tests/handlers/pi-stop-toctou.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`

## Validation

1. Focused Vitest suites for Pi result settlement/parsing, TaskGraph session resolution/immutability, exact-slot Review Run evidence, Wave submission recovery, findings repair, and Claude/Pi TOCTOU settlement.
2. `npm run typecheck` including unused-code checks.
3. Full-tier Loom lint over every changed production TypeScript file.
4. `git diff --check`.
5. Required full command: `env -u PI_CODING_AGENT npm test`.
6. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 5: post-remediation full-branch review

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 45-path branch delta `30241fd..83fa693`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T183155Z-deterministic-policy-rereview-5`
- Review result digest: `c31deaea2a0457d552f91c87c14f8844150d18402e980d6592f4850d51233152`
- Surviving criticals: 2
- Refuted criticals: 0

## Mandatory critical remediation

1. `pi/subagent-result.ts`: when the locked current Task's attempt baseline cannot be compared, stop accepted-transcript settlement after releasing execution state. Never pass the comparator's fail-closed artifact fallback into a successful completion proof.
2. `pi/subagent-result.ts`: resolve failed unreserved implementation results through the same exactly-one executing Task inference used by successful results. Release the inferred Task; preserve parallel siblings and return an explicit processing error when multiple executing Tasks make attribution ambiguous.

## Advisory dispositions

### Accepted

1. Return a typed structured-findings-block parse result with an exact rejection reason and include it in the operator-facing degraded-evidence note while preserving the compatibility parser.
2. Correct `review-output.ts`'s module contract to name both count markers and describe severity-specific arbitration versus final count reconciliation accurately.
3. Correct `findings.ts`'s resolved-Finding high-water-mark comment and remove the stray brace.
4. Make `parseProofParts` return failure when coverage invariants fail rather than carrying errors inside a successful parse result.
5. Rewrite `taskCompletionWasObserved` in domain order: establish Proof presence/state before inspecting results.
6. Project each Task's Verification Policy once in `mark-tests-passed` and reuse that immutable projection for counts and reporting.

### Deferred

1. Pair Proof Obligations and results in a new TaskProof ADT. Reason: this stored-state schema change belongs with Slice 3's settlement reducer and explicit migration, not a compatibility-preserving review remediation.
2. Redesign Task lifecycle states as a discriminated union. Reason: unchanged from prior rounds; it must land atomically with Slice 3's settlement authority and stored migration.
3. Extract the TaskGraph codec from `StateManager`. Reason: valid architecture work, but it changes a broad parser/I/O seam and requires a dedicated dependency-boundary change.
4. Move cross-harness completion policy into an engine-owned neutral module. Reason: this is the planned Slice 3 Implementation Completion Oracle and must include attempt authority rather than becoming another transitional seam.
5. Split the Wave Gate core public surface. Reason: independent broad architecture work that should follow the completion-suite slices with its own checkpoint.

### Dismissed

1. Add coverage for malformed `review_run.slot_authority` before evidence exists. Reason: `engine/tests/state-manager-load-guards.test.ts` already constructs `evidence: []` and tests empty, non-array, incomplete, out-of-order, extra/missing-field, duplicate-slot, and invalid-attempt authority through the real TaskGraph parser.

## Refuted-finding audit

No critical was refuted. Reproduction, intent, and blast-radius lenses unanimously upheld both Pi settlement findings.

## Support paths outside frozen review scope

- `engine/tests/core/findings.test.ts`
- `engine/tests/core/review-output.test.ts`
- `engine/tests/core/round15.test.ts`

## Validation

1. Focused Vitest suites for failed Pi binding, accepted Pi baseline failure, findings-block diagnostics, Proof parsing, reconciliation, and mark-tests-passed.
2. `npm run typecheck` including unused-code checks.
3. Full-tier Loom lint over every changed production TypeScript file.
4. `git diff --check`.
5. Required full command: `env -u PI_CODING_AGENT npm test`.
6. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 6: post-remediation full-branch review

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 48-path branch delta through `c17699d`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T201451Z-deterministic-policy-rereview-6`
- Review result digest: `482b84ee85db07d8f7d89170ce5af49b7e8df5d85c2fad722291ac56bbe10240`
- Surviving criticals: 3
- Refuted criticals: 0

## Mandatory critical remediation

1. `pi/subagent-result.ts`: when accepted-transcript attempt-baseline comparison fails for a re-executed implemented Task, apply a fail-closed failed resolution that moves the Task back to pending and invalidates stale review/spec/Wave authority rather than only releasing `executing_tasks`.
2. `engine/src/handlers/subagent-stop/update-task-status.ts`: catch new-test evidence collection failures inside the locked settlement, release execution, preserve an explicit revalidation state, invalidate stale changed-byte authority, and return a Task-scoped hook error.
3. `pi/subagent-result.ts`: normalize the same new-test evidence collection failure into a `PiResultOutcome`, release execution through a failed resolution, and report the infrastructure failure through `processingErrors` rather than rejecting the applier promise.

## Advisory dispositions

### Accepted

1. Preserve the `JSON.parse` cause when rejecting a malformed `review_lifecycle` block.
2. Add a Claude SubagentStop regression proving attempt-baseline comparison consumes the locked current Task rather than a stale pre-lock snapshot.
3. Model authored decompose Tasks as a dedicated projection containing only planner-authorized fields rather than the full persisted `Task` type.
4. Correct the findings-module writer documentation to include `preserveAcceptedReviewRunFindings` and the actual seven coordinated writers.
5. Correct the structured-Finding contract comment to include `ADVISORY_COUNT`.
6. Extract one private legacy section-claim parser for Critical and Advisory sections.
7. Extract one private Wave Gate requirement checker shared by regression and new-test evidence checks without changing their public interface or diagnostics.

### Deferred

1. Extract pure protected Wave Gate registration/completion aggregate commands from `StateManager`. Reason: this broad filesystem/domain seam migration is independent of the verification-policy slice and should land in a dedicated architecture change with property coverage.
2. Split `wave-gate-machine.ts` into lifecycle/readiness/review/refutation/completion/status modules. Reason: this changes the Wave Gate Public Surface and remains intentionally sequenced after the completion-suite slices.

### Dismissed

None.

## Refuted-finding audit

No critical was refuted. Reproduction, intent, and security lenses unanimously upheld the stale Pi authority finding and both uncaught new-test evidence infrastructure failures.

## Support paths outside frozen review scope

None. The plan, production files, and regression suites are all inside the frozen 48-path review scope.

## Validation

1. Focused Vitest suites for Claude/Pi implementation settlement, locked-baseline TOCTOU behavior, review lifecycle parsing, authored decompose typing/runtime validation, findings comments/compatibility parsing, and Wave Gate evidence checks.
2. `npm run typecheck` including unused-code checks.
3. Full-tier Loom lint over every changed production TypeScript file.
4. `git diff --check`.
5. Required full command: `env -u PI_CODING_AGENT npm test`.
6. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 7: post-remediation full-branch review

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 48-path branch delta through `232505d`, frozen in the authoritative result
- Superseded Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T214917Z-deterministic-policy-rereview-7` (terminal invalid attempt-2 intent verdict; preserved and abandoned in favor of the retry)
- Authoritative Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260823T220918Z-deterministic-policy-rereview-7-retry`
- Review result digest: `291fdb612eac425f0bdf5621a3089583f7453682df31ac07ac7bb7f9009ea496`
- Surviving criticals: 2
- Refuted criticals: 1

## Mandatory critical remediation

1. `engine/src/handlers/subagent-stop/update-task-status.ts`: settle unsafe modified-path evidence through the shared fail-closed infrastructure transition inside the locked update so a re-executed implemented Task becomes pending/revalidation-required and stale proof/review/spec/Wave authority cannot remain green.
2. `pi/subagent-result.ts`: apply the same locked infrastructure-failure transition for unsafe modified-path evidence and expose the diagnostic through `processingErrors`.

## Advisory dispositions

### Accepted

1. Cache validated current Wave review contexts before packet-membership checks so a `readContext` failure cannot become an absent packet.
2. Replace Lifecycle Machine artifact boolean existence checks with a typed presence observation that distinguishes absence from filesystem failure.
3. Wrap `mark-tests-passed` TaskGraph loading with a helper-scoped diagnostic carrying the graph path and cause.
4. Report required Pi new-test repository unavailability through `processingErrors`, while retaining waiver behavior for Tasks whose policy does not require new tests.
5. Extend the Claude new-test infrastructure-failure regression with already-green Spec-check and Wave authority and assert both are invalidated.
6. Normalize legacy untrusted `test_result` provenance into the parsed Task value returned by `parseTaskGraph`, rather than validating one value and returning a differently shaped raw object.
7. Correct `validateMinimal` documentation to say task fields are ignored.
8. Correct `types.ts` findings ownership documentation to remove the stale two-writer count.
9. Scope the findings repair `dropped` comment to malformed active Finding entries rather than all data-loss paths.
10. Extract one private active-review retirement transition shared by Wave Gate restart and orphan recovery.
11. Extract one private findings/view projection for writers that replace the complete active Finding aggregate.
12. Extract one pure trim/filter/deduplicate path normalization used by Proof Obligation derivation and evaluation.

### Deferred

1. Deepen Pi's repository port into an engine-owned completion-evidence port. Reason: the planned Slice 3 Implementation Completion Oracle moves both harnesses behind one neutral settlement/evidence interface; changing the Pi-only seam now would create another transitional interface and duplicate that architecture work.

### Dismissed

None.

## Refuted-finding audit

The malformed Pi transcript baseline claim was refuted by intent and security. `compareAttemptBaseline` returns `bytesChangedSinceAttempt: true` on every comparison failure, so malformed evidence is routed through stale-authority invalidation. A false value is possible only after a successful comparison proves no attempt bytes changed; preserving historical evidence in that case is intentional.

## Support paths outside frozen review scope

- `engine/src/handlers/helpers/complete-wave-gate.ts`
- `engine/src/handlers/helpers/orchestration.ts`
- `engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts`
- `engine/tests/handlers/reopen-completed-wave.test.ts`

The two production adapters and two compatibility callers must adopt the typed Lifecycle Machine artifact-presence port introduced by accepted advisory 2. The orchestration adapter's existing oversized functions were distilled into named operations so the changed production file passes the mandatory full tier.

## Validation

1. Focused Vitest suites for Claude/Pi unsafe-path settlement, required new-test repository failure, Lifecycle Machine artifact presence, Wave context recovery, TaskGraph test-result normalization, mark-tests-passed diagnostics, findings transitions, and Proof Obligation normalization.
2. `npm run typecheck` including unused-code checks.
3. Full-tier Loom lint over every changed production TypeScript file.
4. `git diff --check`.
5. Required full command: `env -u PI_CODING_AGENT npm test`.
6. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 8: post-remediation full-branch review

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 52-path branch delta `30241fd..976ff00`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260824T050920Z-deterministic-policy-rereview-8`
- Review result digest: `cd2c4810b50168ceea24109f8d02a461103d85d5faf5a5b8308895af7ac7dbb3`
- Surviving criticals: 2
- Refuted criticals: 0

## Mandatory critical remediation

1. `engine/src/handlers/helpers/complete-wave-gate.ts`: follow the declared Lifecycle Machine path when checking presence so a dangling symlink is classified as absent and cannot authorize Wave completion; add a production-handler regression.
2. `engine/src/core/proof-obligations.ts` parser coverage: add explicit same-length obligation/result mismatch and validly-shaped aggregate-evidence mismatch regressions, including the `parseTaskGraph` load boundary.

## Advisory dispositions

### Accepted

1. Preserve TaskGraph read/JSON-parse causes in `/loom status` instead of passing an opaque sentinel that becomes a generic schema error; add a CLI-boundary regression.
2. Clarify `docs/deterministic-implementation.md` as a proposal containing explicitly marked shipped-baseline sections.
3. Guard failed `parsePiMessages` before deriving transcript and structured evidence, so each variable represents one successful concept.
4. Extract one private review-evidence-failure Task transition shared by both `applyReviewResolution` failure branches.
5. Extract one private outstanding-reviewer clearance projection shared by packet-bound evidence and legacy findings merge.

### Deferred

1. Add a deterministic test seam for `populate-task-graph`'s in-lock overwrite recheck. Reason: the recheck is implemented and the pre-lock behavior is covered; exposing a new store/resolver interface solely for this race test belongs with the planned TaskGraph codec/store seam rather than this bounded remediation.
2. Redesign `Task` lifecycle state as a discriminated union. Reason: unchanged from prior rounds; it must land atomically with Slice 3's Completion Oracle and stored-state migration.
3. Brand stored Review Run slot ids with the orchestration `SlotId`. Reason: the current schema root cannot import the orchestration contract without reversing dependencies; move the shared authority type during the planned completion/authority seam migration.
4. Replace process-local Wave Gate WeakSet proof registries with explicit proof values. Reason: this changes the Wave Gate authority interface and belongs in Slice 2's quiescent engine-owned Wave completion suite architecture checkpoint.
5. Split `wave-gate-machine.ts` into lifecycle/readiness/review/refutation/status modules. Reason: this Public Surface decomposition remains planned after the completion-suite slices and is not a bounded verification-policy remediation.

### Dismissed

None.

## Refuted-finding audit

No critical was refuted. The dangling-symlink finding was unanimously upheld. The proof-parser coverage finding survived intent and blast-radius despite the reproduction lens noting adjacent existing coverage; remediation adds the two exact adversarial cases named by the surviving majority rather than changing the already fail-closed parser.

## Support paths outside frozen review scope

- `engine/tests/core/proof-obligations.test.ts`
- `engine/tests/handlers/helpers/orchestration-status-diagnostics.test.ts`

The focused parser regression pins the exact proof-lockstep cases named by the critical Finding. The focused CLI regression proves the newly preserved TaskGraph read/parse cause without expanding the already oversized orchestration integration suite.

## Validation

1. Focused Vitest suites for Lifecycle Machine presence, Proof parser/load-boundary lockstep, status diagnostics, Pi transcript settlement, and findings/review transitions.
2. Apply-mode `distill` pass after a green focused baseline; one move at a time with covering tests.
3. `npm run typecheck` including unused-code checks.
4. Full-tier Loom lint over every changed production TypeScript file.
5. `git diff --check`.
6. Required full command: `env -u PI_CODING_AGENT npm test`.
7. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 9 — Full-branch rereview remediation

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 54-path branch delta `30241fd..4231840`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260824T062219Z-deterministic-policy-rereview-9`
- Review result digest: `2a70ea81b570d9c79085d8bf18112f142c34450e63c053740b782f35268a68e2`
- Criticals found: 4
- Surviving criticals: 3
- Refuted criticals: 1

## Mandatory critical remediation

1. `engine/src/handlers/subagent-stop/update-task-status.ts`: clear `revalidation_required` whenever the newly evaluated Proof is satisfied, including regression-waived recovery. Apply the same rule through the Pi-shared `applyUntrustedStopResolution`; add Claude and Pi recovery regressions.
2. `pi/subagent-result.ts`: remove the pre-lock completed-Task short circuit. Every completed/missing decision and execution release must be re-evaluated by the existing locked settlement paths; add a stale-pre-read/concurrent-reopen regression.
3. `engine/src/core/proof-obligations.ts`: require exact keys for every proof/test ADT parser arm, including nested obligation, result, failure, evidence, and aggregate records. Preserve the intentional absent-provenance compatibility rule while rejecting contradictory surplus authority. Add property coverage across every parser arm and pin the State File load boundary.

## Advisory dispositions

### Accepted

1. Correct the `DraftFinding` comment: reviewer output is normalized before becoming a draft, including claim whitespace and optional location sanitation.
2. Consolidate legacy and registered completion replay-after-failure handling behind one local discriminated helper without changing messages, ordering, or replay semantics.
3. Consolidate the three accepted Pi completion-infrastructure failure tails into one local operation that records the diagnostic and quarantines authority.

### Deferred

1. Redesign `Task` as a lifecycle/proof discriminated union. Reason: unchanged from prior rounds; it must land atomically with Slice 3's Completion Oracle and explicit stored-state migration.
2. Move shared implementation-proof settlement out of the Claude SubagentStop shell into an engine-owned functional-core module. Reason: this is the planned Slice 3 Implementation Completion Oracle seam; moving it independently would create a temporary interface immediately replaced by the Oracle.

### Dismissed

None.

## Refuted-finding audit

- `comment-analyzer-1` (`engine/src/types.ts`): the claim that `parseStoredFinding` contradicts the statement that only `attributeFindings` produces Finding identity was refuted by intent and blast-radius. The parser rehydrates an already persisted identity; it does not mint derived identity. No code or comment change is authorized for this finding.

## Support paths outside frozen review scope

None. Every production file, regression file, and this cumulative remediation plan are present in the frozen 54-path branch delta.

## Validation

1. Focused Vitest suites for Proof parsing/load guards, Claude settlement, Pi settlement/TOCTOU, and Wave completion replay.
2. Apply-mode `distill` pass after the focused baseline is green, one behavior-preserving move at a time.
3. `npm run typecheck` including unused-code checks.
4. Full-tier Loom lint over every changed production TypeScript file.
5. `git diff --check`.
6. Required full command: `env -u PI_CODING_AGENT -u LOOM_PI_RUNTIME_REVISION -u LOOM_PI_RUNTIME_ROOT npm test`.
7. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 10 — Full-branch rereview remediation

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 54-path branch delta `30241fd..1d85a12`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260824T071442Z-deterministic-policy-rereview-10`
- Review result digest: `c571f737c5920d517d02b10a693317b19182f029864306ca9427c2d355b7dce5`
- Criticals found: 2
- Surviving criticals: 2
- Refuted criticals: 0

## Mandatory critical remediation

1. `engine/src/core/review-output.ts`: make packet-bound `review_lifecycle` parsing exact at both levels. The root must contain only `prior_findings`; every assessment must contain only `finding_id`, `verdict`, and `reason`. Add focused surplus-root and surplus-entry regressions.
2. `pi/subagent-result.ts`: an unbound successful implementation result must preserve all ambiguous `executing_tasks` and return the binding failure through `processingErrors`; it must not erase parallel execution authority while looking successful. Add an ambiguous-success regression.

## Advisory dispositions

### Accepted

1. Return missing/unknown successful review binding diagnostics through `processingErrors`; dropped findings are an orchestration failure, not log-only success.
2. Return missing/unknown failed review binding diagnostics through `processingErrors`; inability to persist `evidence_capture_failed` must be caller-visible.
3. Correct the repo-root test reference in `review-output.ts` from `tests/review-agent-contract.test.ts` to `engine/tests/review-agent-contract.test.ts`.
4. Remove `firstFailureErrors`' unreachable `failed.ok` recheck after selecting only failed transcript results.
5. Narrow `collectDiff`'s selected failures with typed predicates so success checks are not repeated after `find`.
6. Carry `snapshotGateDeps`'s non-null Lifecycle Machine path in a local value rather than reasserting it with `!`.
7. Project bound Lifecycle Machines into records whose `machineFile` is non-null before artifact evaluation, eliminating later assertions without changing diagnostics.

### Deferred

1. Redesign `Task` as a status/proof discriminated union. Reason: this remains Slice 3 work and must land atomically with the Completion Oracle and explicit stored-state migration.
2. Add a dedicated exact-slot `ReviewRun` union arm. Reason: this is an authority-schema migration coupled to the planned shared `SlotId`/Review Run redesign, not a bounded parser remediation.
3. Replace `WaveReviewRequestBinding`'s request tuple with a parsed roster-slot value. Reason: this changes the Wave Gate Public Surface and belongs with the planned exact-slot authority migration.
4. Deepen `TaskGraphStore` to return typed transaction values. Reason: the planned Slice 3 engine-owned Completion Oracle removes the Pi-only settlement seam; migrating all Pi appliers now would create a broad transitional interface immediately replaced by that work.

### Dismissed

None.

## Refuted-finding audit

The canonical reproduction, intent, and blast-radius panel unanimously upheld both critical Findings. No critical Finding was refuted.

## Support paths outside frozen review scope

None. The production files, focused regression files, and cumulative remediation plan are all in the frozen 54-path scope.

## Validation

1. Focused Vitest suites for review lifecycle parsing, Pi implementation/review binding, Diff collection, Lifecycle Machine artifacts, and Wave Gate dependency snapshots.
2. Apply-mode `distill` after a green focused baseline, one behavior-preserving move at a time.
3. `npm run typecheck` including unused-code checks.
4. Full-tier Loom lint over every changed production TypeScript file.
5. `git diff --check`.
6. Required full command: `env -u PI_CODING_AGENT -u LOOM_PI_RUNTIME_REVISION -u LOOM_PI_RUNTIME_ROOT npm test`.
7. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 11 — Full-branch rereview remediation

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 54-path branch delta `30241fd..dc4aad8`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260824T075715Z-deterministic-policy-rereview-11`
- Review result digest: `9076bbf107a872f8cc1e76211afe34fe72c1c837093743698cf3931c0b92d223`
- Criticals found: 2
- Surviving criticals: 1
- Refuted criticals: 1

## Mandatory critical remediation

1. `pi/subagent-result.ts`: correct the stale unbound implementation-binding comment. Ambiguous or empty bindings are reported as processing errors and preserve execution authority unchanged; only a bound completed/missing Task is released.

## Advisory dispositions

### Accepted

1. Correct `nextOrdinal` documentation: production callers supply `resolved`, while the default remains a compatibility convenience for scoped tests/legacy helpers.
2. Replace `implementationTestResult`'s independently representable structured/fallback evidence inputs with one discriminated observation selected at transcript parsing.
3. Extract one generic private stored-array parser shared by `parseStoredFindings`, `parseStoredRefutations`, and `parseStoredResolutions`.
4. Extract one severity-aware multiset subtraction primitive shared by structured-block arbitration paths.

### Deferred

1. Redesign the Task aggregate as a status/proof discriminated union. Reason: this remains Slice 3 work and requires the Completion Oracle plus explicit stored-state migration.
2. Extract the TaskGraph codec/invariant proof surface from filesystem-backed `StateManager`. Reason: this broad FC/IS seam migration remains planned as a dedicated architecture slice, not review remediation.
3. Replace Wave Gate WeakSet authority registries with explicit proof values. Reason: this changes the Wave Gate authority interface and remains assigned to Slice 2's completion-suite architecture checkpoint.

### Dismissed

None.

## Refuted-finding audit

- `code-reviewer-1` (`pi/subagent-result.ts`): the claim that a Task disappearing during locked review application is silently lost was refuted by intent and blast-radius. The branch emits an explicit stderr warning, cannot attach evidence to authority that no longer exists, misapplies nothing to surviving Tasks, and leaves surviving Tasks fail-closed. No processing-error or settlement change is authorized.

## Support paths outside frozen review scope

None. The production files, regression suites, and cumulative remediation plan are all in the frozen 54-path scope.

## Validation

1. Focused Vitest suites for Pi result settlement, Findings storage parsing, and review-output arbitration.
2. Apply-mode `distill` after a green focused baseline, one behavior-preserving move at a time.
3. `npm run typecheck` including unused-code checks.
4. Full-tier Loom lint over every changed production TypeScript file.
5. `git diff --check`.
6. Required full command attempted three times: every run passed all 207 files / 5,165 tests with one intentional skip, then Vitest emitted the same post-run worker RPC `Timeout calling "onTaskUpdate"` and exited non-zero before smoke execution.
7. Bounded-worker full validation: `env -u PI_CODING_AGENT -u LOOM_PI_RUNTIME_REVISION -u LOOM_PI_RUNTIME_ROOT npx vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=15000` — 207 files / 5,165 passed / 1 intentional skip, no runner error.
8. Complete smoke validation: `env -u PI_CODING_AGENT -u LOOM_PI_RUNTIME_REVISION -u LOOM_PI_RUNTIME_ROOT npm run test:smoke` — panel 22/22, review panel 19/19, standalone review, orchestration façade, Pi resources, and TaskGraph 21/21 all passed.
9. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 12 — Full-branch rereview remediation

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 54-path branch delta `30241fd..620530d`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260824T085330Z-deterministic-policy-rereview-12`
- Review result digest: `9a609833f0e4914fd61bb1af77118a62df29929aaa120fbf67614fd7d005c2c9`
- Criticals found: 3
- Surviving criticals: 2
- Refuted criticals: 1

## Mandatory critical remediation

1. `engine/src/state-manager.ts`: when a caller supplies a session id, require exact session TaskGraph authority. Invalid ids, absent pointers, and dangling pointers must refuse local fallback so Hook writes cannot retarget the repository-local State File. Preserve local resolution only for callers that supply no session id.
2. `engine/src/handlers/subagent-stop/update-task-status.ts`: when a resolved transcript becomes unreadable, stop before parsing empty bytes. If exactly one executing Task supplies cleanup attribution, quarantine it through `applyCompletionInfrastructureFailure`; otherwise preserve ambiguous execution authority and return a contextual infrastructure error.

## Advisory dispositions

### Accepted

1. Model advisory-approval observation as a discriminated approved/not-approved/unavailable value and render unavailable event-log evidence as blocked status rather than `false`.
2. Make GitHub checkbox-update failure actionable by naming the exact affected Tasks and manual `gh issue edit` remediation while preserving its non-authoritative notification status.
3. Add a Pi bridge regression proving transcript-regex fallback remains unverified and cannot satisfy a regression-required Task.
4. Correct `engine/src/types.ts`'s module header to describe its shared Loom schemas as well as Hook results.
5. Document `populate-task-graph --force` and its overwrite semantics in the usage comment.
6. Parse stored Refutation and Resolution records once before duplicate-id derivation, removing repeated parser calls and non-null assertions without changing diagnostics.
7. Bind current-Wave Tasks and their ids once in `readinessReasons` rather than repeatedly rescanning the whole TaskGraph.

### Deferred

None.

### Dismissed

None.

## Refuted-finding audit

- `code-reviewer-1` (`pi/subagent-result.ts`): reproduction and intent established that request-bound Pi reviews bypass `applyReviewPiResult`, are captured as immutable run artifacts, and reach `applyReviewResolution` only through the Wave façade's exact slot/attempt validation. The compatibility applier does not process engine-bound Review Runs, so no Pi settlement change is authorized.

## Support paths outside frozen review scope

- `pi/extension.ts`
- `engine/src/handlers/subagent-stop/dispatch.ts`
- `engine/src/handlers/subagent-stop/advance-phase.ts`
- `engine/src/handlers/subagent-stop/store-reviewer-findings.ts`
- `engine/src/handlers/subagent-stop/store-spec-check-findings.ts`
- `scripts/smoke-panel-mode.sh`

These adapters and the real-CLI fixture complete the mandatory session-authority split: Claude Hook shells consume strict session pointers, while the Pi parent adapter explicitly consumes local authority but still fails closed on any present unreadable or dangling pointer. The smoke publishes the SessionStart pointer instead of relying on forbidden local fallback.

## Validation

1. Focused regressions: session/transcript/status/notification/Pi/Findings/Wave suites **391/391**; orchestration façade **96/96**; final StateManager + Pi extension integration **200/200**.
2. Apply-mode `distill`: parsed stored audit records once, bound Wave ids once, removed exactly-one Task assertion, and restored Pi verification-shell altitude through typed run-level outcomes. Covering verification remained green (**56/56** and Pi integration **109/109**).
3. `npm run typecheck` including unused-code checks passed.
4. Full-tier Loom lint passed for all 13 changed production TypeScript files.
5. `git diff --check` passed.
6. Bounded-worker full suite: `env -u PI_CODING_AGENT -u LOOM_PI_RUNTIME_REVISION -u LOOM_PI_RUNTIME_ROOT npx vitest run --maxWorkers=4 --minWorkers=1 --testTimeout=15000` — **207 files, 5,170 passed, 1 intentional skip**.
7. Complete smoke suite passed: panel **22/22**, review panel **19/19**, standalone review, orchestration façade, Pi resources, and TaskGraph **21/21**.
8. Registered remediation audit/install through the Orchestration Façade, then commit and push.

---

# Round 13 — Full-branch rereview remediation

## Authority

- Branch: `feat/deterministic-task-execution`
- Review scope: exact 60-path branch delta `30241fd..acca3c1`, frozen in the authoritative result
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-20260824T112107Z-deterministic-policy-rereview-13`
- Review result digest: `e1a42b72e3e99b09301a81b293c87c4907ab74b0cc39d11c5e49175654afea01`
- Criticals found: 2
- Surviving criticals: 1
- Refuted criticals: 1

## Mandatory critical remediation

1. `engine/src/handlers/subagent-stop/update-task-status.ts`: when a readable completion transcript has no Task identity and current execution authority is empty or ambiguous, preserve `executing_tasks` unchanged and return a contextual error. Never release sibling reservations from unbound evidence.

## Advisory dispositions

### Accepted

1. Move unreadable-transcript cleanup attribution inside `StateManager.updateAndReturn`, so the exactly-one decision and quarantine transition consume the same locked TaskGraph. Add a race regression where a sibling reservation appears before the locked decision.
2. Narrow `review-output.ts`'s contract-test comment to the Machine Summary markers and fenced-block presence that the referenced test actually proves.
3. Return directly from `parseRequirement` when a waiver reason is absent or invalid, eliminating the redundant post-error undefined check without changing accumulated diagnostics.
4. Replace single-predicate mutable error accumulators in `parsePendingProof` and `evaluatedResults` with direct fail-closed guards.

### Deferred

1. Brand `WaveReviewContextBase` run ids and digests. Reason: these shared authority brands must move with the planned exact-slot Review Run/roster authority redesign; adding local brands now would create incompatible same-concept types across the orchestration seam.
2. Extract a pure TaskGraph codec from `StateManager`. Reason: this remains the dedicated FC/IS architecture slice already identified in prior rounds and requires coordinated parser ownership and property-test migration, not bounded review remediation.

### Dismissed

None.

## Refuted-finding audit

- `type-design-analyzer-1` (`engine/src/core/findings.ts`): reproduction and intent established that `taskFindingsError` independently rejects empty, incomplete, duplicate, or misordered `slot_authority` before `parseTaskGraph` returns a typed graph. The existing StateManager load-guard regression pins `slot_authority: []`; no parser change is authorized.

## Support paths outside frozen review scope

None. The production files, focused regressions, and cumulative remediation plan are all inside the frozen 60-path review scope.

## Validation

1. Focused Claude settlement, TaskGraph machine settlement, Verification Policy, Proof parser, review-output, and reviewer-contract suites passed: **6 files, 209/209**.
2. Apply-mode `distill` retained the direct parser guards and explicit locked-decision union; no further move was applied because the remaining brand/codec opportunities change interfaces and belong to the deferred `deepen` slices. Focused verification remained **209/209**.
3. `npm run typecheck` including unused-code checks passed.
4. Full-tier Loom lint passed for all four changed production TypeScript files.
5. `git diff --check` passed.
6. Bounded-worker full suite passed: **207 files, 5,171 passed, 1 intentional skip**.
7. Complete smoke suite passed: panel **22/22**, review panel **19/19**, standalone review, orchestration façade, Pi resources, and TaskGraph **21/21**.
8. Registered remediation audit/install through the Orchestration Façade, then commit and push.
