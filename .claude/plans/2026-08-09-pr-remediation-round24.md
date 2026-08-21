# PR Remediation — Standalone Review Round 24

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.zpEbF9YN5B`
- **Exact scope:** the immutable 238-path `result.json.scope` / `session.json.scope` set in the standalone run, formed from the union of unstaged, staged, and `main...HEAD` changed paths. No remediation finding may be sourced outside that set.
- **Diff reviewed:** 41,636 additions, 2,920 deletions; TypeScript, shell, Markdown, JSON, and gitignore files.
- **Adjudication:** 4 critical findings survived the reproduction/intent/blast-radius panel at threshold 2; 0 critical findings were refuted.
- **Advisory triage:** accept all 6 advisories because each is bounded, reproducible, and directly strengthens a reviewed failure boundary or its regression coverage.

## Surviving critical fixes

### 1. Invalidate stale green evidence after a failed Pi implementation changes bytes

- **Finding:** `code-reviewer-1`
- **Agent:** `code-reviewer`
- **Source:** `pi/extension.ts:784`
- **Claim:** A failed Pi implementation can leave a previously satisfied task and its review green after changing bytes.
- **Minimal fix:** finalize every reserved implementation slot from reservation authority. For failed, missing, malformed, or agent-mismatched results, compare declared artifacts with the attempt baseline. If bytes changed, apply the shared stop-resolution semantics so task proof/status and test evidence are reset, `invalidateTaskReview` clears review state, the same-wave spec check is removed, and wave test/review gates reopen; always release execution and roster reservations. Preserve prior evidence only when current bytes still match the attempt baseline.
- **Regression:** start from an implemented/review-passed task with green wave/spec evidence, spawn a reserved implementation, modify its declared artifact, return `exitCode: 1`, and assert stale proof/review/spec/wave evidence cannot survive. Also cover missing/mismatched result slots through the same finalizer.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 2. Bind standalone isolation to the pre-spawn reservation

- **Finding:** `type-design-analyzer-1`
- **Agent:** `type-design-analyzer`
- **Source:** `pi/extension.ts:727`
- **Claim:** Standalone review isolation is decided from `details.results[].task` instead of the reserved spawn prompt, so result-time task text that omits the marker can make a standalone review proceed against the active task graph.
- **Minimal fix:** add a `standalone` discriminator to each immutable spawn reservation, derived from the already-validated pre-spawn classification. At completion, use reservation authority when present and retain result-text classification only as a compatibility fallback for unreserved legacy results.
- **Regression:** reserve a standalone reviewer, return result-time task text without the marker and with a valid active task ID, and assert the graph remains byte-identical.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 3. Attribute Pi review evidence to the reserved task

- **Finding:** `type-design-analyzer-2`
- **Agent:** `type-design-analyzer`
- **Source:** `pi/extension.ts:1022`
- **Claim:** Successful Pi review findings are attributed using `details.results[].task` instead of the reserved pre-spawn task id, so result-time task text that names another task can store findings on the wrong task.
- **Minimal fix:** resolve review task identity from `reservedItem.taskId` first for successful and failed review captures; use result/event extraction only for unreserved compatibility events. Continue rejecting unknown task IDs and agent/reservation mismatches.
- **Regression:** reserve a review for `T1`, return substituted result text naming `T2`, and assert findings bind only to `T1`.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 4. Make operational task-graph lookup lazy

- **Finding:** `architecture-tech-lead-1`
- **Agent:** `architecture-tech-lead`
- **Source:** `engine/src/state-manager.ts:63`
- **Claim:** `StateManager.resolveTaskGraph` falls back to import-time `TASK_GRAPH_PATH`, allowing long-lived Pi processes to miss a later `LOOM_STATE_PATH` or legacy graph and silently drop evidence.
- **Minimal fix:** use `taskGraphPath()` at each `resolveTaskGraph` fallback and replace Pi extension operational reads/checks of the eager singleton with one call-time-resolved path per event/decision. Keep the eager export only for consumers whose configuration is intentionally fixed.
- **Regression:** import first, establish/change the active path afterward, then assert both `resolveTaskGraph` and Pi lifecycle handling select the late path/legacy fallback.
- **Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/pi-extension-review-events.test.ts`

## Accepted advisory fixes

### 5. Reject symlinked wave-summary fallback targets

- **Finding:** `code-reviewer-2`
- **Agent:** `code-reviewer`
- **Source:** `engine/src/handlers/helpers/complete-wave-gate.ts:479`
- **Claim:** the fallback writer follows a repository-controlled symlink and can overwrite an external file.
- **Minimal fix:** canonicalize the repository-local destination, reject existing symlink components, and open the leaf with no-follow semantics before writing. Preserve ordinary replacement behavior for a real fallback file.
- **Regression:** point `wave-N-review.md` at an external sentinel and assert publication fails without changing the sentinel.
- **Validation:** `cd engine && bunx vitest run tests/handlers/complete-wave-gate.test.ts`

### 6. Preserve model-frontmatter read diagnostics

- **Finding:** `silent-failure-hunter-1`
- **Agent:** `silent-failure-hunter`
- **Source:** `engine/src/handlers/pre-tool-use/validate-agent-model.ts:30`
- **Claim:** unreadable agent definitions collapse into a generic missing/invalid-frontmatter error.
- **Minimal fix:** parse frontmatter into a typed success/failure result and include the path and underlying filesystem error in the blocking diagnostic; retain ordinary policy validation for successfully read files.
- **Regression:** resolve an existing but unreadable/non-file definition and assert the concrete read cause is reported.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts`

### 7. Audit malformed/unreadable Pi write-grant cleanup

- **Finding:** `silent-failure-hunter-2`
- **Agent:** `silent-failure-hunter`
- **Source:** `pi/write-grant.ts:181`
- **Claim:** grant sweep deletes parse/read failures without recording which grant was discarded or why.
- **Minimal fix:** emit one path-qualified stderr diagnostic before deleting an invalid-schema, malformed-JSON, or unreadable grant; distinguish malformed content from I/O failure.
- **Regression:** sweep a malformed grant and assert both deletion and diagnostic evidence.
- **Validation:** `cd engine && bunx vitest run tests/pi-write-grant.test.ts`

### 8. Fail calibration cases on malformed Pi JSONL

- **Finding:** `silent-failure-hunter-3`
- **Agent:** `silent-failure-hunter`
- **Source:** `scripts/run-model-calibration.ts:41`
- **Claim:** `finalText` ignores malformed JSON-mode stdout, allowing protocol-corrupt runs to be marked executed.
- **Minimal fix:** treat every non-empty unparsable stdout line as protocol failure and retain the malformed-line count/context in the persisted not-executed reason.
- **Regression:** a zero-exit fake Pi emitting malformed JSONL plus a valid final message must remain not executed.
- **Validation:** `cd engine && bunx vitest run tests/scripts/run-model-calibration.test.ts`

### 9. Exercise review-packet post-write rollback

- **Finding:** `pr-test-analyzer-1`
- **Agent:** `pr-test-analyzer`
- **Source:** `engine/src/handlers/helpers/review-packet.ts:182`
- **Claim:** no test drives state-update failure after packet creation and proves the unbound packet is removed.
- **Minimal fix:** extract the packet-write/state-bind transaction behind a narrow callback seam, keep cleanup/error-composition behavior unchanged, and test with a real temporary packet plus a failing bind callback.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/review-cleanup-diagnostics.test.ts`

### 10. Exercise successful live-calibration parsing

- **Finding:** `pr-test-analyzer-2`
- **Agent:** `pr-test-analyzer`
- **Source:** `scripts/run-model-calibration.ts:37`
- **Claim:** no test covers successful Pi JSON assistant extraction, fence stripping, and persisted executed findings.
- **Minimal fix:** add a zero-exit fake Pi that emits a valid `message_end` JSON event containing fenced findings; assert the output case is `executed` and the findings are persisted exactly.
- **Validation:** `cd engine && bunx vitest run tests/scripts/run-model-calibration.test.ts`

## Refuted Findings (not fixing)

None. The panel refuted 0 critical findings. All four criticals survived; their lens evidence remains in the run's canonical `verdicts/`, `outcomes.json`, and `result.json`.

## Implementation order

1. Add reservation-authoritative routing and failed-attempt finalization in `pi/extension.ts` with integration regressions.
2. Make task-graph lookup lazy in `StateManager` and Pi runtime paths with late-binding regressions.
3. Harden wave-summary publication and its symlink regression.
4. Preserve frontmatter and write-grant diagnostics with focused tests.
5. Tighten calibration JSONL handling and add failure/success tests.
6. Add the review-packet transactional rollback seam and regression.

## Full validation

```bash
cd engine
npm run typecheck
npm test
```

The remediation plan and every edited/created source or test path are staged only from the audited allowlist; standalone review run artifacts remain ignored and unstaged.
