# PR Remediation — Adjudicated Standalone Review

- **Branch:** `feat/architecture-panel-mode-plan`
- **Scope:** exact 232-path frozen scope in `.claude/reviews/review-and-fix-runs/run.7v3uRMq1mC/result.json`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.7v3uRMq1mC`
- **Diff reviewed:** `main...HEAD` — 232 files, +38,793/-2,814
- **Policy:** fix the three surviving critical findings and all 18 accepted advisories. Never fix the refuted critical.

## Surviving Critical Fixes

### 1. Bind retry invalidation to bytes changed during the current attempt

- **Source:** `code-reviewer-1` / `code-reviewer`
- **Location:** `engine/src/handlers/subagent-stop/update-task-status.ts:813`
- **Claim:** “Unobserved retry edits can retain stale trusted test and review evidence while implementation proof remains satisfied.”
- **Fix:** capture a fresh attempt baseline over declared artifacts plus previously attributed paths at every accepted implementation spawn while preserving the first declared-artifact proof baseline; parse both baselines at the state boundary; compare current bytes with the attempt baseline in both Claude and Pi completion paths; use that byte-change fact—not current transcript tool-call presence—to invalidate trusted test evidence, task review, spec-check evidence, and wave-gate status. Fall back conservatively for pre-field state.
- **Regression tests:** retry baseline refresh/preservation, unobserved current-attempt byte changes invalidating prior trusted evidence/review, and Pi/Claude parity.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/handlers/update-task-status.test.ts tests/pi-extension-review-events.test.ts`

### 2. Scope new-test evidence to the current task

- **Source:** `code-reviewer-2` / `code-reviewer`
- **Location:** `engine/src/handlers/subagent-stop/update-task-status.ts:495`
- **Claim:** “Repository-wide untracked tests can satisfy a different task's new-test proof obligation.”
- **Fix:** remove repository-wide untracked-test and whole-branch fallback collection from task proof. Diff only canonical paths attributed to the task (including its cumulative structured writes); empty attribution returns no new-test evidence. Keep tracked, staged, and attributed-untracked handling for those exact paths.
- **Regression tests:** a foreign untracked test is excluded; empty attribution fails closed; an attributed tracked or untracked test still proves the obligation.
- **Validation:** `cd engine && bunx vitest run tests/handlers/collect-diff.test.ts tests/handlers/update-task-status.test.ts`

### 3. Re-derive persisted proof obligations at the load boundary

- **Source:** `code-reviewer-3` / `code-reviewer`
- **Location:** `engine/src/state-manager.ts:227`
- **Claim:** “A satisfied persisted proof can omit obligations derived from the task's declared files and test policy.”
- **Fix:** derive expected obligations from `new_tests_required !== false` and `file_list`; whenever a persisted proof is present, require exact ordered equality with those derived obligations. Preserve status/proof-state lockstep without inventing proof for legacy proof-less records.
- **Regression tests:** reject omitted, foreign, and reordered obligations; accept exactly derived pending/satisfied proofs.
- **Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/core/proof-obligations.test.ts`

## Accepted Advisory Fixes

### A. Bind architecture consumers to one interview authority

- **Source:** `code-reviewer-4` / `code-reviewer`
- **Location:** `engine/src/handlers/helpers/panel-contract.ts:32`
- **Claim:** “Architecture panel agents can consume interview Markdown whose bytes no longer match the validated interview authority.”
- **Fix:** parse both run-scoped `interview.md` and `interview.json` on every post-interview operation and require the two canonical digests to match before manifest, criteria, verdict, or aggregate work proceeds.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/panel-contract.test.ts tests/core/panel-contract.test.ts`

### B. Surface Claude reviewer attribution failures

- **Source:** `code-reviewer-5` / `code-reviewer`
- **Location:** `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:70`
- **Claim:** “Reviewer prompt read and attribution failures are discarded by the SubagentStop dispatcher without surfacing their diagnostic.”
- **Fix:** write the same non-empty diagnostic to stderr before returning handler errors for unreadable trusted prompts and missing task identity; keep state untouched.
- **Validation:** `cd engine && bunx vitest run tests/handlers/subagent-stop/store-reviewer-findings.test.ts tests/handlers/subagent-stop/dispatch-resilience.test.ts`

### C. Make standalone review degradation and publication failures observable

- **Sources:**
  - `silent-failure-hunter-1` / `silent-failure-hunter` — `engine/src/core/standalone-review.ts:152`: malformed/partial findings-block status is discarded.
  - `silent-failure-hunter-2` / `silent-failure-hunter` — `engine/src/handlers/helpers/standalone-review.ts:323`: clean `result.json` publication is not staged atomically.
  - `silent-failure-hunter-3` / `silent-failure-hunter` — `engine/src/handlers/helpers/standalone-review.ts:247`: pending aggregate cleanup errors are swallowed.
- **Fix:** emit per-reviewer `reviewResolutionLog` degradation notes during aggregation without creating a second finding authority; publish clean results through a validated `.result.pending.json` plus rename; append cleanup-failure context to the original aggregate publication diagnostic.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts tests/core/standalone-review.test.ts`

### D. Close helper-boundary test gaps

- **Sources:**
  - `pr-test-analyzer-1` / `pr-test-analyzer` — `engine/src/handlers/helpers/panel-program.ts:81`: architecture dispatch lacks a real CLI regression test.
  - `pr-test-analyzer-2` / `pr-test-analyzer` — `engine/src/handlers/helpers/standalone-review.ts:56`: malformed `expected_agents` rosters lack helper tests.
- **Fix:** add CLI tests that verify architecture candidate fan-out waits for all slots before judge preparation and that duplicate/non-review expected agents are rejected before session publication.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/quality-programs.test.ts tests/handlers/helpers/standalone-review.test.ts`

### E. Make `--dismiss-all` actually dismiss advisories

- **Source:** `type-design-analyzer-2` / `type-design-analyzer`
- **Location:** `engine/src/handlers/helpers/store-review-findings.ts:93`
- **Claim:** “`--dismiss-all` preserves existing advisory findings while reporting that every finding was dismissed.”
- **Fix:** carry explicit dismissal intent into the pure override transform; preserve omitted advisories only for normal replacement, never for `--dismiss-all`; retain dismissed entries in `refuted_findings` with operator evidence.
- **Validation:** `cd engine && bunx vitest run tests/handlers/store-review-findings.test.ts`

### F. Correct user-facing workflow documentation

- **Sources:**
  - `comment-analyzer-1` and `comment-analyzer-5` / `comment-analyzer` — `README.md:117`: quick-start omits refutation/advisory handling.
  - `comment-analyzer-2` and `comment-analyzer-6` / `comment-analyzer` — `README.md:339`: template inventory omits panel/verifier templates.
  - `comment-analyzer-3` and `comment-analyzer-7` / `comment-analyzer` — `commands/review-and-fix.md:23`: advisory-only confirmation branch omitted.
  - `comment-analyzer-4` and `comment-analyzer-8` / `comment-analyzer` — `commands/wave-gate.md:244`: prose claims mandatory advisory enforcement that code does not perform.
- **Fix:** update each documented contract once while retaining every source finding id in this audit; distinguish critical gate enforcement from advisory reporting/triage.
- **Validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts tests/prose-contract-round14.test.ts tests/panel-templates.test.ts`

### G. Release Pi lifecycle state from trusted pre-spawn reservations

- **Source:** `architecture-tech-lead-1` / `architecture-tech-lead`
- **Location:** `pi/extension.ts:600`
- **Claim:** “Pi subagent lifecycle cleanup can leak active roster entries and executing_tasks when the subagent tool_result envelope is missing/malformed or a failed implementation result lacks a task id.”
- **Fix:** retain a per-`toolCallId` reservation containing session, ordinal, agent, roster id, classification, and trusted implementation task id. Release roster entries and implementation execution markers from that reservation before parsing untrusted result envelopes; use reserved task identity for result processing/failure cleanup; clear reservations on rollback and shutdown.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/pi-write-grant.test.ts tests/handlers/pi-stop-toctou.test.ts`

### H. Make task-graph repair total over arbitrary JSON task entries

- **Source:** `architecture-tech-lead-2` / `architecture-tech-lead`
- **Location:** `engine/src/handlers/helpers/validate-task-graph.ts:474`
- **Claim:** “Task graph repair casts untrusted task entries to records before parsing them, so malformed task elements crash the repair boundary instead of returning a typed refusal.”
- **Fix:** branch on each raw task entry before calling record-only repair logic; preserve malformed values for downstream validation and return explicit refusal errors rather than throwing. Add table/property-style arbitrary JSON coverage and no-write CLI evidence.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/repair-task-graph.test.ts tests/handlers/validate-task-graph.property.test.ts`

## Refuted Findings (not fixing)

### `type-design-analyzer-1` — bare `[]` parameterized-test row allegedly times out

- **Source:** `type-design-analyzer` / `engine/tests/handlers/validate-task-graph.test.ts:105`
- **Claim:** “A bare `[]` row is treated as zero arguments and times out instead of testing malformed array entries.”
- **Disposition:** refuted by 2 of 3 lenses; do not edit this test for this claim.
- **Reproduction — refuted:** “The installed Vitest runner computes `arrayOnlyCases` with `cases.every(Array.isArray)`; this mixed table contains `null`, `42`, and a string, so that value is false and Vitest invokes `handler(i)`, passing the bare `[]` as the callback's entry rather than spreading it into zero arguments.”
- **Intent — upheld:** “The test title and callback clearly intend `[]` to be passed as the malformed entry value. A bare parameterized row being expanded into zero arguments defeats that stated intent; no deliberate zero-argument behavior is documented.”
- **Test coverage — refuted:** “Vitest 3 computes `arrayOnlyCases` over the whole table; because `null`, `42`, and `task` are non-arrays, the mixed table passes every row as a scalar. The empty array therefore reaches `entry` as an empty array rather than becoming a zero-argument invocation or timing out.”

## Validation and Delivery

1. Focused commands listed under each remediation item.
2. `cd engine && bun run typecheck`
3. `cd engine && bun run test:unit`
4. `cd engine && bun run test:smoke`
5. Stage only the frozen scope, explicitly added regression/support paths, and this plan; verify the staged set exactly.
6. Commit on `feat/architecture-panel-mode-plan` and push without force.
