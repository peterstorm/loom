# PR Remediation — Standalone Review Round 25

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Reviewed HEAD:** `a1c2c86` (`main` merge base `eda64237336193dac66843323b4c69dd4bafcd32`)
- **Exact scope:** the union of unstaged, staged, and `main...HEAD` changed paths at review time. The worktree and index were clean, so this is exactly the 239 paths returned by `git diff --name-only eda64237336193dac66843323b4c69dd4bafcd32...a1c2c86`, frozen in `result.json.scope`.
- **Diff:** 42,248 additions, 2,926 deletions; 151 TypeScript, 77 Markdown, 5 shell, 4 JSON, 2 extensionless paths.
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.0aZXtkIqDu`
- **Adjudication:** 4 criticals survived the reproduction/intent/security panel; 0 criticals were refuted. All 4 advisories are accepted because each is concrete, in scope, and can be remediated without unrelated semantic change.

## Surviving critical fixes

### 1. Failed Pi attempts must not prove task completion

- **Source:** `code-reviewer-1`; `code-reviewer`; `engine/src/handlers/subagent-stop/update-task-status.ts:354`
- **Claim:** Failed Pi implementation attempts can still satisfy the task-completion proof.
- **Fix:** Add an explicit immutable `taskCompleted` observation to `UntrustedStopResolution`; use it in `evaluateTaskProof`. Pass `false` from Pi's failed reserved-result finalizer and `true` from successful Stop evidence. Preserve cumulative file attribution for linting without allowing it to mint completion.
- **Regression:** Extend the pure Stop-resolution tests and Pi extension integration test with a previously attributed, test-waived task whose retry changes the declared artifact and exits nonzero; require `pending`, failed proof, and `impl_complete: false`.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/pi-stop-toctou.test.ts tests/pi-extension-review-events.test.ts`

### 2. Trusted prompt attribution must fail closed on malformed JSONL/tool results

- **Source:** `silent-failure-hunter-1`; `silent-failure-hunter`; `engine/src/parsers/parse-transcript.ts:80`
- **Claim:** `parseFirstUserPrompt` can skip a malformed initial prompt and attribute evidence to a later user-role/tool-result message.
- **Fix:** Replace the tolerant prompt lookup with a strict result-producing parser. Reject malformed JSON before the first authored prompt, empty prompts, and Claude user-role tool-result envelopes. Keep tolerant parsing only for non-authoritative transcript text extraction. Make the storage shell turn parse failure into explicit evidence-attribution failure.
- **Regression:** Cover malformed-first-line followed by a valid task prompt and a tool-result-only first user entry, while retaining valid Claude and Pi prompt cases.
- **Validation:** `cd engine && npm run test:unit -- tests/parsers/parsers.test.ts tests/handlers/subagent-stop/store-reviewer-findings.test.ts`

### 3. Historical artifact snapshots must distinguish absence from Git failure

- **Source:** `silent-failure-hunter-2`; `silent-failure-hunter`; `engine/src/utils/artifact-baseline.ts:46`
- **Claim:** Every nonzero `git show` is treated as a missing artifact, allowing unreadable history to look like a proved byte change.
- **Fix:** Use an exact `git ls-tree` lookup to establish genuine path absence. Return `missing` only for an absent tree entry; if the entry exists but `git show` cannot read it, throw a contextual infrastructure error.
- **Regression:** Remove/rename the committed loose blob while retaining the commit/tree and assert recovery throws rather than reporting a change; preserve binary/new-file behavior.
- **Validation:** `cd engine && npm run test:unit -- tests/utils/artifact-baseline.test.ts tests/handlers/helpers/reconcile-implementation-proof.test.ts`

### 4. Pi Bash guard must honor session-scoped graph authority

- **Source:** `silent-failure-hunter-3`; `silent-failure-hunter`; `pi/extension.ts:218`
- **Claim:** A Pi child bound only by its `SUBAGENT_DIR` task-graph pointer can bypass Bash state-file guarding.
- **Fix:** Compute active graph authority per tool call from lazy `taskGraphPath()`, rejected child-grant state, and the parsed session pointer. Invoke the pure state-file decision whenever any authority is active; retain allow behavior only when no graph authority exists.
- **Regression:** Exercise a child session with no local graph and only a session pointer; require a Bash write targeting protected state to be blocked.
- **Validation:** `cd engine && npm run test:unit -- tests/pi-extension-review-events.test.ts tests/handlers/pre-tool-use/block-direct-edits.test.ts`

## Accepted advisories

### 5. Resolve phase-order state lazily

- **Source:** `code-reviewer-2`; `code-reviewer`; `engine/src/core/validate-phase-order.ts:169`
- **Claim:** Phase-order validation can ignore the active lazily resolved task graph.
- **Fix:** Resolve `taskGraphPath()` once per invocation and use that same path for existence and `StateManager.fromPath`.
- **Regression:** Set `LOOM_STATE_PATH` after module import and prove an execute-phase graph blocks an architecture panel agent.
- **Validation:** `cd engine && npm run test:unit -- tests/handlers/validate-phase-order.test.ts`

### 6. Encode refuted panel outcomes as a non-empty ADT

- **Source:** `type-design-analyzer-1`; `type-design-analyzer`; `engine/src/core/standalone-review.ts:38`
- **Claim:** `ParsedPanelOutcome` permits `survives: false` with no refutations.
- **Fix:** Replace the boolean/data-bag interface with a discriminated union whose refuted variant carries a non-empty refutation tuple. Construct only valid variants after parsing and simplify finalization to consume the proved tuple.
- **Regression:** Retain parser rejection of refuted outcomes without threshold/refutation evidence and assert valid surviving/refuted variants serialize unchanged.
- **Validation:** `cd engine && npm run test:unit -- tests/core/standalone-review.test.ts`

### 7. Make remaining Task collections readonly

- **Source:** `type-design-analyzer-2`; `type-design-analyzer`; `engine/src/types.ts:285`
- **Claim:** Mutable `spec_anchors` and `files_modified` arrays allow in-memory mutation through a loaded `Task`.
- **Fix:** Change both fields to readonly arrays; continue producing replacement arrays at writers.
- **Validation:** `cd engine && npm run typecheck && npm run test:unit -- tests/state-manager.test.ts tests/handlers/populate-task-graph.test.ts`

### 8. Correct the review-source arbitration comment

- **Source:** `comment-analyzer-1`; `comment-analyzer`; `engine/src/core/review-output.ts:8`
- **Claim:** The opening comment falsely says the winner alone decides whether a critical reaches the gate, despite unmatched losing-source claims being retained.
- **Fix:** State that arbitration chooses the primary location-bearing representation while reconciliation preserves unmatched claims and backstops critical-count shortfalls.
- **Validation:** `cd engine && npm run test:unit -- tests/core/review-output.test.ts tests/prose-contract-round14.test.ts`

## Refuted Findings (not fixing)

None. `result.json.refuted_critical_findings` is empty. The intent lens cast one refutation vote on `silent-failure-hunter-1` because tolerant JSONL skipping is a documented general parser convention; reproduction and security upheld the trust-boundary failure, so the finding survived the 2-of-3 threshold and remains mandatory.

## Full validation

1. `cd engine && npm run typecheck`
2. `cd engine && npm test`
3. `git diff --check`
4. Verify the staged path set exactly matches the audited remediation allowlist plus this plan.
