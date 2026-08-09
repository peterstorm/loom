# PR Remediation — Round 31

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.wIofzCzdeO`
- **Exact frozen scope:** the immutable 248-path `scope` array in `run.wIofzCzdeO/result.json` (the union of unstaged, staged, and `main...HEAD` paths at initialization)
- **Diff:** 248 files, 46,583 additions, 3,040 deletions; 154 TypeScript, 83 Markdown, 5 shell, 4 JSON, 2 extensionless
- **Advisory triage:** accept all six advisories; each protects a runtime invariant or closes a concrete failure boundary.

## Surviving critical fixes

### 1. Preserve task-scoped proof attribution after parallel failures

- **Finding:** `code-reviewer-1` — `code-reviewer`
- **Location:** `pi/extension.ts:805`
- **Claim:** Pi's failed-result finalizer attributes batch-wide repository changes to each failed task, allowing a sibling's test file to satisfy that task's new-test proof on retry.
- **Fix:** continue using the repository-wide attempt delta only to decide whether stale evidence must be invalidated; do not merge that unattributed delta into the failed task's `files_modified`. Keep declared-artifact changes for invalidation diagnostics. Add a parallel failure/retry regression proving one task cannot inherit a sibling's new test.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 2. Isolate write-grant revocation failures from result reconciliation

- **Finding:** `silent-failure-hunter-1` — `silent-failure-hunter`
- **Location:** `pi/extension.ts:700`
- **Claim:** A write-grant revocation exception in subagent `tool_result` aborts roster cleanup and evidence processing before any result is reconciled.
- **Fix:** route result-time grant revocations through `runPiCleanupActions`, retain the diagnostics in `processingErrors`, and continue roster cleanup/finalization/result dispatch. Add a filesystem-failure regression that proves reconciliation continues and the caller receives an explicit error.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 3. Fail closed on malformed phase-agent messages

- **Finding:** `silent-failure-hunter-2` — `silent-failure-hunter`
- **Location:** `pi/extension.ts:1046`
- **Claim:** Malformed Pi phase-agent messages are caught and ignored, allowing phase advancement to proceed from fallback disk artifacts after artifact extraction failed.
- **Fix:** parse phase messages with `parsePiMessages` before extraction. On parse or extraction failure, append a caller-visible processing error and skip `resolveTransition` for that result; preserve filesystem fallback only for a valid message envelope that contains no relevant write call.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 4. Restrict standalone lifecycle authority to standalone review agents

- **Finding:** `architecture-tech-lead-1` — `architecture-tech-lead`
- **Location:** `engine/src/core/validate-task-execution.ts:28`
- **Claim:** The standalone review control-plane marker is trusted before agent classification, so any Loom-owned implementation spawn whose prompt contains `LOOM_REVIEW_CONTEXT: standalone` bypasses task execution registration and baselines.
- **Fix:** derive a closed standalone-agent predicate from review producers plus refutation verifiers, classify agent identity before honoring the marker, and fail phase validation loudly when any other agent uses it. Replace the implementation-bypass fixture with allow/deny regressions across task-execution and phase-order gates.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/handlers/validate-phase-order.test.ts tests/pi-extension-review-events.test.ts`

## Accepted advisory fixes

### 5. Complete parent task-graph pointer lifecycle

- **Finding:** `code-reviewer-2` — `code-reviewer`
- **Location:** `pi/extension.ts:426`
- **Claim:** Parent-session task-graph pointers created for successful Pi subagent calls are never removed, so a dangling pointer keeps direct edits and external subagents blocked after orchestration state is deleted.
- **Fix:** retain pointer ownership in per-session runtime state and remove the owned pointer after the last lifecycle-bearing reservation settles or when that parent session shuts down. Keep child pointer ownership independent.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 6. Return explicit malformed-result errors

- **Finding:** `silent-failure-hunter-3` — `silent-failure-hunter`
- **Location:** `pi/extension.ts:895`
- **Claim:** Missing or non-array `details.results` is only written to stderr and can return no `isError` content to the agent.
- **Fix:** add the malformed-envelope diagnostic to `processingErrors` before returning, while preserving reservation cleanup and failed-attempt reconciliation.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 7. Make the legacy Pi bridge actually fail closed

- **Finding:** `silent-failure-hunter-4` — `silent-failure-hunter`
- **Location:** `pi/loom-bridge.ts:21`
- **Claim:** The legacy Pi bridge logs that it is unsupported but does not fail the subagent `tool_result`, so explicit bridge users still lose lifecycle dispatch.
- **Fix:** return a caller-visible `isError: true` tool-result payload for subagent results and add a direct adapter regression.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 8. Freeze the phase-transition graph structurally

- **Finding:** `type-design-analyzer-1` — `type-design-analyzer`
- **Location:** `engine/src/config.ts:537`
- **Claim:** `VALID_TRANSITIONS` is exported as a mutable `Record<Phase, Phase[]>`, so consumers can mutate the transition graph at runtime.
- **Fix:** expose a `Readonly<Record<Phase, readonly Phase[]>>` and freeze both the outer record and every transition array. Add a runtime mutation regression.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-phase-order.test.ts && bun run typecheck`

### 9. Scope Pi parent runtime state by session

- **Finding:** `architecture-tech-lead-2` — `architecture-tech-lead`
- **Location:** `pi/extension.ts:190`
- **Claim:** Pi extension stores all in-flight subagent reservations in process-global maps keyed only by `toolCallId` and clears all reservations on any session shutdown, so concurrent sessions can erase or consume each other's lifecycle state.
- **Fix:** replace process-global reservation/grant maps with a parent-session runtime aggregate keyed by parsed session id, then key each session's entries by `toolCallId`. Result and shutdown cleanup may consume only the matching session. Add interleaved two-session shutdown/result coverage.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 10. Anchor panel writes through no-follow parent directory descriptors

- **Finding:** `architecture-tech-lead-3` — `architecture-tech-lead`
- **Location:** `engine/src/handlers/helpers/panel-run.ts:316`
- **Claim:** Panel run writers protect only the leaf with `O_NOFOLLOW`, so a parent-directory symlink swap can redirect writes outside the run boundary.
- **Fix:** traverse/create directories one component at a time through anchored `/proc/self/fd/<dirfd>` paths with `O_DIRECTORY|O_NOFOLLOW`; open file leaves and publish staged files relative to the retained parent descriptor. Fail closed when descriptor anchoring is unavailable. Add parent-symlink swap tests proving outside bytes remain unchanged.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/panel-run.test.ts tests/handlers/helpers/review-panel.test.ts`

## Refuted Findings (not fixing)

None. The panel adjudicated all four canonical critical findings as surviving. The `intent` lens cast minority refutation votes on `silent-failure-hunter-2` and `architecture-tech-lead-1`; both survived 2–1 on concrete reproduction and blast-radius evidence, so both remain mandatory fixes.

## Full validation

```bash
cd engine
bun run typecheck
bun run test
```
