# PR Remediation Round 29 — Adjudicated Standalone Review

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.e9EAVyCrbB`
- **Exact scope:** the immutable 245-path `result.json.scope` array; newline-delimited SHA-256 `a562aae9545f4a3b208c0209bf0756723a7df5d57be3561199a6d1c19a4bf592`
- **Diff:** 45,327 additions / 3,019 deletions
- **Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead
- **Panel:** reproduction, intent, test-coverage; strict-majority threshold 2
- **Adjudication:** 2 surviving criticals, 0 refuted criticals, 6 accepted advisories

All six advisories are accepted. The duplicate template-substitution test and architecture findings remain separately audited but share one production fix.

## Surviving critical fixes

### 1. Require packet-proven attribution for historical baseline recovery

- **Source:** `code-reviewer-1` — code-reviewer — `engine/src/handlers/helpers/reconcile-implementation-proof.ts:304`
- **Claim:** `--baseline-sha` without packets can satisfy implementation proof from unproven writes.
- **Fix:** Reject every `--baseline-sha` invocation that has no `--packet` binding before opening the task graph. Remove blanket legacy behavior; when historical recovery is active, alter only tasks with engine-issued, registration-verified packet evidence. Preserve ordinary no-override reconciliation from already-persisted evidence.
- **Regression:** Invoke the real CLI with an ancestor SHA and no packet, assert non-zero status and an actionable packet requirement, and prove the state file remains byte-identical.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/reconcile-implementation-proof.test.ts`

### 2. Surface isolated Pi result-processing failures to the caller

- **Source:** `silent-failure-hunter-1` — silent-failure-hunter — `pi/extension.ts:1399`
- **Claim:** Pi catches per-result subagent-stop processing failures and only logs them, allowing stale review/spec/implementation state to remain while the hook reports success.
- **Fix:** Preserve sibling isolation but accumulate every caught processing failure. After all result slots have been attempted, return an explicit `isError: true` Pi tool-result response containing the indexed diagnostics. Keep stderr diagnostics and successful sibling persistence intact; never claim the batch was successfully captured when any slot failed.
- **Regression:** Extend the existing first-result-throws test to assert the second result is still stored and the handler response is an error naming the failed slot.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

## Accepted advisory fixes

### 3. Replace stale Pi spec-check evidence for missing reserved results

- **Source:** `code-reviewer-2` — code-reviewer — `pi/extension.ts:815`
- **Claim:** A missing or mismatched reserved spec-check result leaves prior `PASSED` evidence active.
- **Fix:** Reconcile reservation slots before all malformed/missing `details.results` early returns. Atomically write an `EVIDENCE_CAPTURE_FAILED` spec-check for absent, shortened, or agent-mismatched `spec-check-invoker` slots, alongside existing missing-review reconciliation.
- **Regression:** For absent details, an empty/short result array, and a mismatched returned agent, begin with same-wave `PASSED` evidence and assert typed failure replacement.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 4. Treat a missing spec-check verdict marker as capture failure

- **Source:** `silent-failure-hunter-2` — silent-failure-hunter — `engine/src/core/spec-check.ts:109`
- **Claim:** Missing `SPEC_CHECK_VERDICT` becomes captured `UNKNOWN` rather than `EVIDENCE_CAPTURE_FAILED` on automated paths.
- **Fix:** Enforce the required verdict marker inside shared `reconcileSpecCheck`; return the existing evidence-failed ADT with a rerun diagnostic. Keep `UNKNOWN` only for legitimately persisted legacy state, not fresh malformed capture.
- **Regression:** Reconcile output with valid counts but no verdict and assert `EVIDENCE_CAPTURE_FAILED` with no captured count fields.
- **Validation:** `cd engine && bunx vitest run tests/handlers/store-spec-check-findings.test.ts tests/handlers/helpers/store-spec-check.test.ts`

### 5. Resolve template-substitution graph state lazily

- **Sources:**
  - `pr-test-analyzer-1` — pr-test-analyzer — `engine/src/core/validate-template-substitution.ts:40`
  - `architecture-tech-lead-1` — architecture-tech-lead — `engine/src/core/validate-template-substitution.ts:40`
- **Claims:** The production guard lacks late-bound `LOOM_STATE_PATH` coverage and uses import-time `TASK_GRAPH_PATH`, so a graph created or selected after Pi startup can be ignored.
- **Fix:** Call `taskGraphPath()` at the decision boundary instead of consulting the import-time constant. Keep placeholder detection pure and unchanged.
- **Regression:** Import the module first, then point `LOOM_STATE_PATH` at a newly created graph and assert the real `validateTemplateSubstitution` blocks an unresolved placeholder; assert a missing graph allows it.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-template-substitution.test.ts`

### 6. Make first-user-prompt parsing total over malformed content shapes

- **Source:** `type-design-analyzer-1` — type-design-analyzer — `engine/src/parsers/parse-transcript.ts:123`
- **Claim:** `parseFirstUserPrompt` can throw on non-string, non-array user message content instead of returning its failure ADT.
- **Fix:** Parse user content through an explicit string/array/unsupported shape branch in both Pi and Claude formats. Unsupported content returns `FirstUserPromptParse { ok: false }`; no `.filter` call is made on unproven input.
- **Regression:** Add Pi and Claude malformed-object content cases and assert typed failure without throws.
- **Validation:** `cd engine && bunx vitest run tests/parsers/parsers.test.ts`

### 7. Make every accepted task implementation agent executable under Pi

- **Source:** `architecture-tech-lead-2` — architecture-tech-lead — `engine/src/config.ts:255`
- **Claim:** `IMPL_AGENTS` accepts `dotfiles-agent` and `general-purpose`, but neither has Loom model-policy/definition authority, so valid task graphs become unspawnable under Pi.
- **Fix:** Remove the two unsupported names from the task-graph implementation-agent authority rather than inventing unowned agent definitions. Add a bidirectional catalog invariant proving every `IMPL_AGENTS` member resolves a Loom policy; update generated property/dispatch expectations.
- **Regression:** Assert no implementation agent fails policy resolution and removed names categorize/validate as unknown task agents.
- **Validation:** `cd engine && bunx vitest run tests/core/model-profiles.test.ts tests/handlers/dispatch.test.ts tests/handlers/validate-task-graph.property.test.ts tests/handlers/pre-tool-use/validate-agent-skill.test.ts`

## Refuted Findings (not fixing)

None. `result.json.refuted_critical_findings` is empty.

## Panel evidence retained for surviving criticals

- `standalone-review:code-reviewer-1`: reproduction upheld the trigger; intent refuted it because the blanket legacy path was explicitly documented; test-coverage was uncertain. One refutation vote did not meet threshold 2, so the critical survives and the unsafe compatibility path is removed.
- `standalone-review:silent-failure-hunter-1`: reproduction upheld the persistence-failure path; intent refuted it because sibling continuation was deliberate and tested; test-coverage was uncertain. The fix preserves that intended sibling isolation while making partial capture an explicit caller-visible error.

## Validation and delivery

1. Run every targeted command above while implementing.
2. Run `cd engine && npm run typecheck`.
3. Run `cd engine && npm run test:unit`.
4. Run `cd engine && npm test` (unit tests plus all four smoke suites).
5. Audit only the remediation path set plus this plan, stage that allowlist exactly, commit, and push without force.
