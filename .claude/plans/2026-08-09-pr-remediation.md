# Adjudicated PR Remediation — 2026-08-09

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.10Gouk8CGR`
- **Exact frozen scope:** the 234-path `result.json.scope` array in the run above (the immutable union of `main...HEAD`, staged, unstaged, and untracked paths recorded by `session.json`)
- **Diff reviewed:** 40,712 additions, 2,913 deletions; TypeScript, Markdown, shell, JSON, and extensionless files
- **Panel:** `reproduction`, `intent`, `blast-radius`; strict-majority threshold 2
- **Adjudication:** 8 canonical criticals → 7 surviving, 1 refuted; 8 advisories

## Remediation order

### 1. Preserve task-graph authority at implementation-spawn time

- **Source:** `type-design-analyzer-1` (`type-design-analyzer`), `engine/src/core/validate-task-execution.ts:200`
- **Claim:** `validateTaskExecutionBatch` uses import-time `TASK_GRAPH_PATH`, so a graph selected later through `LOOM_STATE_PATH` can be bypassed.
- **Minimal fix:** resolve `taskGraphPath()` once at the shell decision boundary and use that same concrete path for existence and `StateManager` creation.
- **Regression:** add a shell-level test that imports first, sets `LOOM_STATE_PATH` afterward, and proves an active graph still blocks an unbound implementation spawn.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-task-execution.test.ts`

### 2. Conserve valid findings inside malformed remediation records

- **Source:** `code-reviewer-2` (`code-reviewer`), `engine/src/handlers/helpers/validate-task-graph.ts:355`
- **Claim:** `--fix` drops malformed `resolved_findings` records without restoring their valid nested findings.
- **Minimal fix:** add the resolution analogue of `salvageFindingsFromMalformedRefutations`, return recovered nested findings to the active set, include them in collision repair and review-run invalidation, and report both recovery and lost audit data.
- **Regression:** repair a malformed resolution twice and prove the nested critical remains active, the graph loads, and the repair is idempotent.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts tests/core/review-remediation-lifecycle.test.ts`

### 3. Make remediation review finalization roster-ordered and legacy-safe

- **Sources:**
  - `code-reviewer-1` (`code-reviewer`), `engine/src/core/findings.ts:1070`
  - `pr-test-analyzer-1` (`pr-test-analyzer`), `engine/src/core/findings.ts:1052`
- **Claims:** reverse reviewer completion writes an unloadable resolution; legacy view-only criticals are omitted from the packet snapshot and can disappear.
- **Minimal fix:** recover view-only findings into the authoritative identity array before starting a run; during finalization, construct resolution assessments by iterating `expected_agents` and looking up each agent’s evidence.
- **Regressions:** complete reviewers in reverse order and parse the resulting graph; start from a view-only legacy critical and prove it remains active unless every reviewer explicitly resolves it.
- **Validation:** `cd engine && bunx vitest run tests/core/review-remediation-lifecycle.test.ts`

### 4. Fail closed on ambiguous or stale lifecycle evidence

- **Sources:**
  - `code-reviewer-3` (`code-reviewer`), `engine/src/core/review-output.ts:527`
  - `code-reviewer-4` (`code-reviewer`), `engine/src/core/review-output.ts:624`
- **Claims:** duplicate `review_lifecycle` blocks use last-block-wins; markerless late packet output can fall into legacy merge after run invalidation.
- **Minimal fix:** require exactly one lifecycle block for every packet-bound review, including an explicit empty array when no prior findings exist; pass current generation authority into task review resolution and treat markerless output for a generation-aware task as stale rather than legacy.
- **Regressions:** duplicate lifecycle blocks fail evidence capture; no-prior packets require an empty lifecycle block; markerless late output after invalidation cannot mutate findings.
- **Validation:** `cd engine && bunx vitest run tests/core/review-remediation-lifecycle.test.ts tests/handlers/review-findings-parity.test.ts`

### 5. Surface atomic evidence-persistence rejection

- **Source:** `silent-failure-hunter-1` (`silent-failure-hunter`), `engine/src/core/review-output.ts:702`
- **Claim:** a failed `recordReviewRunEvidence` transition returns the unchanged task while callers log evidence as staged.
- **Minimal fix:** preserve active-run transition failures as `evidence_capture_failed` state with agent and reason, while treating already-stored or superseded packet results as stale no-ops; make both Claude and Pi shells log the post-update outcome rather than unconditional staging success.
- **Regression:** simulate stale-snapshot application against current task state and prove failures are either explicitly ignored as stale or stored/logged as evidence failures—never reported as staged.
- **Validation:** `cd engine && bunx vitest run tests/core/review-remediation-lifecycle.test.ts tests/handlers/review-findings-parity.test.ts tests/pi-extension-review-events.test.ts`

## Accepted advisories

### 6. Suppress exact prior-finding re-emission

- **Source:** `code-reviewer-5` (`code-reviewer`), `engine/src/core/findings.ts:1093`
- **Fix:** when activating `new_findings`, exclude exact matches of the run’s prior finding identity tuple (severity, claim, file, line), so `still_present` plus re-emission cannot mint duplicates.
- **Validation:** lifecycle regression plus `cd engine && bunx vitest run tests/core/review-remediation-lifecycle.test.ts`.

### 7. Require lifecycle evidence even for an empty prior set

- **Sources:** `silent-failure-hunter-2` and `pr-test-analyzer-2`, `engine/src/core/review-output.ts:529-530`
- **Fix:** covered by item 4; require one `review_lifecycle` block containing `prior_findings: []`.
- **Validation:** lifecycle regression in `tests/core/review-remediation-lifecycle.test.ts`.

### 8. Preserve cleanup failure diagnostics

- **Sources:**
  - `silent-failure-hunter-3`, `engine/src/handlers/helpers/review-packet.ts:195`
  - `silent-failure-hunter-4`, `engine/src/handlers/helpers/review-panel.ts:554`
- **Fix:** retain the original failure and append any packet/pending-result cleanup failure to the returned diagnostic.
- **Validation:** focused helper tests for both cleanup branches, then their full helper suites.

### 9. Correct conditional panel documentation

- **Source:** `comment-analyzer-2`, `README.md:331`
- **Fix:** state that `/review-and-fix` runs the refutation panel only when canonical criticals exist.
- **Validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts`.

### 10. Unify immutable review-scope identity at parse boundaries

- **Source:** `architecture-tech-lead-1`, `engine/src/core/standalone-review.ts:58`
- **Fix:** use the canonical Review Packet path parser for standalone scopes, standalone finding locations, and wave finding scope checks; reject aliases instead of comparing ad hoc normalized spellings. Preserve the existing `files_modified` load shape because Pi/Claude transcript APIs legitimately supply absolute in-repository paths; packet and filesystem boundaries already canonicalize those through `canonicalRepositoryPaths`, and the real CLI regression explicitly protects that contract.
- **Validation:** path alias/traversal/duplicate regressions in standalone-review, review-packet, and review-output tests, plus the real CLI absolute-path packet regression.

## Deferred advisory

- **`architecture-tech-lead-2` (`pi/extension.ts:158`):** splitting the Pi extension god-object is a broad architectural refactor unrelated to the minimal correctness fixes. Defer rather than mixing a high-churn extraction into this remediation commit; existing Pi parity and event tests remain mandatory validation for touched Pi behavior.

## Refuted Findings (not fixing)

### `comment-analyzer-1` — bold-only Machine Summary comment

- **Original:** `comment-analyzer`, `engine/src/core/review-output.ts:434` — “The comment claims bold `**Machine Summary**` headings do not match `parseMachineSummary`, but the regex accepts that form.”
- **Reproduction refutation:** `parseMachineSummary`’s first alternative requires two to four leading hashes, and its second requires `MACHINE_SUMMARY` at line start. A bold-only heading satisfies neither, so the comment is correct.
- **Intent refutation:** the regex accepts hash-prefixed headings with optional bolding or a bare machine-summary token; it intentionally does not accept a line beginning with `**Machine Summary**`.
- **Panel evidence:** `blast-radius` upheld, but two of three lenses refuted; threshold 2 was met. **Do not edit this comment.**

## Audited remediation path set

Initialize from all 234 `result.json.scope` paths. Expected touched subset (plus this plan) is:

- `engine/src/config.ts` only if imports/exports require adjustment
- `engine/src/core/findings.ts`
- `engine/src/core/review-output.ts`
- `engine/src/core/standalone-review.ts`
- `engine/src/core/validate-task-execution.ts`
- `engine/src/handlers/helpers/review-packet.ts`
- `engine/src/handlers/helpers/review-panel.ts`
- `engine/src/handlers/helpers/validate-task-graph.ts`
- `engine/src/handlers/subagent-stop/store-reviewer-findings.ts`
- `engine/src/state-manager.ts`
- `pi/extension.ts`
- `README.md`
- focused existing/new test files under `engine/tests/`
- `.claude/plans/2026-08-09-pr-remediation.md`

No run evidence under `.claude/reviews/review-and-fix-runs/` may be staged.

## Project validation

Run in priority order:

1. Focused Vitest files for each item above.
2. `cd engine && npm run typecheck`
3. `cd engine && npm run test:unit`
4. `cd engine && npm test` (unit + all smoke suites)
5. `bash -n scripts/*.sh`

Only after all validation is green: stage the audited path set plus this plan, verify the staged names exactly, commit, and push without force.

---

# Adjudicated PR Remediation — Standalone Run `run.mAvoxjxrya`

## Review authority

- **Date:** 2026-08-09
- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.mAvoxjxrya`
- **Exact frozen scope:** the 244-path `result.json.scope` array in that run, initialized as the audited remediation allowlist in `audited-remediation-paths.json`
- **Diff reviewed:** 43,876 additions, 2,981 deletions; 153 TypeScript, 80 Markdown, 5 shell, 4 JSON, and 2 gitignore files
- **Panel:** `reproduction`, `intent`, `security`; strict-majority threshold 2
- **Adjudication:** 3 canonical criticals → 3 surviving, 0 refuted; 10 advisories → 7 accepted, 3 deferred

## Surviving critical fixes

### 1. Block wave completion while a wave task is executing

- **Source:** `code-reviewer-1` (`code-reviewer`), `engine/src/handlers/helpers/complete-wave-gate.ts:306`
- **Claim:** the wave gate can pass and mark a task completed while that task remains in `executing_tasks`.
- **Minimal fix:** add a pure gate check that fails when the selected wave task IDs intersect `state.executing_tasks`, before proof/review checks can produce a pass. Keep state mutation under the existing locked gate update.
- **Regression:** prove an otherwise passing graph with an active wave task fails closed and that an executing task from another wave does not block the selected wave.
- **Validation:** `cd engine && bunx vitest run tests/handlers/complete-wave-gate.test.ts`.

### 2. Make spawn rollback revoke capabilities despite roster cleanup failures

- **Source:** `silent-failure-hunter-1` (`silent-failure-hunter`), `pi/extension.ts:366`
- **Claim:** `rollbackLifecycle` awaits active-roster cleanup before revoking Pi write grants, so a cleanup exception can leave a blocked spawn with a live grant.
- **Minimal fix:** perform every rollback action independently, revoke grants and restore prompts before/independently of roster and pointer cleanup, collect all cleanup diagnostics, and keep the spawn fail-closed.
- **Regression:** force roster removal failure after grant injection and prove the call is blocked, the prompt is restored, and the grant is unusable/removed.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/pi-write-grant.test.ts`.

### 3. Make session shutdown revoke capabilities in a guaranteed cleanup path

- **Source:** `silent-failure-hunter-2` (`silent-failure-hunter`), `pi/extension.ts:535`
- **Claim:** active-roster or pointer cleanup can throw before `issuedWriteGrants` are revoked.
- **Minimal fix:** revoke and clear every issued grant in a `finally`-equivalent path; isolate child-binding, pointer, rejected-session, and reservation cleanup failures so all cleanup steps run and emit diagnostics.
- **Regression:** force active-roster cleanup failure during shutdown and prove outstanding nested grants are still revoked and subsequent reservations are attempted.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/pi-write-grant.test.ts`.

## Accepted advisories

### 4. Fail closed on malformed Pi spec-check messages

- **Source:** `code-reviewer-2` (`code-reviewer`), `pi/extension.ts:1233`
- **Claim:** malformed successful Pi messages can throw before replacing a stale same-wave passing `spec_check`.
- **Minimal fix:** parse result messages through `parsePiMessages`; on malformed envelopes, atomically store an `EVIDENCE_CAPTURE_FAILED` spec-check for the current wave.
- **Regression:** start with a same-wave passing spec-check, deliver `messages: [null]`, and prove the stale pass is replaced.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`.

### 5. Blind model-calibration prompts to expected outcomes

- **Source:** `code-reviewer-3` (`code-reviewer`), `engine/src/handlers/helpers/model-calibration.ts:86`
- **Claim:** prompts reveal `vulnerable`/`fixed` state and seed expected-finding paths, biasing the measured reviewer.
- **Minimal fix:** emit only the revision and a revision-derived changed-path scope; keep corpus state and expected critical metadata exclusively in scoring.
- **Regression:** assert generated prompts contain neither outcome label nor expected-critical-derived hints.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/quality-programs.test.ts`.

### 6. Preserve transcript-derivation filesystem diagnostics

- **Source:** `silent-failure-hunter-3` (`silent-failure-hunter`), `engine/src/utils/agent-transcript-path.ts:69`
- **Claim:** `realpathSync`/`readdirSync` failures collapse into a misleading “no transcript found” result.
- **Minimal fix:** retain null-returning fallback semantics but emit contextual stderr diagnostics for each failed derivation step.
- **Regression:** force both operations to fail and assert null plus actionable diagnostic output.
- **Validation:** `cd engine && bunx vitest run tests/utils/agent-transcript-path.test.ts`.

### 7. Preserve tally-closure read failure diagnostics

- **Source:** `silent-failure-hunter-4` (`silent-failure-hunter`), `engine/src/handlers/helpers/review-panel.ts:371`
- **Claim:** a closed-run catch hides whether closure evidence is unreadable or malformed.
- **Minimal fix:** preserve closed-run fail-closed polarity while appending the concrete closure read/parse error to the contract diagnostic.
- **Regression:** use malformed closure JSON and assert the operation reports both closed-run state and the parse cause.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/review-cleanup-diagnostics.test.ts tests/handlers/helpers/review-panel.test.ts`.

### 8. Enforce task identity grammar at the load boundary

- **Source:** `type-design-analyzer-1` (`type-design-analyzer`), `engine/src/state-manager.ts:134`
- **Claim:** task-graph load accepts task IDs that cannot be represented as `WaveFindingId`.
- **Minimal fix:** reuse a single task-ID parser/grammar at state load and graph validation boundaries so only `T\d+` task identities become typed `Task` values.
- **Regression:** reject IDs containing colons/whitespace and retain accepted canonical IDs.
- **Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/validate-task-graph.test.ts`.

### 9. Mark superseded architecture-phase claims as historical

- **Sources:**
  - `comment-analyzer-1` (`comment-analyzer`), `.claude/plans/2026-07-17-pr-remediation-round6.md:20`
  - `comment-analyzer-2` (`comment-analyzer`), `.claude/plans/2026-07-18-pr-remediation-round7.md:71`
- **Claims:** old remediation notes describe a removed `AgentRole.phase` field and a no-longer-derived `ARCH_PANEL_PHASE` as current design.
- **Minimal fix:** retain the audit history but label those statements as historical and point at the later implementation outcome.
- **Validation:** documentation review plus `cd engine && bunx vitest run tests/prose-contract-round14.test.ts tests/panel-config.test.ts`.

## Deferred advisories

- **`architecture-tech-lead-1` (`pi/extension.ts:162`):** extracting a harness-neutral lifecycle orchestrator is a broad boundary redesign; defer rather than combine it with the minimal capability-revocation fix.
- **`architecture-tech-lead-2` (`engine/src/core/validate-phase-order.ts:1`):** moving all phase-order I/O out of `core` is a cross-handler architecture refactor, not needed to remedy the adjudicated correctness failures.
- **`architecture-tech-lead-3` (`engine/src/config.ts:7`):** splitting policy constants from runtime path discovery is a broad module migration; defer to a dedicated architecture change with import-boundary validation.

## Refuted Findings (not fixing)

None. All three canonical critical findings were upheld by `reproduction`, `intent`, and `security`; `result.json.refuted_critical_findings` is empty.

## Project validation

Run in order:

1. Focused Vitest files named above.
2. `cd engine && npm run typecheck`.
3. `cd engine && npm run test:unit`.
4. `cd engine && npm test` (unit plus all smoke suites).
5. `bash -n scripts/*.sh`.

Only the audited remediation path set plus this plan may be staged. Run evidence under `.claude/reviews/review-and-fix-runs/` must remain untracked/ignored.
