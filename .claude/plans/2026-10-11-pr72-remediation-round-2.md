# PR #72 remediation, round 2: implementation-loop levers

- **Branch:** `feat/implementation-loop-levers` (PR #72)
- **Scope:** `all`, 29 frozen files at `9f0f38f3`
- **Review run:** `.claude/reviews/review-and-fix-runs/pr72-review-r2-20261011T184844Z`. architecture-tech-lead attempt 1 was refused for incomplete read coverage; attempt 2 was admitted.
- **Advisory policy:** `.claude/reviews/review-and-fix-runs/pr72-policy-r2-20261011T185727Z`, revision `initial`, with disposition digest `1560ed030a323f89d90ee48b9b1f3ecee838adae84c3eccbf12f5bbd62674168`

## Adjudication

- Emitted and admitted: 0 critical, 11 advisory.
- After refutation: 0 surviving critical, 0 refuted critical, 11 advisory.
- `defectFamily` is `{"kind":"not-required"}`: there are no repair groups, siblings, checks or Historical RED declarations.

## Advisory dispositions (DECLARED)

| ID | Decision | Fix |
|---|---|---|
| silent-failure-hunter-1 | accepted | `withStoredMemory`: a memory-store failure keeps the model advisory and appends an operator note |
| pr-test-analyzer-1 | accepted | Direct run-slot tests: release ownership guard, and every acquire decision through the pure `slotDecision` |
| type-design-analyzer-1 | accepted | `onSpawn` removed. The port returns one `CompilerRun` (completed, failed, or detached `{pid, afterMs}`), and the shell hands the slot over from that value |
| comment-analyzer-1 | accepted | The busy path returns before reading memory |
| comment-analyzer-2 | accepted | The hand-off now happens exactly at deadline miss; the docs say so |
| comment-analyzer-3 | accepted | Round-1 plan row corrected to `piPostEdit` |
| architecture-tech-lead-1 | accepted | `handlers/type-diagnostics-run-slot.ts` extracted, with its own suite |
| architecture-tech-lead-2 | accepted | `adviceForEdit` and `AdviseOnEdit` moved to `handlers/type-diagnostics-edit.ts`; core keeps the pure values only |
| architecture-tech-lead-3 | accepted | The shim skips `.d.ts`, with a shim-vs-`isTypeScriptSource` contract test. `editedFilePath` moved to `core/tool-vocabulary` (lint-file and type-diagnostics share it) |
| architecture-tech-lead-4 | accepted | `HookResult` variant `post-tool-use-context` replaces the optional `allow.postToolUseContext`; `cli.ts` matches it |
| code-simplifier-1 | accepted | `isRecord` from `core/plain-record` in all new modules |

No advisory was deferred or dismissed.

## Validation

- `npm run typecheck` (engine and Pi), plus the type-diagnostics, handler, shim and hooks-sync suites
- full `npm run verify`
- live Claude Code and Pi smoke runs

## Registered remediation

The remediation run is a schema-v2 zero-critical start. `supportPaths` must name these, which fall outside the 29-file reviewed scope:

- this plan
- `engine/src/handlers/type-diagnostics-run-slot.ts`
- `engine/src/handlers/type-diagnostics-edit.ts`
- `engine/tests/handlers/type-diagnostics-run-slot.test.ts`
- `engine/tests/handlers/type-diagnostics-edit.test.ts`
- `engine/src/core/tool-vocabulary.ts`
- `engine/src/handlers/post-tool-use/lint-file.ts`
- `engine/tests/handlers/post-tool-use/lint-file.test.ts`
