# Slice 3 Completion Oracle — PR Remediation Round 6

## Authority
- Reviewed HEAD: `7fa2c25491263838143c00c17a7066abf39aaa36`
- Review: `review-20260825T044841Z-deterministic-task-completion-oracle-pr`
- Result digest: `7617045fe1cc205ca6bdf494a339885b915f06e265981f6528f4ab6c1d0f1501`
- Surviving criticals: dirty-baseline laundering, orphan execution reservations, stale Pi graph pointer
- Refuted critical: Wave advisory-status projection; panel found documented blocked fallback, no authorization. Never fix as part of this run.

## Critical remediation
1. Preserve repository-delta authority across unresolved attempts. Failed/retry/escalation/infrastructure/stale reclamation must not clear or replace the first unresolved repository baseline. Fresh registration binds authority to the retained baseline. Only accepted implementation/Wave-authorized cleanup may clear it. Regression: foreign write attempt 1, failure, fresh attempt, otherwise-green result remains non-positive until foreign delta is reverted or explicitly attributed.
2. Orphan `executing_tasks` IDs fail closed. Preserve read compatibility only through explicit migration classification if necessary, but Wave readiness and new graph writes cannot ignore unknown reservations. Prefer parser rejection with actionable migration/repair if no live supported graph relies on them. Update stale recovery/repair tests.
3. Shared session TaskGraph pointer binder canonicalizes current graph, reads existing pointer, refreshes mismatch atomically/no-follow, and returns ownership semantics. Claude and Pi use one helper. Pi regression: stale graph A pointer, active graph B registration/result settles B only.

## Accepted advisories
- New-test port returns typed observation Result; expected Git/fs/parser observation failures are data, unexpected programmer defects are not catch-all downgraded.
- Add modern pointer-write rollback regression.
- Carry branded TaskId in parsed Task model if practical without raw-input compatibility loss; otherwise parser-normalized Task type at StateManager boundary.
- Correct validate-phase-order/config/extract-task-id comments.
- Remove impossible exact-roster guard and duplicate legacy test-result computation.
- Surface unnameable active-graph SubagentStop as error, stale cleanup directory probe ENOENT-only, disappearing Pi review Task as processing error.
- Tighten TaskCompletionSuiteResult to exact one task-scoped check.
- Correct review-output test comment.
- Share trusted-evidence and Wave-complete predicates.
- Add typed Claude image arm with exact source and realistic nested fixture.

## Remediation outcome
Implemented every surviving critical and accepted advisory in this round. The refuted Wave advisory-status projection remains byte-for-byte unchanged, and no Slice 4 retry/escalation dispatch was added.

- Repository authority now retains the first unresolved baseline across semantic failure, infrastructure block, rollback, and stale reclamation. Fresh attempts bind to that retained baseline. Shared exact settlement derives canonical sibling ownership from the locked current-Wave TaskGraph; allowed current-Task paths remain local, sibling-owned paths remain inert/non-attributable, and every other changed path blocks, invalidates, and persists unresolved even when transcript parsing omitted it. Raw parser outside paths always fail. Reversion removes resolved paths, and exact acceptance clears the carry.
- TaskGraph parsing and the operator validator reject orphan `executing_tasks` IDs with an actionable `repair-task-graph` diagnostic. Repair removes only IDs with no Task and reports each removal.
- Claude, Pi parent spawns, and Pi child grants share one canonical TaskGraph pointer binder. It performs locked no-follow reads, atomic replacement, stale-graph refresh, and value-checked owned rollback.
- New-test observation is a typed Result over Git/filesystem failures. Expected observation failures become infrastructure data; unexpected adapter/programmer exceptions propagate as defects.
- Parsed TaskGraph identity carries branded Task IDs, the Task suite roster has no impossible second emptiness guard, legacy Pi test evidence is computed once, and the three inaccurate comments were corrected.
- The prior typed image, disappearing-review, unnameable-stop, ENOENT-only stale cleanup, exact Task suite, shared evidence/Wave predicates, and review-comment remediations remain intact and covered.

## Validation
Final validation is executed after this plan update so no later byte write invalidates the evidence:

1. Focused baseline-carry, orphan parser/repair, pointer switch/rollback/no-follow, typed new-test Result, TaskId/suite, image, stale-cleanup, dispatch, and Pi result suites.
2. Full unit suite: `cd engine && env -u PI_CODING_AGENT npm run test:unit`.
3. Smoke suite: `cd engine && env -u PI_CODING_AGENT npm run test:smoke`.
4. Type and unused checks: `cd engine && npm run typecheck`.
5. Full-tier lint over every changed production TypeScript artifact.
6. `git diff --check` plus explicit scope/no-Slice4/refuted-projection inspection.

No files are staged or committed by this remediation.
