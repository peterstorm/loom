# PR Remediation — Adjudicated Review (Round 19)

- **Date:** 2026-08-04
- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone review run:** `.claude/reviews/review-and-fix-runs/run.poFAZgdxQ9`
- **Scope:** all and only the 212 repository-relative paths in `run.poFAZgdxQ9/result.json.scope`, in recorded order. The newline-delimited copy is `run.poFAZgdxQ9/scope.txt` with SHA-256 `a6f49dd3de0266e902a3ade8d8f88b6f0791f73655ab34896fdf6ab7d779be15`.
- **Diff reviewed:** 33,154 additions, 2,335 deletions, 0 binary paths against `main`.
- **Panel:** `reproduction`, `intent`, `security`; strict-majority threshold 2.
- **Adjudication:** 11/11 critical findings survived; 0 refuted; all 7 advisories accepted.

## Surviving Critical Findings — Mandatory Fixes

### 1. Rebind standalone results to physical reviewer evidence

- **Finding:** `code-reviewer-1`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/handlers/helpers/standalone-review.ts:253`
- **Claim:** A schema-valid hand-authored `aggregate.json` can be finalized without any reviewer transcripts, bypassing standalone review evidence.
- **Fix:** Extract one evidence-loading/reaggregation boundary that reloads immutable `session.json`, exact `review-input.json`, and distinct physical transcript slots; rederive the canonical aggregate and require byte/canonical equality with `aggregate.json`. Use it from clean finalization and from standalone panel brief/tally before either path can publish `result.json`.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts tests/handlers/helpers/review-panel.test.ts`

### 2. Fail closed on Pi spec-check count/findings drift

- **Finding:** `code-reviewer-2`
- **Agent:** `code-reviewer`
- **Source:** `pi/extension.ts:733`
- **Claim:** The Pi spec-check completion path accepts a zero declared count alongside parsed `CRITICAL:` lines, so those criticals do not block the wave gate.
- **Fix:** Move parsed spec-check reconciliation into a shared pure constructor used by Claude, manual, and Pi writers. A critical/high count mismatch produces the `EVIDENCE_CAPTURE_FAILED` state and never a gate-usable record.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/store-spec-check-findings.test.ts tests/handlers/helpers/store-spec-check.test.ts tests/pi-extension-review-events.test.ts`

### 3. Require an exact passing spec verdict

- **Finding:** `code-reviewer-3`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/handlers/helpers/complete-wave-gate.ts:115`
- **Claim:** `checkSpecAlignment` passes an `UNKNOWN` or `BLOCKED` verdict when `critical_count` is zero.
- **Fix:** Define the only passing captured state as `verdict === "PASSED" && critical_count === 0`; return an actionable failed gate for `UNKNOWN`, `BLOCKED`, and evidence-failure states.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/complete-wave-gate.test.ts`

### 4. Parse `current_wave` at the state boundary

- **Finding:** `code-reviewer-4`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/state-manager.ts:279`
- **Claim:** `parseTaskGraph` accepts a string `current_wave`, which bypasses the previous-wave review check for the matching numeric task wave.
- **Fix:** Parse optional `current_wave` as an integer greater than or equal to one before the blessed cast; mirror the rule in `validate-task-graph` and normalize invalid values in `--fix` without permitting coercive comparisons.
- **Regression validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/validate-task-graph.test.ts tests/handlers/pre-tool-use/validate-task-execution.test.ts`

### 5. Make empty execution inference failures loud

- **Finding:** `silent-failure-hunter-1`
- **Agent:** `silent-failure-hunter`
- **Source:** `pi/extension.ts:509`
- **Claim:** Pi silently drops an implementation subagent result without logging when task-ID extraction fails and `executing_tasks` is empty.
- **Fix:** Emit a dedicated warning for the zero-executing-task case before clearing state and continuing; retain the existing one-task inference and multi-task ambiguity behavior.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 6. Conserve singleton malformed findings during repair

- **Finding:** `silent-failure-hunter-2`
- **Agent:** `silent-failure-hunter`
- **Source:** `engine/src/handlers/helpers/validate-task-graph.ts:312`
- **Claim:** `validate-task-graph --fix` silently deletes a non-array `task.findings` value that can contain a critical claim because repair only counts and salvages arrays.
- **Fix:** Treat any present non-array findings value as one malformed input entry, feed it through the same claim-salvage path, include it in dropped-data accounting when unsalvageable, and keep the repaired views derived from the recovered finding.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts tests/handlers/validate-task-graph.property.test.ts`

### 7. Lock in the review-panel TOCTOU defense

- **Finding:** `pr-test-analyzer-1`
- **Agent:** `pr-test-analyzer`
- **Source:** `engine/src/handlers/helpers/review-panel.ts:514`
- **Claim:** No test changes task state between the pre-tally replay check and locked `StateManager.update`, so the in-lock guard can be removed without failing tests.
- **Fix:** Extract a narrow state-update port around the wave-tally commit and use an in-memory fake that presents clean preflight state but refuted state to the locked transform; assert the inner replay guard rejects and no finding outcomes are applied.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/helpers/review-panel.test.ts`

### 8. Enforce `SpecCheck` lockstep on load

- **Finding:** `type-design-analyzer-1`
- **Agent:** `type-design-analyzer`
- **Source:** `engine/src/state-manager.ts:129`
- **Claim:** `specCheckError` accepts `critical_count: 0` with non-empty `critical_findings`, allowing the wave gate to pass stored critical evidence.
- **Fix:** Replace partial shape checks with a smart parser for captured versus evidence-failed spec-check states. Captured records require finite positive wave, closed verdict, non-negative integer counts, string finding arrays, and count/array equality for critical and high findings; failed records must not carry usable counts.
- **Regression validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/complete-wave-gate.test.ts`

### 9. Route Pi through the shared spec-check constructor

- **Finding:** `type-design-analyzer-2`
- **Agent:** `type-design-analyzer`
- **Source:** `pi/extension.ts:746`
- **Claim:** Pi stores `findings.criticalCount` and `findings.critical` without the mismatch guard used by Claude and manual handlers.
- **Fix:** Remove Pi's direct `SpecCheck` object construction; call the shared reconciliation constructor and persist either its captured state or explicit evidence-failure state, setting the wave blocked flag only from a reconciled positive critical count.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/handlers/store-spec-check-findings.test.ts`

### 10. Correct the architecture handoff command

- **Finding:** `comment-analyzer-1`
- **Agent:** `comment-analyzer`
- **Source:** `commands/specify.md:4`
- **Claim:** The document tells users to invoke `/architecture-tech-lead`, but no command with that name exists.
- **Fix:** Name the architecture-tech-lead skill rather than a nonexistent command and document Pi's concrete `/skill:architecture-tech-lead` invocation without implying a shared slash-command file.
- **Regression validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts tests/runtime-resource-portability.test.ts tests/pi-resources.test.ts`

### 11. Detect Pi from its process marker, not an optional directory override

- **Finding:** `architecture-tech-lead-1`
- **Agent:** `architecture-tech-lead`
- **Source:** `pi/extension.ts:65` (root cause in `engine/src/config.ts:544`)
- **Claim:** A default Pi install without `PI_CODING_AGENT_DIR` resolves Loom state and linter paths as Claude paths.
- **Fix:** Make harness detection recognize `PI_CODING_AGENT` as authoritative while retaining `PI_CODING_AGENT_DIR` compatibility; add isolated-process tests proving default Pi state/rule paths and explicit override behavior.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-imports.test.ts tests/runtime-resource-portability.test.ts tests/pi-extension-review-events.test.ts`

## Accepted Advisories

### A1. Report array-argument git failures

- **Finding:** `silent-failure-hunter-3`
- **Agent:** `silent-failure-hunter`
- **Source:** `engine/src/utils/git.ts:40`
- **Claim:** `execArgs` turns git failures into an empty string without logging command or stderr.
- **Fix:** Preserve the current empty-result compatibility at this shell boundary but emit a non-empty diagnostic containing the safe argument vector and available stderr/status.
- **Regression validation:** `cd engine && bunx vitest run tests/utils/git.test.ts`

### A2. Prove Pi per-result error isolation

- **Finding:** `pr-test-analyzer-2`
- **Agent:** `pr-test-analyzer`
- **Source:** `pi/extension.ts:393`
- **Claim:** No test proves a throwing first Pi subagent result cannot prevent a later result from updating state.
- **Fix:** Add a real extension-event regression with two results: force the first through a deterministic processing failure, then assert the second persists its review/task state and stderr names the isolated failure.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### A3. Prove Pi `isError` cannot become a passing test

- **Finding:** `pr-test-analyzer-3`
- **Agent:** `pr-test-analyzer`
- **Source:** `pi/transcript-adapter.ts:50`
- **Claim:** No test proves a Pi Bash `toolResult` with `isError=true` stays failing even when output looks like a pass.
- **Fix:** Add a paired Bash call/result example whose text contains pass-looking evidence but whose result has `isError=true`; assert `piStructuredTestResult` returns `passed: false`.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-test-evidence.test.ts`

### A4. Complete README architecture-review triggers

- **Finding:** `comment-analyzer-2`
- **Agent:** `comment-analyzer`
- **Source:** `README.md:337`
- **Claim:** The README describes only the large-diff trigger.
- **Fix:** Align the summary with the canonical explicit `architecture`/`all`, size, path-count, and new service/package/migration triggers.
- **Regression validation:** `cd engine && bunx vitest run tests/review-agent-contract.test.ts tests/runbook-contract.test.ts`

### A5. Complete architecture agent trigger prose

- **Finding:** `comment-analyzer-3`
- **Agent:** `comment-analyzer`
- **Source:** `agents/architecture-tech-lead.md:5`
- **Claim:** Agent frontmatter repeats the truncated large-diff-only trigger.
- **Fix:** Use the same concise canonical trigger set as the review workflow, then regenerate Pi agent definitions.
- **Regression validation:** `cd engine && bunx vitest run tests/review-agent-contract.test.ts tests/utils/render-pi-agent.test.ts`

### A6. Make Pi subagent startup transactional

- **Finding:** `architecture-tech-lead-2`
- **Agent:** `architecture-tech-lead`
- **Source:** `pi/extension.ts:217`
- **Claim:** Task execution state is written before lifecycle roster validation/writes can fail, leaving ghost execution state when spawn is refused.
- **Fix:** Parse the session and reserve all unique roster entries/task-graph pointer before task-state mutation; if reservation or task validation fails, remove exactly the entries reserved by this call. After validation succeeds, no lifecycle filesystem operation remains that can refuse the spawn.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/handlers/pre-tool-use/validate-task-execution.test.ts`

### A7. Give same-type Pi parallel spawns distinct roster identity

- **Finding:** `architecture-tech-lead-3`
- **Agent:** `architecture-tech-lead`
- **Source:** `pi/extension.ts:250`
- **Claim:** Same-type parallel agents share one roster identity.
- **Fix:** Derive a deterministic roster ID from the subagent tool-call identity, batch ordinal, and agent type; reserve/remove with the session-registry port rather than append/unlink. The tool-result path derives the same ID per result, allowing panel batches with repeated verifier/designer types while preserving per-spawn roster entries.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/machine/ledger.test.ts`

## Refuted Findings (not fixing)

None. The tally published `refuted_critical_findings: []`.

## Validation and Delivery

1. Targeted regression commands listed above.
2. Typecheck: `cd engine && npm run typecheck`.
3. Full unit and smoke suite: `cd engine && npm test`.
4. Regenerate Pi agents after agent-frontmatter edits: `./scripts/sync-pi-agents.sh`; verify generated definitions remain in sync.
5. Stage only the audited remediation path set plus this plan; verify staged paths exactly before commit.
6. Commit on `feat/architecture-panel-mode-plan` and push without force.
