# PR Remediation — Deterministic Task Completion Oracle

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `32789a376fa46b3b1674e3b535ae31eb262802ab`
- Source review run: `review-20260827T122127Z-deterministic-task-completion-oracle-rereview`
- Source result digest: `8babfbb6ddccffa66fcc02224d70a8804798c357012f713de396933f3556bef0`
- Scope: the immutable 109-path Standalone Review scope recorded in the source `result.json`

## Surviving critical findings — mandatory

### `code-reviewer-1` — Claude pointer leases survive successful SubagentStop

Persist the exact `SessionTaskGraphPointerBinding` under the parsed session/agent identity after SubagentStart acquisition. Reorder SubagentStop dispatch so category settlement resolves and uses the session TaskGraph before cleanup releases the persisted lease. Cleanup releases only the exact persisted binding, retains cleanup authority on ownership loss/failure, and reports failures. Add lifecycle tests proving successful cleanup releases the final lease and permits a later graph target.

### `code-reviewer-2` — partial stat failure can delete readable session authority

Treat any unstatable member of a recognized session group as uncertainty for the entire group. The pure stale classifier receives protected session ids and excludes every member of those groups from deletion while still cleaning unrelated stale groups and ungrouped entries. Add focused pure and shell tests.

### `silent-failure-hunter-1` — reordered same-agent Pi review results can bind the wrong Task

At the review result boundary, parse the returned Task identity before trusting a reserved non-run-bound review slot. Require returned and reserved Task ids to agree; missing or mismatched identity produces a processing error and stores no findings. Add a regression with two same-agent reserved review slots returned in reverse Task order.

### `type-design-analyzer-1` — new-test boolean/evidence fields admit contradictory Task states

Replace independent Task metadata optionals with one stored new-test-evidence union: absent, not-written, or written with branded non-empty evidence. Parse legacy flat wire fields at the TaskGraph boundary and project only parser-proven values into `Task`. Update all production writers to use the smart constructor/projection and make Wave Gate consume the ADT. Add parser and gate tests for missing, empty, non-string, and valid evidence.

## Advisory dispositions

### Accepted

1. `code-reviewer-3` — make the cleanup wrapper test hermetic by injecting the cleanup directory/operations into the handler factory rather than reading shared `/tmp/claude-subagents`.
2. `silent-failure-hunter-2` — preserve the primary atomic-write error and combine it with temporary cleanup failure via `AggregateError`.
3. `silent-failure-hunter-3` — add the missing locked-update `taskFound` check to malformed Pi review handling.
4. `comment-analyzer-2` — replace “assertion density” with the exact added-test/additional-assertion heuristic.
5. `code-simplifier-1` — reuse the existing unavailable Task-local observation constructor instead of rebuilding its sentinel shape.
6. `code-simplifier-2` — introduce one private rejected-suite constructor to remove repeated result scaffolding without changing the public interface.

### Dismissed

- `architecture-tech-lead-1` — `loom-status` in Pi currently reports only phase/Wave/task counts and does not derive or display readiness or a next action, so it cannot contradict the canonical next-action projection as claimed. Replacing the compact UI command with the full Run-Directory/Git status shell would be a separate interface deepening with materially broader scope, not a correctness repair for this source review.

### Deferred

- None.

## Refuted-finding audit — never remediate

- `comment-analyzer-1` (`engine/src/types.ts:60`): the refutation panel unanimously established that “untouched” describes harness control polarity, not absence of Hook bookkeeping side effects. No code or comment change is authorized for this finding.

## Planned changed paths

Production:

- `engine/src/machine/evidence.ts`
- `engine/src/machine/index.ts`
- `engine/src/machine/task-graph-pointer.ts`
- `engine/src/handlers/subagent-start/mark-subagent-active.ts`
- `engine/src/handlers/subagent-stop/cleanup-subagent-flag.ts`
- `engine/src/handlers/subagent-stop/dispatch.ts`
- `engine/src/handlers/session-start/cleanup-stale-subagents.ts`
- `engine/src/types.ts`
- `engine/src/state-manager.ts`
- `engine/src/core/implementation-application.ts`
- `engine/src/core/implementation-completion.ts`
- `engine/src/core/wave-gate-machine.ts`
- `engine/src/handlers/helpers/reconcile-implementation-proof.ts`
- `engine/src/handlers/helpers/store-test-evidence.ts`
- `engine/src/handlers/subagent-stop/update-task-status.ts`
- `engine/src/orchestration/no-follow-fs.ts`
- `pi/subagent-result.ts`

Tests (existing reviewed paths where possible):

- `engine/tests/machine/task-graph-pointer.test.ts`
- `engine/tests/handlers/subagent-start/mark-subagent-active-roster.test.ts`
- `engine/tests/handlers/subagent-stop/cleanup-subagent-flag.test.ts`
- `engine/tests/handlers/subagent-stop/dispatch-resilience.test.ts`
- `engine/tests/handlers/session-start/cleanup-stale-subagents.test.ts`
- `engine/tests/pi/subagent-result.test.ts`
- `engine/tests/state-manager.test.ts`
- `engine/tests/handlers/complete-wave-gate.test.ts`
- focused existing tests affected by the new-test evidence ADT

Support paths outside frozen review scope:

- `.claude/plans/2026-08-27-pr-remediation.md`
- `engine/src/handlers/helpers/mark-tests-passed.ts` — canonical read-only projection updated to consume the new Task evidence ADT.
- `engine/tests/core/wave-completion-readiness.test.ts` — canonical completion-readiness fixture migrated to the new Task evidence ADT.

## Validation

1. Focused Vitest suites for pointer lease lifecycle, SubagentStop dispatch/cleanup, stale-session cleanup, Pi result binding, TaskGraph parsing, Wave Gate new-test checks, and atomic no-follow writes.
2. `npm run typecheck`
3. `npm run typecheck:unused`
4. Bounded full suite: `npx vitest run --maxWorkers=4 --minWorkers=1`
5. Repository smoke/lint commands used by the prior verified remediation, including changed-production lint and orchestration façade smoke.
6. `git diff --check`
7. Distill apply-mode pass only after the full baseline is green; rerun covering tests after each simplification.
8. Registered remediation with this source run and the plan as a support path; install only the engine-verified exact index.
9. Commit and push without force.
10. Run a fresh canonical Standalone Review against the pushed commit.
