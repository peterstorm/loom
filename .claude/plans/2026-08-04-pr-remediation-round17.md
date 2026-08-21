# PR Remediation — Standalone Review Round 17

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.eYKJtgPVCw`
- **Exact scope:** the immutable 202-path `scope` array in `.claude/reviews/review-and-fix-runs/run.eYKJtgPVCw/result.json`
- **Diff reviewed:** `main...HEAD` plus staged and unstaged changes (working tree was clean); 202 files, 32,006 additions, 2,178 deletions
- **Adjudication:** 7 critical findings survived; 0 were refuted; all 10 relevant advisories are accepted

## Remediation sequence

### 1. Make Pi batch preflight atomic

- **Source:** `code-reviewer-1`, `code-reviewer`, `pi/extension.ts:195`
- **Claim:** Pi batch preflight mutates `executing_tasks` before every sibling passes.
- **Fix:** add a batch validation/registration API in `engine/src/core/validate-task-execution.ts`; validate every task against one state snapshot, capture baselines, and perform one state update only after all items pass. Use that API from Pi while retaining the single-task wrapper for Claude Code.
- **Regression tests:** drive a valid T1 plus blocked T2 batch and prove no task execution state changes; replace duplicated test-only validation logic with the production pure decision.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/pi-extension-review-events.test.ts`

### 2. Require task-attributed artifact evidence

- **Source:** `code-reviewer-2`, `code-reviewer`, `engine/src/utils/artifact-baseline.ts:39`
- **Claim:** a parallel sibling's byte change can satisfy another task's declared-artifact proof.
- **Fix:** intersect baseline-confirmed byte changes with the stopped task's canonical structured `files_modified` evidence before evaluating declared-artifact obligations, in both Claude Code and Pi stop paths.
- **Regression tests:** prove an overlapping sibling-only byte change remains unsatisfied and that a byte change plus the target task's own write evidence succeeds.
- **Validation:** `cd engine && bunx vitest run tests/core/artifact-baseline.test.ts tests/handlers/update-task-status.test.ts tests/handlers/pi-stop-toctou.test.ts`

### 3. Fail loudly on missing Pi completion payloads

- **Source:** `silent-failure-hunter-1`, `silent-failure-hunter`, `pi/extension.ts:343`
- **Claim:** absent `details` or `details.results` is treated as an empty successful result set.
- **Fix:** make both missing shapes a loud evidence-loss no-op with a stable diagnostic; retain the existing array shape guard.
- **Regression tests:** emit Pi subagent results with missing `details`, missing `results`, and malformed `results`, and assert diagnostics plus unchanged task state.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 4. Always clear stopped Pi tasks

- **Source:** `silent-failure-hunter-2`, `silent-failure-hunter`, `pi/extension.ts:486`
- **Claim:** completed/missing/trusted pre-lock skips bypass `executing_tasks` cleanup.
- **Fix:** remove the early pre-lock skips so every resolved task id reaches the locked `applyUntrustedStopResolution` cleanup path; collect evidence only when the snapshot remains eligible, otherwise use a cleanup-only locked path.
- **Regression tests:** exercise the actual Pi event handler for missing, completed, trusted-pass, and trusted-fail tasks and prove cleanup without verdict overwrite.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/handlers/pi-stop-toctou.test.ts`

### 5. Require standalone findings to carry scoped locations

- **Source:** `type-design-analyzer-1`, `type-design-analyzer`, `engine/src/core/standalone-review.ts:84`
- **Claim:** `file: null` is accepted although no frozen-scope membership can be proven.
- **Fix:** reject null file locations at standalone transcript aggregation and persisted aggregate parsing while retaining nullable locations for non-standalone review flows.
- **Regression tests:** reject marker-derived and structured null-location standalone findings at both boundaries; update fixtures to use scoped paths.
- **Validation:** `cd engine && bunx vitest run tests/core/standalone-review.test.ts tests/handlers/helpers/standalone-review.test.ts`

### 6. Correct the wave-gate check count

- **Sources:**
  - `comment-analyzer-1`, `comment-analyzer`, `commands/wave-gate.md:430`
  - `comment-analyzer-2`, `comment-analyzer`, `README.md:310`
- **Claims:** orchestration docs say six checks although the helper evaluates seven; the README's list omits implementation proof.
- **Fix:** state seven checks consistently and list implementation proof first in the README.
- **Validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts tests/handlers/complete-wave-gate.test.ts`

## Accepted advisories

### 7. Use the architecture finalization model profile

- **Source:** `code-reviewer-3`, `code-reviewer`, `engine/src/core/panel-program.ts:252`
- **Fix:** add a distinct `architectureFinalization` semantic entry mapped to `architecture-finalize` and use it for `architecture:finalize`; assert request/profile parity.
- **Validation:** `cd engine && bunx vitest run tests/core/panel-program.test.ts tests/core/model-profiles.test.ts`

### 8. Bind reviewer identity to its immutable transcript slot

- **Source:** `code-reviewer-4`, `code-reviewer`, `engine/src/handlers/helpers/standalone-review.ts:118`
- **Fix:** require review entry N for agent A to reference exactly `reviewers/<N>-<A>.md`, in addition to inode/realpath uniqueness.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts`

### 9. Eliminate lstat-before-write symlink races

- **Source:** `silent-failure-hunter-3`, `silent-failure-hunter`, `engine/src/handlers/helpers/panel-run.ts:269`
- **Fix:** add a no-follow file writer that opens the checked target with `O_NOFOLLOW` and writes through the returned descriptor; route overwriting review-panel artifacts through it. Keep exclusive-create publication paths exclusive.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/review-panel.test.ts tests/handlers/helpers/standalone-review.test.ts`

### 10. Cover explicit model mismatch enforcement

- **Source:** `pr-test-analyzer-1`, `pr-test-analyzer`, `engine/src/core/model-profiles.ts:281`
- **Fix:** add focused tests for the exact requested model and a non-empty incorrect model on both harness bindings.
- **Validation:** `cd engine && bunx vitest run tests/core/model-profiles.test.ts`

### 11. Cover clean standalone finalization

- **Source:** `pr-test-analyzer-2`, `pr-test-analyzer`, `engine/src/core/standalone-review.ts:267`
- **Fix:** add helper-level zero-critical finalization coverage, including advisory serialization and rejection of unexpected panel outcomes.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts`

### 12. Align task-graph validation with the load boundary

- **Source:** `type-design-analyzer-2`, `type-design-analyzer`, `engine/src/handlers/helpers/validate-task-graph.ts:173`
- **Fix:** share the task execution-state parser used by `parseTaskGraph` with `validateFull(..., "state-file")`, while keeping decompose payload validation free of execution state.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts tests/state-manager.test.ts`

### 13. Require complete WaveGate records

- **Source:** `type-design-analyzer-3`, `type-design-analyzer`, `engine/src/state-manager.ts:84`
- **Fix:** require `impl_complete`, `tests_passed`, `reviews_complete`, and `blocked` at the disk parse boundary with their exact types; reject empty/partial gates.
- **Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/complete-wave-gate.test.ts`

### 14. Expand the wave-gate quick reference

- **Source:** `comment-analyzer-3`, `comment-analyzer`, `README.md:68`
- **Fix:** mention the mandatory refutation panel and advisory triage in the one-line quick reference.
- **Validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts`

### 15. Pass through non-Loom Pi subagents outside active orchestration

- **Source:** `architecture-tech-lead-1`, `architecture-tech-lead`, `pi/extension.ts:139`
- **Fix:** classify well-formed Pi batches as Loom-owned, external, or invalid; enforce Loom policy only for Loom-owned calls, pass external calls through when no active Loom graph exists, and reject mixed/unknown calls during active orchestration.
- **Validation:** `cd engine && bunx vitest run tests/core/model-profiles.test.ts tests/pi-extension-review-events.test.ts`

### 16. Consolidate the executable implementation roster

- **Source:** `architecture-tech-lead-2`, `architecture-tech-lead`, `engine/src/config.ts:248`
- **Fix:** include `java-test-agent` and `test-engineer` in `IMPL_AGENTS`/`KNOWN_AGENTS`; add a parity invariant proving every model-policy implementation agent is executable.
- **Validation:** `cd engine && bunx vitest run tests/core/model-profiles.test.ts tests/handlers/validate-task-graph.test.ts tests/panel-config.test.ts`

## Refuted Findings (not fixing)

None. No critical finding reached the two-of-three refutation threshold. The intent lens individually refuted `type-design-analyzer-1` and `comment-analyzer-2`, but both survived because reproduction and blast-radius upheld them; their minority reasoning remains in `result.json.panel.outcomes`.

## Full project validation

```bash
cd engine && bun run typecheck
cd engine && bun run test
```
