# PR #40 remediation

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Base: `origin/main` at `cfeacae6c49c2e66a2cde9cbf491454978362736`
Reviewed head: `56c6ec01622ade8fa8176b42b0a749d6b4572e51`
Review Run Directory: `review-20260901T142427Z-2598415`
Authoritative result digest: `c0ba73d31e06f498e587844d565674cb408616fbe0bf1bb179388ae4c3f78861`

## Frozen review scope

- `.claude/plans/2026-08-23-deterministic-task-execution.md`
- `.claude/plans/2026-09-01-deterministic-implementation-retry.md`
- `CONTEXT.md`
- `commands/loom.md`
- `commands/templates/impl-agent-context.md`
- `docs/deterministic-implementation.md`
- `docs/workflows.md`
- `engine/src/core/implementation-application.ts`
- `engine/src/core/implementation-completion.ts`
- `engine/src/core/implementation-retry.ts`
- `engine/src/core/validate-task-execution.ts`
- `engine/src/core/wave-gate-machine.ts`
- `engine/src/handlers/helpers/orchestration.ts`
- `engine/src/handlers/session-start/resume-after-clear.ts`
- `engine/src/handlers/task-execution.ts`
- `engine/src/state-manager.ts`
- `engine/src/types.ts`
- `engine/tests/core/implementation-retry.test.ts`
- `engine/tests/handlers/complete-wave-gate.test.ts`
- `engine/tests/handlers/session-start/resume-after-clear.test.ts`
- `engine/tests/handlers/task-execution-attempt-registration.test.ts`
- `engine/tests/impl-agent-skill-contract.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `engine/tests/pi/attempt-authority-correlation.test.ts`
- `engine/tests/state-manager-implementation-completion.test.ts`
- `pi/extension.ts`
- `pi/subagent-result.ts`

## Surviving criticals — mandatory

The refutation panel upheld all ten critical Findings under reproduction, intent, and security. Several are duplicate observations of the same defect; every ID remains accounted for.

1. `code-reviewer-1` — attempt-2 admission accepts representation-different retry appendix bytes.
   - Compare the exact sole appendix line with the canonical status-rendered appendix after parsing; semantically equivalent whitespace, key ordering, or escaping must fail.
   - Add representation-only mutation regressions.
2. `silent-failure-hunter-1` — resume-after-clear treats access failure as absence.
   - Remove `existsSync`; call the fail-closed `StateManager.fromPath` seam inside the access error boundary.
   - Preserve genuine ENOENT passthrough and add corrupt/inaccessible graph regressions.
3. `silent-failure-hunter-2`, `type-design-analyzer-1`, and `comment-analyzer-1` — receipt filtering accepts impossible order and can reset the budget.
   - Replace count/filter inference with an ordered pure lineage reducer.
   - Permit only current-attempt infrastructure, current-attempt implementation, attempt-1 retry, and attempt-2 escalation; reset to attempt 1 only after a legal implementation; terminal escalation rejects every suffix.
   - Include receipt index/id in fail-closed diagnostics.
4. `pr-test-analyzer-1` — contradictory order has no regression proof.
   - Add escalation-before-retry, attempt-2 infrastructure-before-retry, retry-then-attempt-1 implementation, and post-escalation receipt tests.
5. `pr-test-analyzer-2` — infrastructure property omits attempt 2.
   - Add a fast-check property proving one or many attempt-2 infrastructure receipts after exact retry authority preserve semantic attempt 2.
6. `type-design-analyzer-2` — the attempt-context constructor can create parser-invalid values.
   - Make successful spawn admission an initial/retry discriminated union.
   - Enforce constructor attempt/admission identity before returning the validated context; add constructor/parser invariant tests.
7. `comment-analyzer-2` — canonical status dispatches already-active Tasks.
   - Exclude `executing_tasks` and Tasks with active attempt authority from spawn dispatches.
   - Add an explicit wait recovery arm when all outstanding Tasks are active; mixed windows dispatch only inactive Tasks.
8. `code-simplifier-1` — StateManager has an unreachable initial-context rejection.
   - Delete the dead branch after parser/disposition proof.

## Advisory dispositions

### Accepted

1. `code-reviewer-2` — require `active_implementation_context` for semantic attempt 2; historical compatibility applies only to attempt 1.
2. `code-reviewer-3` — escalation-before-retry is fixed by the mandatory ordered lineage reducer.
3. `silent-failure-hunter-4` — split failed Pi spec-check load, document observation, and persistence diagnostics; await persistence so rejection is caught.
4. `pr-test-analyzer-3` — add formatting-only byte mutation coverage for the exact appendix contract.
5. `pr-test-analyzer-4` — assert Pi `promptDigest` hashes the final child-visible prompt after write-grant injection.
6. `type-design-analyzer-3` — represent successful initial and retry spawn admissions as separate union arms.
7. `comment-analyzer-3` — resolved with exact-byte enforcement and matching documentation.
8. `comment-analyzer-4` — correct metadata comments and enforce attempt-2 context presence.
9. `comment-analyzer-5` — clarify that infrastructure recovery reuses the dispatch arm for the preserved current semantic attempt rather than introducing a third semantic attempt kind.
10. `code-simplifier-2` — construct the common status blocked action once after selecting escalation/healthy metadata.
11. `code-simplifier-3` — narrow plan, input, and admission sequentially in the locked authority recheck.
12. `code-simplifier-4` — inline the one-call pointer cleanup action into rollback lifecycle without changing cleanup order.
13. `code-simplifier-5` — extract the duplicated replacement-attempt/context fixture in the Pi finalization tests.

### Deferred

1. `type-design-analyzer-4` — aggregating all active attempt fields changes the shipped persisted Task schema and many writers; schedule as a dedicated State File migration/deepening.
2. `type-design-analyzer-5` — removing persisted `retry_count` requires a compatibility migration for reopen/legacy consumers; immutable history remains authoritative in Slice 4.
3. `architecture-tech-lead-1` — retaining prompt/context digests in settlement receipts changes the shipped receipt schema and canonical receipt IDs. Existing receipts retain exact reservation and authority identity; prompt-history retention needs a versioned schema migration.
4. `architecture-tech-lead-2` — extracting implementation-window projection from the Wave Gate Lifecycle Machine is a module-interface deepening, not a local behavior fix.
5. `architecture-tech-lead-3` — moving Pi’s multi-resource spawn transaction behind a deep operation changes shell seams and cleanup capability interfaces; handle in a dedicated deepening with fault-injection coverage.

### Dismissed

1. `silent-failure-hunter-3` — the total untrusted-input parser already fails closed, preserves bounded `Error.message`, and deliberately sanitizes arbitrary non-Error throws. Retaining arbitrary causes in the pure wire error would expand the public error shape and admit non-serializable hostile values without improving admission safety.

## Refuted-finding audit

- Refuted critical Findings: none.
- Surviving critical Findings: 10/10.

## Remediation support paths

Paths outside frozen review scope that remediation must authorize at start:

- `.claude/plans/2026-09-01-pr40-remediation.md`
- `engine/tests/pi/subagent-result.test.ts`

## Validation

All validation subprocesses unset `PI_CODING_AGENT`; orchestration mutation does not.

1. Focused baseline and per-move suites:
   - `bunx vitest run tests/core/implementation-retry.test.ts`
   - `bunx vitest run tests/handlers/session-start/resume-after-clear.test.ts`
   - `bunx vitest run tests/handlers/complete-wave-gate.test.ts`
   - `bunx vitest run tests/state-manager-implementation-completion.test.ts`
   - `bunx vitest run tests/handlers/task-execution-attempt-registration.test.ts`
   - `bunx vitest run tests/pi/subagent-result.test.ts`
   - focused Pi extension regressions
2. `bun run --cwd engine typecheck`
3. Full-tier lint for every changed production TypeScript file.
4. `bun run --cwd engine test:unit`
5. `bun run --cwd engine test:smoke`
6. `git diff --check`
7. Registered remediation and exact verified-index installation; no manual staging.

## Validation receipt

- Focused remediation suites: 255/255 passed; focused Pi lifecycle regressions: 6/6 passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 8 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,041 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.

## Distill/deepen receipt

Applied after a green focused baseline:

1. Successful Spawn Admission is an initial/retry ADT; context construction consumes that parsed value.
2. Retry history is one ordered reducer rather than filter/count inference.
3. Locked registration narrows plan/input/admission sequentially.
4. Status blocked-action construction is shared after selecting typed diagnostic metadata.
5. Pi pointer rollback is inline at its sole cleanup sequence.
6. Replacement attempt/context test setup is one fixture helper.
7. Failed spec-check settlement is one operation with load/observe/persist diagnostics.

Deferred interface-bound deepenings remain exactly those listed in Advisory dispositions: persisted active-attempt aggregation, `retry_count` migration, versioned receipt prompt-history retention, implementation-window module extraction, and the Pi spawn transaction seam.
