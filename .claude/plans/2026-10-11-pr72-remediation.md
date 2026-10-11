# PR #72 remediation — implementation-loop levers

- **Branch:** `feat/implementation-loop-levers` (PR #72)
- **Scope:** `all`, the 27-file frozen diff of `main...feat/implementation-loop-levers` at `cb02edcf`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr72-review-20261011T173725Z`, with result digest `f5882f57df05334a79e0e4a16f49d9064f50cbaa9c8f612423de3b2cb9f5f979`
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr72-policy-20261011T174343Z`, revision `initial`, with disposition digest `53538430d84f82f9a22ceb0392501285e74f0c0964eb7b29211c4f4243ba5a47`

## Adjudication

- Emitted and admitted: 0 critical, 17 advisory.
- After refutation: 0 surviving critical, 0 refuted critical, 17 advisory.
- There are no surviving criticals, so `defectFamily` is `{"kind":"not-required"}`. No repair groups, siblings, checks or Historical RED declarations apply.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| code-reviewer-1 | accepted | Exclusive (O_EXCL) run slot taken before spawn; per-run output file; memory read and written only while holding the slot |
| architecture-tech-lead-1 | accepted | Same root cause as code-reviewer-1: one acquire-run-slot operation |
| silent-failure-hunter-2 | accepted | The slot records `{pid, startedAt, output}`; reclaimed when the pid is dead or the slot is older than `STALE_RUN_MS` |
| silent-failure-hunter-1 | accepted | A nonzero exit with zero parsed diagnostics → `failed`, carrying the output's first line |
| silent-failure-hunter-3 | accepted | Pi writes the operator note to stderr when `ctx.hasUI` is false |
| comment-analyzer-1 | accepted | The check adapter catches all I/O and returns `failed`, so "never throws" holds |
| architecture-tech-lead-4 | accepted | `RunTypeCheck` port injectable through `TypeDiagnosticsOptions.runCheck`; the real tsc adapter is the default |
| pr-test-analyzer-3 | accepted | Fast port-based tests for busy, timed-out, failed, stale slot and corrupt memory; the real deadline test waits for the detached build to exit |
| architecture-tech-lead-2 | accepted | Timestamped repeat records and baseline; the judge takes `now`; entries older than `REPEAT_WINDOW_MS` do not count; multiset fingerprint and baseline |
| type-design-analyzer-1 | accepted in part | `MemoryUpdate = keep \| replace` replaces `memory: TypeCheckMemory \| null`. The `TypeAdvisory` product type stays because all four combinations are valid |
| architecture-tech-lead-3 | accepted | Shared core `adviceForEdit(path, root, advise)` for both adapters; Pi latency trade-off documented |
| pr-test-analyzer-1 | accepted | Pure, port-injected `piPostEditResult` in `pi-adapter.ts`, with tests; `extension.ts` becomes thin wiring |
| pr-test-analyzer-2 | accepted | Bash-invoking shim test with fixture stdin and a stub plugin root |
| code-simplifier-1 | accepted | Named remedy consts |
| code-simplifier-2 | accepted | `identityKeys` helper |
| code-simplifier-3 | accepted | `NO_ADVISORY` exported from core and reused |
| code-simplifier-4 | accepted | Conditional spread in `postToolUseContextResult`; the handler's duplicated split is removed |

No advisory was deferred or dismissed.

## Validation

- `cd engine && npx tsc --noEmit`, plus the focused vitest suites for the changed modules
- full `npm run verify` from a clean scratch worktree (the nested `.claude/worktrees/` breaks main-checkout verify)
- live Claude Code and Pi smoke tests, repeated after the fixes

## Registered remediation

The remediation is a schema-v2 zero-critical start with `defectFamily: not-required`. `supportPaths` lists this plan and every new test file outside the reviewed scope.
