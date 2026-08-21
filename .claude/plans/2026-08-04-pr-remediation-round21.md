# PR Remediation — Standalone Review Round 21

## Review Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Scope:** immutable 218-path scope in `.claude/reviews/review-and-fix-runs/run.4esF5sJNJw/review-plan.json`
- **Diff reviewed:** `main...HEAD` plus staged/unstaged changes; 34,819 additions, 2,587 deletions
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.4esF5sJNJw`
- **Adjudication:** 8 critical findings survived; 0 critical findings were refuted; all 10 advisories are accepted (two pairs overlap and share fixes).

## Surviving Critical Fixes

### 1. Content-bind every review-panel artifact

- **Finding:** `code-reviewer-1`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/handlers/helpers/review-panel.ts:366`
- **Claim:** Review-panel artifacts are checked only for file shape, so tampering brief/item content can make verifiers refute a different claim under the original finding ID.
- **Fix:** At every manifest-scoped operation, rederive the canonical brief from the current wave state or evidence-bound standalone aggregate without crossing standalone runs into task state. Compare canonical `brief.json`, `brief.md`, and every per-finding JSON artifact byte-for-byte before returning lenses, validating a verdict, or tallying. Preserve the existing path/symlink/surplus checks.
- **Regression validation:** `cd engine && npm run test:unit -- tests/handlers/helpers/review-panel.test.ts tests/handlers/helpers/standalone-review.test.ts`

### 2. Validate standalone outcome claims against the panel-normalized brief

- **Finding:** `code-reviewer-2`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/core/standalone-review.ts:241`
- **Claim:** Standalone tally rejects every brace-bearing critical because it compares the sanitized panel claim with the unsanitized aggregate claim.
- **Fix:** Pass the canonical panel finding set into the standalone outcome parser, prove its IDs exactly cover aggregate criticals, and compare tally claims with the panel-normalized claims. Continue using finding identity to publish the original aggregate finding in `result.json`.
- **Regression validation:** `cd engine && npm run test:unit -- tests/core/review-panel.test.ts tests/handlers/helpers/standalone-review.test.ts`

### 3. Preserve singleton refutation records during `--fix`

- **Finding:** `code-reviewer-3`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/handlers/helpers/validate-task-graph.ts:319`
- **Claim:** `validate-task-graph --fix` silently deletes a singleton `refuted_findings` record instead of preserving its audit or reactivating its nested finding.
- **Fix:** Normalize a present non-array refutation container to one repair input before parsing, salvage, dropped-count calculation, and ID collision handling. Preserve a valid singleton as a one-element array; reactivate a valid nested finding when only its envelope is malformed.
- **Regression validation:** `cd engine && npm run test:unit -- tests/handlers/validate-task-graph.test.ts`

### 4. Reject absent untracked review-packet paths

- **Finding:** `silent-failure-hunter-1`
- **Agent:** `silent-failure-hunter`
- **Source:** `engine/src/handlers/helpers/review-packet.ts:65`
- **Claim:** review-packet encodes absent untracked scoped paths as valid empty artifacts.
- **Fix:** Distinguish tracked deletion from a path that is neither tracked nor present. Reject the latter before constructing the packet; retain `postimage: null` only for tracked deletions.
- **Regression validation:** `cd engine && npm run test:unit -- tests/handlers/helpers/quality-programs.test.ts`

### 5. Fail loudly for unknown task IDs at implementation completion

- **Finding:** `silent-failure-hunter-2`
- **Agent:** `silent-failure-hunter`
- **Source:** `engine/src/handlers/subagent-stop/update-task-status.ts:606`
- **Claim:** update-task-status silently discards implementation evidence when the extracted task id is not in the graph.
- **Fix:** Return a contextual hook error naming the unknown task ID and known IDs, explicitly state that evidence was not stored, and avoid presenting the completion as a successful passthrough.
- **Regression validation:** `cd engine && npm run test:unit -- tests/handlers/update-task-status.test.ts`

### 6. Enforce unique task identity and make the regression assertion real

- **Finding:** `pr-test-analyzer-1`
- **Agent:** `pr-test-analyzer`
- **Source:** `engine/tests/handlers/validate-task-graph.property.test.ts:203`
- **Claim:** The duplicate task-id regression test is a false positive while `validateFull` accepts two `T1` tasks.
- **Fix:** Parse object task entries before collecting IDs, reject duplicate non-empty string IDs, and replace the placeholder assertion with an explicit failure/error assertion.
- **Regression validation:** `cd engine && npm run test:unit -- tests/handlers/validate-task-graph.test.ts tests/handlers/validate-task-graph.property.test.ts`

### 7. Parse top-level TaskGraph fields before the blessed cast

- **Finding:** `type-design-analyzer-1`
- **Agent:** `type-design-analyzer`
- **Source:** `engine/src/state-manager.ts:262`
- **Claim:** parseTaskGraph only checks that phase_artifacts exists before casting to TaskGraph, so a non-object phase_artifacts value can load and later crash typed phase-order code.
- **Fix:** Require `phase_artifacts` to be a non-array object whose keys are known phases and values are strings. Also prove the adjacent asserted top-level fields (`skipped_phases`, nullable path fields, execution IDs, and optional GitHub metadata) before the single cast.
- **Regression validation:** `cd engine && npm run test:unit -- tests/state-manager.test.ts`

### 8. Rebind session state to the frozen review plan

- **Finding:** `architecture-tech-lead-1`
- **Agent:** `architecture-tech-lead`
- **Source:** `engine/src/handlers/helpers/standalone-review.ts:208`
- **Claim:** Standalone aggregation/finalization trusts mutable session.json as the run authority instead of re-binding to review-plan.json.
- **Fix:** Load and parse both `review-plan.json` and `session.json` at every aggregation/evidence-finalization boundary, require their canonical run scope and expected-agent roster to match exactly, and only then derive transcript evidence.
- **Regression validation:** `cd engine && npm run test:unit -- tests/handlers/helpers/standalone-review.test.ts`

## Accepted Advisories

### 9. Repair malformed empty-equivalent evidence-failure arrays

- **Finding:** `code-reviewer-4`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/handlers/helpers/validate-task-graph.ts:408`
- **Claim:** `--fix` leaves invalid arrays such as `[42]` or `[""]` in place.
- **Fix:** Make `wellFormed` require every raw entry to be a unique non-empty string; otherwise clear the irreconstructible review record through the existing fail-closed repair branch.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/validate-task-graph.test.ts`

### 10. Write the documented wave-summary fallback

- **Finding:** `silent-failure-hunter-3`
- **Agent:** `silent-failure-hunter`
- **Source:** `engine/src/handlers/helpers/complete-wave-gate.ts:470`
- **Claim:** A failed GitHub comment emits only a transient warning.
- **Fix:** On comment failure, persist the already-generated summary at `.claude/reviews/wave-{N}-review.md` and report the durable path; report a second warning if fallback persistence itself fails.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/complete-wave-gate.test.ts`

### 11. Return validation errors for malformed task entries

- **Findings:** `pr-test-analyzer-2`, `type-design-analyzer-2`
- **Agents:** `pr-test-analyzer`, `type-design-analyzer`
- **Source:** `engine/src/handlers/helpers/validate-task-graph.ts:142`
- **Claims:** `validateFull` reads task IDs before proving each `tasks[]` entry is an object and can throw on `[null]` or primitive entries.
- **Fix:** Build a guarded task-record view, emit `Task [i]: must be an object`, continue validating valid siblings, and use only guarded records for dependencies, waves, and ADR checks.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/validate-task-graph.test.ts`

### 12. Reject stale `error` on captured spec checks

- **Finding:** `type-design-analyzer-3`
- **Agent:** `type-design-analyzer`
- **Source:** `engine/src/core/spec-check.ts:182`
- **Claim:** parseStoredSpecCheck accepts a captured SpecCheck with an error field even though the ADT declares it impossible.
- **Fix:** Reject `error` on every non-`EVIDENCE_CAPTURE_FAILED` verdict before constructing the captured arm.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/helpers/store-spec-check.test.ts tests/state-manager.test.ts`

### 13. Use the WaveFindingId smart constructor at the JSON boundary

- **Finding:** `type-design-analyzer-4`
- **Agent:** `type-design-analyzer`
- **Source:** `engine/src/core/review-panel.ts:410`
- **Claim:** parseBriefFindingEntry brands any task-prefixed string instead of applying the exact external grammar.
- **Fix:** Parse IDs with `parseWaveFindingId`, then cross-check the parsed task prefix before constructing `BriefFinding`.
- **Validation:** `cd engine && npm run test:unit -- tests/core/review-panel.test.ts`

### 14. Make lens-count prose explicit

- **Findings:** `comment-analyzer-1`, `comment-analyzer-2`
- **Agent:** `comment-analyzer`
- **Sources:** `references/review-lenses.md:16` and locationless Machine Summary duplicate
- **Claims:** “capped at 5” is ambiguous because executable configuration rejects out-of-range counts.
- **Fix:** State that the accepted panel size is 2–5 and values outside that range are rejected.
- **Validation:** `cd engine && npm run test:unit -- tests/review-panel-templates.test.ts tests/runbook-contract.test.ts`

### 15. Require implementation spawns to bind to existing tasks

- **Finding:** `architecture-tech-lead-2`
- **Agent:** `architecture-tech-lead`
- **Source:** `engine/src/core/validate-task-execution.ts:111`
- **Claim:** Implementation-agent spawns without an extractable existing task ID bypass lifecycle baseline/executing-state registration.
- **Fix:** When a task graph is active, block each implementation spawn that has no extractable task ID, block foreign IDs, and reject duplicate task bindings in one batch. Preserve the standalone marker exemption.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/pi-extension-review-events.test.ts`

### 16. Share Claude agent-definition resolution

- **Finding:** `architecture-tech-lead-3`
- **Agent:** `architecture-tech-lead`
- **Source:** `engine/src/handlers/pre-tool-use/validate-agent-skill.ts:63`
- **Claim:** Model and skill gates search different path sets, allowing checkout agents to skip skill enforcement.
- **Fix:** Extract one Claude agent-definition resolver used by both gates, including the development checkout `./agents` path, while leaving Pi generated-agent resolution separate.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/pre-tool-use/validate-agent-skill.test.ts tests/handlers/pre-tool-use/spawn-gate-tool-names.test.ts`

## Refuted Findings (not fixing)

No critical findings were refuted. The panel retained all eight critical findings. Two surviving findings received one refutation vote each, recorded in `result.json.panel.outcomes`, but neither met the two-lens threshold:

- `silent-failure-hunter-1` — `intent` observed that null postimages deliberately represent absence/deletion; `reproduction` still demonstrated the absent-untracked path and the finding survived.
- `architecture-tech-lead-1` — `intent` observed that `session.json` is documented as immutable authority; `reproduction` and `security` demonstrated that no content binding enforces that claim and the finding survived.

## Validation and Delivery

Completed validation:

1. Focused regression suites passed.
2. `cd engine && npm run typecheck` — passed.
3. `cd engine && npm run test:unit` — passed: 131 files, 2,948 tests.
4. `cd engine && npm run test:smoke` — passed: panel mode 22/22, review panel 19/19, standalone review, and Pi resources.
5. `git diff --check` — passed.

Delivery: stage only the audited remediation path set plus this plan, verify the staged allowlist exactly, commit, and push without force.
