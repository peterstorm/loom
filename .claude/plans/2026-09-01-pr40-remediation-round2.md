# PR #40 remediation — round 2

Date: 2026-09-01
Branch: `feat/deterministic-implementation-retry`
Base: `origin/main` at `cfeacae6c49c2e66a2cde9cbf491454978362736`
Reviewed head: `0dedd521`
Review Run Directory: `review-20260901T152736Z-2683978`
Authoritative result digest: `10a870d0c68d90e5d4f925de15601760b19794118e32a2ade919cfef5443a7a5`

## Scope

The authoritative review froze the 29 paths recorded in its `result.json`: PR #40’s complete `origin/main...0dedd521` scope, including the first remediation plan and Pi result regression.

## Surviving criticals

1. `code-reviewer-1` — status waits forever on a crashed/expired implementation reservation.
   - Add a typed shell observation of current time and graph-roster liveness to `GateDeps`.
   - Reuse the pure reservation staleness policy in implementation-window projection.
   - Treat policy-eligible stale reservations as dispatchable so registration can atomically archive/reclaim them; absent/unavailable observation remains fail-closed wait.
   - Add expired-no-roster and live-roster status regressions.
2. `type-design-analyzer-1` — Attempt Context construction accepts authority/admission from different Tasks.
   - Bind successful Spawn Admission to parsed Task id and admitted prompt digest.
   - Require semantic attempt, Task, and prompt digest equality in the constructor.
   - Add mismatched Task and mismatched prompt regressions.
3. `comment-analyzer-1` — reservation comments claim mathematical proof despite a bounded grace assumption.
   - Describe reclamation as policy eligibility under a bounded operational assumption; remove absolute abandonment/proof language without weakening behavior.
4. `comment-analyzer-2` — workflow prose contradicts required Task-level regression execution.
   - Distinguish Agent-executed Task regression commands from engine-owned Task Completion Oracle checks and quiescent Wave suite subprocesses.
5. `comment-analyzer-3` — plan labels infrastructure/stale attempt-2 outcomes terminal.
   - State that only attempt-2 semantic failure terminally escalates; infrastructure preserves attempt 2 and stale evidence leaves current authority untouched.

## Advisory dispositions

### Accepted

- `code-reviewer-2` + `pr-test-analyzer-1`: derive custom-path advisory workspace from `statePath`, not global `TASK_GRAPH_PATH`, and add a non-default path regression.
- `silent-failure-hunter-2`: make structured-diagnostics parse failure an explicit malformed transcript/infrastructure settlement, not silent fallback.
- `pr-test-analyzer-2`: test duplicate retry appendices fail exact-one admission.
- `pr-test-analyzer-3`: test digest-valid but stale retry context rejection at StateManager load.
- `type-design-analyzer-2`: admission carries prompt digest and the constructor proves it matches supplied prompt bytes.
- `type-design-analyzer-5`: remove redundant `pendingTaskIds`; derive the roster solely from non-empty dispatches.
- `comment-analyzer-4`: update Slice 4 plan from suffix filtering to full wire-order reduction with implemented reset.
- `comment-analyzer-5`: say status publishes terminal escalation; it does not launch an escalation process.
- `code-simplifier-1`: thread one parsed graph and already-observed workspace through private status helpers while preserving exported wrappers.
- `code-simplifier-2`: retain the exact parsed source line rather than rescanning the prompt for byte equality.
- `code-simplifier-3`: select diagnostic kind/category/eligibility once and construct common status diagnostic fields once.

### Deferred

- `type-design-analyzer-3` + `architecture-tech-lead-2`: versioned active-attempt aggregate requires a persisted Task schema migration.
- `type-design-analyzer-4`: `retry_count` removal requires compatibility migration for reopen/legacy consumers.
- `type-design-analyzer-6` + `architecture-tech-lead-4`: prompt/context identity in settlement receipts requires a versioned receipt schema and canonical-id migration.
- `architecture-tech-lead-1`: Pi spawn transaction extraction changes compensation/capability seams and needs dedicated fault-injection deepening.
- `architecture-tech-lead-3`: implementation-window module extraction is a dedicated module-interface deepening.

## Refuted critical audit

- `silent-failure-hunter-1` was refuted unanimously. StateManager supplies parser-proven authority and registration supplies a parsed `IsoInstant`; reclaimed receipt construction reparses those exact valid values deterministically, so the alleged production failure arm is unreachable.

## Support paths

- `.claude/plans/2026-09-01-pr40-remediation-round2.md`
- `engine/tests/handlers/helpers/orchestration.test.ts`

## Validation

- Focused retry, status, registration, StateManager, orchestration, Pi result, and Pi extension suites.
- TypeScript and unused-code gates.
- Full-tier lint for every changed production TypeScript file.
- Authoritative `test:unit` and `test:smoke`.
- `git diff --check`.
- Fresh registered remediation with the two support paths above; exact verified index installation; normal commit/push.

## Validation receipt

- Focused retry/status/StateManager/orchestration suites: 242/242 passed; focused Pi regressions: 5/5 passed.
- TypeScript and unused-code gates: passed.
- Full-tier lint: 6 changed production TypeScript files, 0 violations.
- Authoritative unit suite: 232 files, 6,043 passed, 1 platform skip, 0 failures.
- Smoke suites: panel 22/22, review panel 19/19, Standalone Review, all six orchestration façade scenarios, Pi resources, and TaskGraph 23/23 passed.
- `git diff --check`: clean.

## Distill receipt

Applied: one parsed status graph/workspace flow, retained parsed retry source line, single dispatch roster, explicit structured-diagnostics failure, and shared invariant diagnostic fields. The complete diagnostic union was not collapsed into independently selected strings because TypeScript correctly rejected the loss of correlation between diagnostic kind, eligibility, and recovery arm.
