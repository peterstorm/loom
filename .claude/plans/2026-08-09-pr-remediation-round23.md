# PR Remediation — Standalone Review Round 23

## Context

- **Branch:** `feat/architecture-panel-mode-plan`
- **Scope:** exact 236-path immutable scope in `.claude/reviews/review-and-fix-runs/run.fskdYpEDAZ/result.json`
- **Standalone review run:** `.claude/reviews/review-and-fix-runs/run.fskdYpEDAZ`
- **Adjudication:** 3 critical findings survived the reproduction/intent/blast-radius panel; 0 critical findings were refuted.
- **Advisory triage:** all 5 advisories accepted because each identifies a concrete contract, validation, failure-signaling, or documentation defect.

## Surviving Critical Fixes

### C1 — Require a newer implementation generation before remediation can retire a packet-bound finding

- **Finding:** `code-reviewer-1`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/core/findings.ts:1099`
- **Claim:** A packet-bound critical can be marked resolved without any newer implementation generation.
- **Fix:** In the pure review-run finalizer, treat unanimous `resolved_by_remediation` assessments as eligible only when a packet-provenanced finding predates the current run generation; preserve legacy findings without provenance. Extend stored-resolution parsing so impossible same/older-generation remediation records fail at the load boundary. Add lifecycle and persisted-state regression tests.
- **Validation:** `cd engine && bunx vitest run tests/core/review-remediation-lifecycle.test.ts`

### C2 — Reject contradictory “resolved and identically re-emitted” reviewer evidence

- **Finding:** `code-reviewer-2`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/core/findings.ts:1134`
- **Claim:** A prior critical re-emitted as a new finding is silently discarded, so contradictory reviewer evidence can finalize the task as passed.
- **Fix:** Keep deliberate deduplication for unchanged findings assessed `still_present`, but reject one reviewer’s evidence when it marks a prior finding `resolved_by_remediation` and also emits the identical severity/file/line/claim. Route the rejected transition through the existing `evidence_capture_failed` state. Add both contradictory and legitimate-dedup regression tests.
- **Validation:** `cd engine && bunx vitest run tests/core/review-remediation-lifecycle.test.ts`

### C3 — Fail the hook when task-graph loading loses reviewer evidence

- **Finding:** `silent-failure-hunter-1`
- **Agent:** `silent-failure-hunter`
- **Source:** `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:96`
- **Claim:** store-reviewer-findings returns passthrough after failing to load the task graph, so reviewer evidence loss exits successfully.
- **Fix:** Preserve the reviewer-specific warning, but return the hook’s error result when the graph cannot be loaded. Update the executable handler regression to require failure instead of successful passthrough.
- **Validation:** `cd engine && bunx vitest run tests/handlers/subagent-stop/store-reviewer-findings.test.ts`

## Accepted Advisories

### A1 — Require both Machine Summary count markers

- **Finding:** `code-reviewer-3`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/core/review-output.ts:504`
- **Claim:** Reviewer output without the mandatory ADVISORY_COUNT marker is accepted as complete evidence and can finalize a truncated review as clean.
- **Fix:** Make either missing count marker produce `evidence-failed`, and make diagnostics name the exact missing marker(s). Update contract comments and parser tests.
- **Validation:** `cd engine && bunx vitest run tests/core/review-output-round14.test.ts tests/core/review-output.test.ts`

### A2 — Make incomplete live model calibration fail its caller

- **Finding:** `silent-failure-hunter-2`
- **Agent:** `silent-failure-hunter`
- **Source:** `scripts/run-model-calibration.ts:68`
- **Claim:** run-model-calibration exits successfully even when Pi failures make calibration cases not executed.
- **Fix:** Continue writing the complete diagnostic result file, print an executed/not-executed summary, and set a nonzero exit code whenever any case was not executed. Add an integration regression with a controlled failing `pi` executable.
- **Validation:** `cd engine && bunx vitest run tests/scripts/run-model-calibration.test.ts`

### A3 — Keep full task-graph validation aligned with mandatory loader fields

- **Finding:** `pr-test-analyzer-1`
- **Agent:** `pr-test-analyzer`
- **Source:** `engine/src/handlers/helpers/validate-task-graph.ts:131`
- **Claim:** validateFull lacks regression coverage for top-level StateManager fields, allowing an unloadable state file with no current_phase/phase_artifacts to validate successfully.
- **Fix:** For `state-file` validation, require and validate `current_phase` and `phase_artifacts` using the same phase vocabulary and artifact-value constraints as `parseTaskGraph`; leave `decompose-payload` intentionally free of persisted lifecycle fields. Add validator/loader parity regressions and update test fixtures to include valid persisted lifecycle fields.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts tests/handlers/validate-task-graph.property.test.ts tests/handlers/validate-model-bindings.test.ts tests/core/round15.test.ts`

### A4 — Enforce the review_error/review_status invariant at rest

- **Finding:** `type-design-analyzer-1`
- **Agent:** `type-design-analyzer`
- **Source:** `engine/src/core/findings.ts:779`
- **Claim:** parseTaskGraph accepts a task with review_status passed and a stale review_error, so the newly documented review_error/status invariant is not enforced at the load boundary.
- **Fix:** Validate `review_error` as a non-empty string when present and reject it outside `evidence_capture_failed`. Make `--fix` clear the inconsistent review record conservatively to `pending`; add parser, validator, and idempotent repair regressions.
- **Validation:** `cd engine && bunx vitest run tests/core/findings-round14.test.ts tests/handlers/validate-task-graph.test.ts`

### A5 — Correct PI_CODING_AGENT_DIR documentation

- **Finding:** `comment-analyzer-1`
- **Agent:** `comment-analyzer`
- **Source:** `docs/pi-usage.md:30`
- **Claim:** The paragraph understates PI_CODING_AGENT_DIR: the code uses it as the active base directory for generated Pi agents, not merely as a compatibility override.
- **Fix:** Document it as the active generated-resource base when set, with `$HOME/.pi/agent` as fallback.
- **Validation:** `rg -n "PI_CODING_AGENT_DIR" docs/pi-usage.md pi scripts`

## Refuted Findings (not fixing)

None. The authoritative `result.json.refuted_critical_findings` array is empty.

Panel dissent retained for audit: the `intent` lens voted to refute C2 because unchanged-prior deduplication is documented and tested, and voted to refute C3 because warning/passthrough behavior was explicitly tested. Both findings survived because reproduction and blast-radius upheld the concrete fail-open consequences. The fixes preserve legitimate deduplication and warnings while closing only the unsafe cases.

## Project Validation

1. `cd engine && npm run typecheck`
2. `cd engine && npm run test:unit`
3. `cd engine && npm run test:smoke`
4. `git diff --check`
