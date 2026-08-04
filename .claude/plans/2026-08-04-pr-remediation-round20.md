# PR Remediation — Standalone Review Round 20

## Review Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.rIURUTXnG5`
- **Exact scope:** the 217 ordered repo-relative paths in `run.rIURUTXnG5/result.json.scope`
- **Scope SHA-256:** `60092156c99aea4e1235bc22a56399e39a97a40c0326f7c4f7244d3c83eb8a9d` (SHA-256 of compact JSON array)
- **Diff reviewed:** `main...HEAD`, 34,123 additions / 2,576 deletions
- **Adjudication:** 6 critical entries survived; 0 were refuted; all 7 advisories are accepted for this remediation.

## Surviving Critical Fixes

### 1. Require current-wave spec-check evidence (two corroborating findings)

- **Sources:**
  - `code-reviewer-1` / `code-reviewer` — `engine/src/handlers/helpers/complete-wave-gate.ts:106` — “A wave with no spec_check record passes the spec-alignment gate and can advance without any spec-check evidence.”
  - `architecture-tech-lead-1` / `architecture-tech-lead` — `engine/src/handlers/helpers/complete-wave-gate.ts:105` — “Wave gate can advance without mandatory spec-check evidence because missing state.spec_check is treated as a passing skipped check.”
- **Minimal fix:** make absent `spec_check` a failed gate check with a current-wave rerun diagnostic; replace the test that codifies the skipped pass with a fail-closed regression.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/complete-wave-gate.test.ts`

### 2. Reject failed Pi subagent outputs before any authoritative state transition

- **Source:** `code-reviewer-2` / `code-reviewer` — `pi/extension.ts:423` — “Pi processes failed subagent results as successful completions, so failed review/spec outputs can become gate-authoritative state.”
- **Minimal fix:** parse `exitCode` and `stopReason`; after lifecycle cleanup, classify nonzero exits and `error`/`aborted` stops as failed. Never advance phases or consume review/spec evidence from them. For failed implementation results, remove only the resolved task from `executing_tasks` and leave task state pending. Continue processing healthy siblings.
- **Validation:** `cd engine && npm run test:unit -- tests/pi-extension-review-events.test.ts`

### 3. Treat an entire backgrounded pipeline as unfinished test evidence

- **Source:** `silent-failure-hunter-1` / `silent-failure-hunter` — `engine/src/machine/extract-evidence.ts:640` — “engine/src/machine/extract-evidence.ts:640 only treats a test segment as backgrounded when its immediate opAfter is "&", so backgrounded pipelines keep green reports and become trusted-pass.”
- **Minimal fix:** add a derived `isBackgrounded` classification fact by walking from the test segment through its pipe chain to the terminating operator; use it for exit attribution and report suppression. Add direct and downstream pipeline regressions.
- **Validation:** `cd engine && npm run test:unit -- tests/machine/extract-evidence.test.ts`

### 4. Make implementation execution an explicit spawn lifecycle

- **Source:** `type-design-analyzer-1` / `type-design-analyzer` — `engine/src/core/validate-task-execution.ts:115` — “validateTaskExecutionBatch records executing_tasks for any extracted task id without carrying an agent category that proves the spawn is an implementation agent.”
- **Minimal fix:** introduce a discriminated spawn-input constructor that distinguishes standalone, implementation, and non-implementation orchestration. `validateTaskExecutionBatch` may extract task ids and mutate baselines only from the implementation arm. Update Claude and Pi adapters and add reviewer/verifier regressions.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/pi-extension-review-events.test.ts`

### 5. Bypass active orchestration state for standalone review/refutation spawns

- **Source:** `architecture-tech-lead-2` / `architecture-tech-lead` — `engine/src/core/validate-phase-order.ts:165` — “Standalone and review/refutation spawns are routed through active task graph phase/task execution lifecycle despite the standalone marker contract.”
- **Minimal fix:** recognize the exact standalone marker before phase-order filesystem access, exclude standalone items from task execution registration and task-graph pointer creation, and short-circuit standalone Pi results before `StateManager.fromSession`. Preserve ordinary roster cleanup only.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/validate-phase-order.test.ts tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/pi-extension-review-events.test.ts`

## Accepted Advisories

### 6. Stable Pi chain roster identity

- **Source:** `code-reviewer-3` / `code-reviewer` — `pi/extension.ts:442` — “Pi chain steps containing {previous} cannot remove their reserved lifecycle roster entry because cleanup hashes the substituted task text.”
- **Minimal fix:** define roster identity from tool-call id, ordinal, and agent only; task text is mutable chain payload and must not participate. Add a `{previous}` cleanup regression.
- **Validation:** `cd engine && npm run test:unit -- tests/pi-extension-review-events.test.ts`

### 7. Recover findings nested in malformed refutation records

- **Source:** `code-reviewer-4` / `code-reviewer` — `engine/src/handlers/helpers/validate-task-graph.ts:315` — “validate-task-graph --fix deletes a recoverable finding when its refutation record is malformed.”
- **Minimal fix:** salvage each valid nested finding from an invalid refutation record back into active findings, de-duplicate/re-mint identity against active and valid-refuted sets, and report the lost refutation audit separately from recovered claims.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/validate-task-graph.test.ts`

### 8. Pin rollback after lifecycle reservation

- **Source:** `pr-test-analyzer-1` / `pr-test-analyzer` — `pi/extension.ts:291` — “Pi extension lacks an integration test that forces validateTaskExecutionBatch to block after lifecycle reservation and asserts rollback removes .active and .task_graph files.”
- **Minimal fix:** add an extension-level blocked mixed-wave spawn regression asserting state, `.active`, and `.task_graph` are unchanged/removed.
- **Validation:** `cd engine && npm run test:unit -- tests/pi-extension-review-events.test.ts`

### 9. Pin panel engine-operation failures

- **Source:** `pr-test-analyzer-2` / `pr-test-analyzer` — `engine/src/core/panel-program.ts:586` — “Panel program reducers lack regression tests for failed engine-operation outcomes blocking rather than advancing to spawn/tally stages.”
- **Minimal fix:** add architecture prepare/aggregate and refutation prepare/tally failed-operation tests asserting a `blocked` state/action with the original error.
- **Validation:** `cd engine && npm run test:unit -- tests/core/panel-program.test.ts`

### 10. Brand refutation program finding ids

- **Source:** `type-design-analyzer-2` / `type-design-analyzer` — `engine/src/core/panel-program.ts:189` — “RefutationProgramInput uses unbranded string[] for criticalFindingIds despite WaveFindingId existing, so task-local finding ids remain representable at the dispatch boundary.”
- **Minimal fix:** parse untrusted CLI strings into `WaveFindingId` at the handler boundary and carry `readonly WaveFindingId[]` through the refutation program state.
- **Validation:** `cd engine && npm run typecheck && npm run test:unit -- tests/core/panel-program.test.ts tests/handlers/helpers/quality-programs.test.ts`

### 11. Pair refutation lens and reason in the internal outcome type

- **Source:** `type-design-analyzer-3` / `type-design-analyzer` — `engine/src/core/standalone-review.ts:29` — “ParsedPanelOutcomes stores refutedBy and reasoning as parallel arrays, so their lockstep invariant is enforced only by parser checks and can be violated by any in-process construction.”
- **Minimal fix:** parse external parallel arrays into immutable `{ lens, reason }` pairs; derive external `refuted_by` and `reasoning` only during serialization.
- **Validation:** `cd engine && npm run typecheck && npm run test:unit -- tests/core/standalone-review.test.ts tests/handlers/helpers/standalone-review.test.ts`

### 12. Enforce Review Packet scope when wave findings enter state

- **Source:** `architecture-tech-lead-3` / `architecture-tech-lead` — `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:108` — “Wave review findings are stored and later briefed for refutation without validating their file locations against the Review Packet scope.”
- **Minimal fix:** add a pure scoped-resolution step over canonical `file_list ∪ files_modified`; located out-of-scope findings become `evidence_capture_failed`, while honestly unlocated findings remain valid. Use the same core function in Claude and Pi shells.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/subagent-stop/store-reviewer-findings.test.ts tests/pi-extension-review-events.test.ts tests/handlers/review-findings-parity.test.ts`

## Refuted Findings (not fixing)

None. The authoritative `result.json.refuted_critical_findings` array is empty.

## Full Validation

```bash
cd engine
npm run typecheck
npm test
cd ..
git diff --check
```
