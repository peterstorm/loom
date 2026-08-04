# PR Remediation Round 22

## Review authority

- Branch: `feat/architecture-panel-mode-plan`
- Scope: the 228 paths frozen in `.claude/reviews/review-and-fix-runs/run.2TsJHQlXjw/session.json`
- Standalone review run: `.claude/reviews/review-and-fix-runs/run.2TsJHQlXjw`
- Aggregate: 5 critical findings and 8 advisories
- Refutation panel: `reproduction`, `intent`, `blast-radius`; strict-majority threshold 2
- Authoritative result: `.claude/reviews/review-and-fix-runs/run.2TsJHQlXjw/result.json`
- Adjudication: all 5 criticals survived (reproduction + blast-radius upheld; intent supplied one dissenting refutation vote); 0 criticals were refuted.
- Advisory triage: accept all 8 advisories because each protects a lifecycle, evidence, authority, or boundary invariant and can be completed in this remediation.

## Surviving critical fixes

### 1. Invalidate a stale trusted pass after a retry changes code

- Source: `code-reviewer-1` (`code-reviewer`)
- Location: `engine/src/handlers/subagent-stop/update-task-status.ts:345`
- Claim: a retry that changes code can remain implemented after its latest test run fails because a prior `trusted-pass` is reused.
- Fix: preserve a prior trusted failure against untrusted evidence, and preserve a trusted pass only when the retry made no code changes. When bytes changed, evaluate the current result under the applicable harness proof policy. Apply the same rule in the Claude locked update and the shared Pi transition.
- Regression: prior trusted pass + changed artifact + latest failing result must return the task to pending/failed and clear `impl_complete`; a no-write stop must retain the trusted pass.
- Validation: `cd engine && bunx vitest run tests/handlers/pi-stop-toctou.test.ts tests/handlers/update-task-status.test.ts`

### 2. Recompute new-test evidence from the current cumulative diff

- Source: `code-reviewer-2` (`code-reviewer`)
- Location: `engine/src/handlers/subagent-stop/update-task-status.ts:304`
- Claim: `new_tests_written` remains true after previously added tests are removed.
- Fix: remove sticky OR semantics. Persist the current diff-derived `NewTestEvidence` in both stop resolution paths and in `reconcileTaskFromStoredEvidence`; retain historical evidence only while the current cumulative diff still proves tests exist.
- Regression: a retry/reconciliation that deletes the only added test must make the `new-tests` obligation fail; an earlier test still present in the current cumulative diff remains credited.
- Validation: `cd engine && bunx vitest run tests/handlers/pi-stop-toctou.test.ts tests/handlers/helpers/reconcile-implementation-proof.test.ts tests/handlers/update-task-status.test.ts`

### 3. Turn missing Claude reviewer transcripts into attributable evidence failures

- Source: `silent-failure-hunter-1` (`silent-failure-hunter`)
- Location: `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:64`
- Claim: an empty/unreadable reviewer transcript can disappear while a sibling leaves task review status gate-passing.
- Fix: read the trusted first user prompt before requiring Machine Summary output, derive the task from that prompt, preserve standalone isolation, and apply an `evidence-failed` review resolution when the transcript is unreadable or lacks its marker. If no trusted prompt/task can be attributed, return a loud hook error rather than a passthrough. Use the trusted prompt for successful task attribution too.
- Regression: a prior-passed task becomes `evidence_capture_failed` on an attributable empty transcript; malformed/unattributable transcript evidence returns an error; standalone runs remain untouched.
- Validation: `cd engine && bunx vitest run tests/handlers/subagent-stop/store-reviewer-findings.test.ts`

### 4. Persist failed Pi reviewer completion as evidence failure

- Source: `silent-failure-hunter-2` (`silent-failure-hunter`)
- Location: `pi/extension.ts:710`
- Claim: a failed Pi review result is skipped and a healthy sibling can leave the task passed.
- Fix: handle failed review agents before the generic failed-result skip, resolve the task from the trusted result task, and apply `evidence-failed` without parsing failed assistant text. Keep per-result isolation and fail loudly when attribution is impossible.
- Regression: failed + healthy sibling completion leaves the failed reviewer named in `review_evidence_failures` and the task at `evidence_capture_failed`.
- Validation: `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 5. Replace stale Pi spec evidence after a failed invocation

- Source: `silent-failure-hunter-3` (`silent-failure-hunter`)
- Location: `pi/extension.ts:710`
- Claim: failed/aborted spec-check completion leaves an older same-wave `PASSED` record available to the wave gate.
- Fix: before generic failure handling, write an `EVIDENCE_CAPTURE_FAILED` spec-check for the current wave with exit/stop diagnostics. Never parse assistant text from a failed process.
- Regression: an existing same-wave pass is replaced by failure evidence after an aborted/non-zero result.
- Validation: `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/handlers/store-spec-check-findings.test.ts`

## Accepted advisories

### 6. Make Pi write-grant lifetime session-bounded rather than queue-estimated

- Source: `code-reviewer-3` (`code-reviewer`)
- Location: `pi/extension.ts:138`
- Claim: queued child grants can expire because TTL calculation assumes unsupported `timeoutSeconds` data.
- Fix: remove queue-stage/unsupported-timeout arithmetic. Give pre-issued capabilities one explicit bounded session-start window, while preserving immediate revocation on subagent `tool_result`, parent `session_shutdown`, rollback, one-time consumption, and abandoned-grant sweeping.
- Regression: input `timeoutSeconds` and queue index no longer alter grant lifetime; delayed consumption within the supported session window succeeds and post-revocation consumption fails.
- Validation: `cd engine && bunx vitest run tests/pi-write-grant.test.ts tests/pi-extension-review-events.test.ts`

### 7. Cover Pi out-of-packet finding rejection

- Source: `pr-test-analyzer-1` (`pr-test-analyzer`)
- Location: `pi/extension.ts:983`
- Claim: no Pi boundary test proves an out-of-scope located finding becomes evidence failure without storing findings.
- Fix: add a fake-runtime event test with task scope `pi/extension.ts` and finding location `README.md`; assert no findings are stored and `review_error` names the outside path.
- Validation: `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 8. Cover symlinked standalone reviewer evidence

- Source: `pr-test-analyzer-2` (`pr-test-analyzer`)
- Location: `engine/src/handlers/helpers/standalone-review.ts:162`
- Claim: no helper test proves a canonical reviewer slot cannot be a symlink.
- Fix: add a CLI boundary test replacing the exact slot with an outside-file symlink; assert aggregation fails with the non-symlink diagnostic and publishes no aggregate.
- Validation: `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts`

### 9. Cover canonical panel-outcome lockstep failures

- Source: `pr-test-analyzer-3` (`pr-test-analyzer`)
- Location: `engine/src/core/standalone-review.ts:251`
- Claim: canonical claim, vote partition, reasoning, and derived count mismatches lack focused negative tests.
- Fix: add table-driven tests for wrong canonical claim, duplicated lens across vote kinds, reasoning/refuting-lens length mismatch, and incorrect surviving/refuted totals.
- Validation: `cd engine && bunx vitest run tests/core/standalone-review.test.ts`

### 10. Parse task file scopes at persistence/load boundaries

- Source: `type-design-analyzer-1` (`type-design-analyzer`)
- Location: `engine/src/types.ts:233`
- Claim: mutable arbitrary strings can enter `Task.file_list` before proof/review consumers reject them.
- Fix: make the task field readonly and route every decompose/state-file entry through the canonical repository-relative Review Path smart constructor. Reject absolute, traversal, non-POSIX, alias, empty, and duplicate paths before persistence or typed load; preserve canonical values for proof derivation.
- Regression: populate and state parsing reject malformed/duplicate file scopes and accept canonical repository-relative paths.
- Validation: `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts tests/handlers/populate-task-graph.test.ts tests/state-manager.test.ts`

### 11. Enforce Loom model profiles without a task graph

- Source: `architecture-tech-lead-1` (`architecture-tech-lead`)
- Location: `engine/src/handlers/pre-tool-use/validate-agent-model.ts:52`
- Claim: Claude Code allows pre-graph panel/standalone Loom spawns to bypass explicit model policy.
- Fix: decouple model enforcement from `TASK_GRAPH_PATH`; classify the tool and Loom-owned agent first, enforce its definition/profile for every Loom spawn, and continue allowing non-spawn tools and external utility agents.
- Regression: a graphless Loom spawn without an explicit allowed model blocks, while graphless non-Loom/non-spawn operations pass.
- Validation: `cd engine && bunx vitest run tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts tests/handlers/pre-tool-use/spawn-gate-tool-names.test.ts`

### 12. Validate standalone scope before freezing it

- Source: `architecture-tech-lead-2` (`architecture-tech-lead`)
- Location: `engine/src/handlers/helpers/standalone-review.ts:70`
- Claim: `init` freezes absolute/traversal scope paths and rejects them only after reviewers use the session.
- Fix: expose one pure standalone-scope smart constructor and use it from plan/session parsing and aggregate parsing. Normalize only allowed aliases consistently, reject escapes/control characters/duplicates at `init`, and retain aggregate revalidation as defense in depth.
- Regression: helper `init` rejects absolute, traversal, newline/NUL, and normalized duplicates before `session.json` publication.
- Validation: `cd engine && bunx vitest run tests/core/standalone-review.test.ts tests/handlers/helpers/standalone-review.test.ts`

### 13. Atomically enforce task execution ownership in the shared core

- Source: `architecture-tech-lead-3` (`architecture-tech-lead`)
- Location: `engine/src/core/validate-task-execution.ts:152`
- Claim: registration does not reject already-executing tasks or overlapping declared artifacts, and Pi owns the only overlap check.
- Fix: add a pure execution-ownership decision covering duplicate active task ids and overlaps with active/new same-wave tasks; represent parallel versus sequential batches explicitly. Check once at preflight and again inside the locked `StateManager.update` before committing execution ids/baselines. Remove the Pi-only policy duplicate.
- Regression: already-executing, parallel overlap, active-owner overlap, and stale-preflight/locked-recheck scenarios block without state mutation; explicitly sequential chains may share declared paths.
- Validation: `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/pi-extension-review-events.test.ts`

## Refuted Findings (not fixing)

None. `result.json.refuted_critical_findings` is empty. The intent verifier cast one refutation vote for each critical, but each finding remained below the two-lens refutation threshold and therefore survives.

## Project validation

1. `cd engine && bun run typecheck`
2. `cd engine && bun run test:unit`
3. `cd engine && bun run test:smoke`
4. Inspect `git diff --check` and the exact audited remediation path set before staging.
