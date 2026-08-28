# Post-merge Completion Oracle Remediation — Round 6

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Reviewed revision: `42a70d2d2242fa6b8fc3953fa0135e854e7e314b`
- Source review: `review-20260828T053525Z-deterministic-task-completion-oracle-post-merge-10`
- Source digest: `d5a594588973936beca62dd86ec8fbb770d99f8d60cf388517418d830618c2f4`
- Exact frozen scope: the 128 paths in the source review's immutable `result.json.scope`.
- Refuted criticals: none.

## Mandatory critical remediation

1. **Typed SubagentStop boundary** — add one pure parser for the top-level object and string identity/path fields. Both dispatch and direct cleanup consume only parsed `SubagentStopInput`. `null`, scalars, arrays, missing/non-string session identity, and non-string optional identity fields return contextual fail-closed errors before property access. Add direct-handler and dispatch regressions.
2. **Fail-closed repository-root discovery** — replace catch-all `git rev-parse` fallback with an argv-based Git probe. Only Git's explicit `not a git repository` result permits cwd-relative non-repository fallback; missing Git, permission/safe-directory/I/O failures, empty output, and every other uncertain observation throw and block hook startup. Add nested-cwd subprocess regressions with controlled Git adapters.

## Advisory dispositions

### Accepted

- `code-reviewer-2`: replace the global duplicate-start flag with independent `created | already-owned` acquisition dispositions for roster, machine binding, sidecar, and pointer capabilities; roll back only capabilities created by the blocked start. Add a mixed partial-recovery regression.
- `pr-test-analyzer-1`: exercise machine-binding identity recovery from `registry.readBindings` when `agent_type` is omitted.
- `type-design-analyzer-1`: remove the separately representable `TaskExecutionAuthorityPlan.taskId`; use `authority.taskId` as the single identity source.
- `comment-analyzer-1`: correct the stale `ARCHITECTURE_AGENTS` name to the Agent Catalog projection actually used.
- `comment-analyzer-2`: state that utility-agent passthrough occurs in `validatePhaseOrder`, not `detectPhase`.

### Dismissed as intentionally deferred Slice 4 behavior

- `code-reviewer-3`: Slice 3 intentionally mints manual executions as semantic attempt 1 and only classifies retry/escalation. `.claude/plans/2026-08-23-deterministic-task-execution.md:469` and `CONTEXT.md` reserve attempt-2 dispatch and bounded retry admission for Slice 4. Implementing it here would collapse the independently reviewable slice boundary.

### Deferred to focused type/architecture work

- `type-design-analyzer-2`: coupling `review_status` to evidence-failure roster changes the persisted Task ADT and migration surface; not required by either defect.
- `type-design-analyzer-3`: replacing Wave lifecycle booleans/counters with a closed ADT is a broad aggregate redesign.
- `architecture-tech-lead-1`: splitting pure agent policy from shell config is valid but larger than the repository-root fail-closed correction; schedule as a dedicated module deepening.
- `architecture-tech-lead-2`: extracting Pi spawn-correlation planning is a separate adapter/core deepening.
- `architecture-tech-lead-3`: replacing generic StateManager updates with aggregate commands is a broad public-seam redesign.

### Deferred incidental simplifications

- `code-simplifier-1`: StateManager pointed-graph helper deduplication is unrelated to these authority defects.
- `code-simplifier-2`: mark-tests-passed renderer flattening is unrelated presentation cleanup.
- `code-simplifier-3`: parser error collector extraction is unrelated internal cleanup.
- `code-simplifier-4`: sharing the Pi test store fake crosses test modules unrelated to this remediation.
- `code-simplifier-5`: consolidating Pi review-event test setup is unrelated test-harness cleanup.

## Support paths

The remediation start must authorize these paths outside the frozen source scope:

- `.claude/plans/2026-08-28-pr-remediation-round6.md`
- `engine/src/parsers/parse-subagent-stop-input.ts`
- `engine/src/machine/session-registry.ts`
- `engine/tests/runtime-resource-portability.test.ts`

## Validation

1. Focused Vitest for dispatch cleanup, roster rollback, config portability, ledger, and Task execution registration.
2. `npm run typecheck` including unused checks.
3. Full bounded Vitest (`--testTimeout=30000 --maxWorkers=4 --minWorkers=1`).
4. `npm run test:smoke`.
5. Changed-production lint and `git diff --check`.
6. Registered remediation installs the exact verified index; commit and push without force.
7. Fresh canonical standalone review/refutation on the remediated revision.
