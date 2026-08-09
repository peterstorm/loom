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
