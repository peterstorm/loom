# PR Remediation — Adjudicated Review

- **Date:** 2026-08-04
- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone review run:** `run.ZLPfcCNxmg` at `.claude/reviews/review-and-fix-runs/run.ZLPfcCNxmg`
- **Scope authority:** `.claude/reviews/review-and-fix-runs/run.ZLPfcCNxmg/result.json` (193 paths, listed exactly below)
- **Panel:** reproduction, intent, blast-radius; strict-majority threshold 2
- **Adjudication:** 5 critical findings survived; 0 critical findings were refuted; all 10 advisories accepted because each identifies a concrete correctness, evidence, audit, or contract gap.

## Exact Review Scope

- `agents/adr-writer-agent.md`
- `agents/arch-designer-agent.md`
- `agents/arch-interviewer-agent.md`
- `agents/architecture-agent.md`
- `agents/architecture-tech-lead.md`
- `agents/arch-judge-agent.md`
- `agents/brainstorm-agent.md`
- `agents/clarify-agent.md`
- `agents/code-implementer-agent.md`
- `agents/code-reviewer.md`
- `agents/code-simplifier.md`
- `agents/comment-analyzer.md`
- `agents/decompose-agent.md`
- `agents/deepen-agent.md`
- `agents/frontend-agent.md`
- `agents/grill-agent.md`
- `agents/java-test-agent.md`
- `agents/plan-alignment-agent.md`
- `agents/pr-test-analyzer.md`
- `agents/review-verifier-agent.md`
- `agents/security-agent.md`
- `agents/silent-failure-hunter.md`
- `agents/skill-content-reviewer.md`
- `agents/spec-check-invoker.md`
- `agents/specify-agent.md`
- `agents/test-engineer.md`
- `agents/ts-test-agent.md`
- `agents/type-design-analyzer.md`
- `calibration/corpus.json`
- `.claude/plans/2026-07-16-architecture-panel-mode.md`
- `.claude/plans/2026-07-17-pr-remediation.md`
- `.claude/plans/2026-07-17-pr-remediation-round5.md`
- `.claude/plans/2026-07-17-pr-remediation-round6.md`
- `.claude/plans/2026-07-18-pr-remediation-round7.md`
- `.claude/plans/2026-07-18-pr-remediation-round8.md`
- `.claude/plans/2026-08-02-adversarial-review-panel.md`
- `.claude/plans/2026-08-02-pr-remediation.md`
- `.claude/plans/2026-08-02-pr-remediation-review-panel.md`
- `.claude/plans/2026-08-02-pr-remediation-round12.md`
- `.claude/plans/2026-08-02-pr-remediation-round13.md`
- `.claude/plans/2026-08-02-pr-remediation-round14.md`
- `.claude/plans/2026-08-03-model-profiles-proof-driven-quality.md`
- `.claude/plans/2026-08-03-pr-remediation-round15.md`
- `commands/loom.md`
- `commands/review-and-fix.md`
- `commands/review-pr.md`
- `commands/specify.md`
- `commands/templates/impl-agent-context.md`
- `commands/templates/phase-arch-design.md`
- `commands/templates/phase-arch-finalize.md`
- `commands/templates/phase-arch-interview.md`
- `commands/templates/phase-architecture.md`
- `commands/templates/phase-arch-judge.md`
- `commands/templates/review-verify.md`
- `commands/wave-gate.md`
- `CONTEXT.md`
- `docs/deterministic-core.md`
- `docs/migration-claude-code-to-pi.md`
- `docs/pi-usage.md`
- `engine/.gitignore`
- `engine/package.json`
- `engine/src/cli.ts`
- `engine/src/config.ts`
- `engine/src/core/agent-skills.ts`
- `engine/src/core/findings.ts`
- `engine/src/core/harness-resources.ts`
- `engine/src/core/model-calibration.ts`
- `engine/src/core/model-profiles.ts`
- `engine/src/core/panel-contract.ts`
- `engine/src/core/panel-kernel.ts`
- `engine/src/core/panel-program.ts`
- `engine/src/core/proof-obligations.ts`
- `engine/src/core/repository-path.ts`
- `engine/src/core/review-output.ts`
- `engine/src/core/review-packet.ts`
- `engine/src/core/review-panel.ts`
- `engine/src/core/standalone-review.ts`
- `engine/src/core/tool-vocabulary.ts`
- `engine/src/core/validate-phase-order.ts`
- `engine/src/core/validate-template-substitution.ts`
- `engine/src/handler-routes.ts`
- `engine/src/handlers/helpers/complete-wave-gate.ts`
- `engine/src/handlers/helpers/lint-wave-gate.ts`
- `engine/src/handlers/helpers/model-calibration.ts`
- `engine/src/handlers/helpers/model-profiles.ts`
- `engine/src/handlers/helpers/panel-contract.ts`
- `engine/src/handlers/helpers/panel-program.ts`
- `engine/src/handlers/helpers/panel-run.ts`
- `engine/src/handlers/helpers/populate-task-graph.ts`
- `engine/src/handlers/helpers/review-packet.ts`
- `engine/src/handlers/helpers/review-panel.ts`
- `engine/src/handlers/helpers/standalone-review.ts`
- `engine/src/handlers/helpers/store-review-findings.ts`
- `engine/src/handlers/helpers/validate-task-graph.ts`
- `engine/src/handlers/pre-tool-use/validate-agent-model.ts`
- `engine/src/handlers/pre-tool-use/validate-agent-skill.ts`
- `engine/src/handlers/pre-tool-use/validate-phase-order.ts`
- `engine/src/handlers/pre-tool-use/validate-task-execution.ts`
- `engine/src/handlers/pre-tool-use/validate-template-substitution.ts`
- `engine/src/handlers/subagent-stop/advance-phase.ts`
- `engine/src/handlers/subagent-stop/store-reviewer-findings.ts`
- `engine/src/handlers/subagent-stop/store-spec-check-findings.ts`
- `engine/src/handlers/subagent-stop/update-task-status.ts`
- `engine/src/machine/extract-evidence.ts`
- `engine/src/machine/test-report.ts`
- `engine/src/parsers/parse-transcript.ts`
- `engine/src/state-manager.ts`
- `engine/src/types.ts`
- `engine/src/utils/agent-transcript-path.ts`
- `engine/src/utils/git.ts`
- `engine/src/utils/loom-package-root.ts`
- `engine/src/utils/render-pi-agent.ts`
- `engine/src/utils/repository-path.ts`
- `engine/tests/core/agent-skills.test.ts`
- `engine/tests/core/findings-round14.test.ts`
- `engine/tests/core/findings.test.ts`
- `engine/tests/core/harness-resources.test.ts`
- `engine/tests/core/model-calibration.test.ts`
- `engine/tests/core/model-profiles.test.ts`
- `engine/tests/core/panel-contract-round14.test.ts`
- `engine/tests/core/panel-contract.test.ts`
- `engine/tests/core/panel-kernel.test.ts`
- `engine/tests/core/panel-program.test.ts`
- `engine/tests/core/proof-obligations.test.ts`
- `engine/tests/core/repository-path.test.ts`
- `engine/tests/core/review-output-round14.test.ts`
- `engine/tests/core/review-output.test.ts`
- `engine/tests/core/review-packet.test.ts`
- `engine/tests/core/review-panel.test.ts`
- `engine/tests/core/review-policy-round14.test.ts`
- `engine/tests/core/round15.test.ts`
- `engine/tests/core/standalone-review.test.ts`
- `engine/tests/handlers/helpers/lint-wave-gate.test.ts`
- `engine/tests/handlers/helpers/panel-contract.test.ts`
- `engine/tests/handlers/helpers/quality-programs.test.ts`
- `engine/tests/handlers/helpers/review-panel-multitask.test.ts`
- `engine/tests/handlers/helpers/review-panel.test.ts`
- `engine/tests/handlers/helpers/standalone-review.test.ts`
- `engine/tests/handlers/pi-stop-toctou.test.ts`
- `engine/tests/handlers/populate-task-graph.test.ts`
- `engine/tests/handlers/pre-tool-use/spawn-gate-tool-names.test.ts`
- `engine/tests/handlers/pre-tool-use/validate-agent-skill.test.ts`
- `engine/tests/handlers/pre-tool-use/validate-template-substitution.test.ts`
- `engine/tests/handlers/review-findings-parity.test.ts`
- `engine/tests/handlers/store-reviewer-findings.test.ts`
- `engine/tests/handlers/store-review-findings.test.ts`
- `engine/tests/handlers/subagent-stop/advance-phase.test.ts`
- `engine/tests/handlers/subagent-stop/dispatch-resilience.test.ts`
- `engine/tests/handlers/subagent-stop/store-reviewer-findings.test.ts`
- `engine/tests/handlers/subagent-stop/update-task-status-machine.test.ts`
- `engine/tests/handlers/tally-gate-composition.test.ts`
- `engine/tests/handlers/update-task-status.test.ts`
- `engine/tests/handlers/validate-phase-order.test.ts`
- `engine/tests/handlers/validate-task-graph.test.ts`
- `engine/tests/impl-agent-skill-contract.test.ts`
- `engine/tests/machine/advance.property.test.ts`
- `engine/tests/machine/hooks-sync.test.ts`
- `engine/tests/machine/test-report.test.ts`
- `engine/tests/panel-config.test.ts`
- `engine/tests/panel-templates.test.ts`
- `engine/tests/parsers/parsers.test.ts`
- `engine/tests/pi-imports.test.ts`
- `engine/tests/pi-resources.test.ts`
- `engine/tests/pi-test-evidence.test.ts`
- `engine/tests/prose-contract-round14.test.ts`
- `engine/tests/review-agent-contract.test.ts`
- `engine/tests/review-panel-config.test.ts`
- `engine/tests/review-panel-templates.test.ts`
- `engine/tests/runbook-contract.test.ts`
- `engine/tests/runtime-resource-portability.test.ts`
- `engine/tests/state-manager.test.ts`
- `engine/tests/utils/agent-transcript-path.test.ts`
- `engine/tests/utils/render-pi-agent.test.ts`
- `.gitignore`
- `hooks/hooks.json`
- `package.json`
- `pi/extension.ts`
- `pi/loom-bridge.ts`
- `pi/resources.ts`
- `pi/transcript-adapter.ts`
- `README.md`
- `references/executable-models.md`
- `references/panel-lenses.md`
- `references/review-lenses.md`
- `scripts/run-model-calibration.ts`
- `scripts/smoke-panel-mode.sh`
- `scripts/smoke-pi-resources.sh`
- `scripts/smoke-review-panel.sh`
- `scripts/smoke-standalone-review.sh`
- `scripts/sync-pi-agents.sh`
- `skills/lint-project/references/runner.md`
- `skills/lint-project/SKILL.md`
- `skills/review-and-fix/SKILL.md`

## Surviving Critical Fixes

### 1. Preserve marker critical severity during structured-block reconciliation

- **Sources:** `code-reviewer-1` / code-reviewer / `engine/src/core/review-output.ts:343` — “Severity-blind claim reconciliation lets a winning findings block demote a CRITICAL marker to advisory.”
- **Also:** `type-design-analyzer-1` / type-design-analyzer / `engine/src/core/review-output.ts:343` — “chooseSource treats claim text alone as identity … so a marker-line critical can be consumed by an advisory block entry.”
- **Fix:** Keep claim-text identity for deduplication, but align every matched structured entry to the corresponding marker severity before cardinal arbitration. Preserve the structured file/line. This prevents both duplicate records and critical-to-advisory demotion.
- **Regression validation:** `cd engine && bunx vitest run tests/core/round15.test.ts tests/core/review-output.test.ts tests/core/review-output-round14.test.ts`.

### 2. Close every wave refutation run independently of its vote outcome

- **Source:** `code-reviewer-2` / code-reviewer / `engine/src/handlers/helpers/review-panel.ts:478` — “A wave panel run whose first tally upholds every finding can be re-tallied with changed verdicts.”
- **Fix:** Publish an exclusive run-scoped wave `outcomes.json` closure marker before mutating task state; reject any repeated or incomplete tally regardless of whether any finding was refuted. Retain graph-level replay checks for cross-run stale findings.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/helpers/review-panel.test.ts tests/handlers/helpers/review-panel-multitask.test.ts tests/handlers/tally-gate-composition.test.ts`.

### 3. Fail review-packet creation on unexpected Git failures

- **Source:** `silent-failure-hunter-1` / silent-failure-hunter / `engine/src/handlers/helpers/review-packet.ts:40` — “review-packet suppresses all git failures as empty strings … instead of failing.”
- **Fix:** Replace catch-all `tryGit` with status-aware probes. Tolerate only semantically expected statuses for “not tracked” and “remote HEAD absent”; explicitly test remote-ref existence, and let infrastructure, merge-base, and revision failures abort packet creation with diagnostics.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/helpers/quality-programs.test.ts tests/core/review-packet.test.ts`.

### 4. Execute the Pi review-finding event path in a fake runtime

- **Source:** `pr-test-analyzer-1` / pr-test-analyzer / `pi/extension.ts:367` — “The Pi subagent tool_result handler's review-finding path is not covered by an executable fake-Pi integration test.”
- **Fix:** Remove the unnecessary runtime Pi-package import so the extension can be loaded under tests, register it on a fake event bus, emit realistic subagent `tool_result` events, and assert valid critical capture plus standalone no-mutation behavior.
- **Regression validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/handlers/review-findings-parity.test.ts tests/pi-imports.test.ts`.

## Accepted Advisory Fixes

### 5. Enforce standalone frozen scope at aggregate construction and parse boundaries

- **Sources:** `code-reviewer-3` / code-reviewer / `engine/src/core/standalone-review.ts:104`; `silent-failure-hunter-2` / silent-failure-hunter / same location; `architecture-tech-lead-1` / architecture-tech-lead / `engine/src/core/standalone-review.ts:97`.
- **Fix:** Reject non-null finding files outside normalized frozen scope both while aggregating transcripts and while parsing stored aggregates. Add construction and tamper-boundary tests.
- **Regression validation:** `cd engine && bunx vitest run tests/core/standalone-review.test.ts tests/handlers/helpers/standalone-review.test.ts`.

### 6. Publish standalone aggregate atomically

- **Source:** `silent-failure-hunter-3` / silent-failure-hunter / `engine/src/handlers/helpers/standalone-review.ts:187`.
- **Fix:** Write and read-validate a pending aggregate, then atomically rename it. Detect an existing pending or malformed aggregate as an incomplete/corrupt closed run rather than reporting successful prior aggregation.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts`.

### 7. Pin Pi spawn-mode parsing

- **Source:** `pr-test-analyzer-2` / pr-test-analyzer / `engine/src/core/model-profiles.ts:352`.
- **Fix:** Add direct tests for single, parallel, chain, mixed, empty, and malformed entries, including all-or-nothing rejection.
- **Regression validation:** `cd engine && bunx vitest run tests/core/model-profiles.test.ts`.

### 8. Pin review-verifier phase classification

- **Source:** `pr-test-analyzer-3` / pr-test-analyzer / `engine/src/core/validate-phase-order.ts:74`.
- **Fix:** Add exact and bare-name `detectPhase` assertions for `review-verifier-agent`.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/validate-phase-order.test.ts`.

### 9. Correct standalone tally and manifest-authorship prose

- **Sources:** `comment-analyzer-1` / comment-analyzer / `README.md:301`; `comment-analyzer-2` / comment-analyzer / `engine/src/handlers/helpers/review-panel.ts:16`; `comment-analyzer-3` / comment-analyzer / `engine/src/handlers/helpers/review-panel.ts:18`.
- **Fix:** State that critical-bearing standalone tally atomically publishes both `outcomes.json` and `result.json`, and that both review and architecture manifests are engine-authored.
- **Regression validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts tests/prose-contract-round14.test.ts`.

### 10. Include refuted findings in wave-gate summaries

- **Source:** `architecture-tech-lead-2` / architecture-tech-lead / `engine/src/handlers/helpers/complete-wave-gate.ts:394`.
- **Fix:** Render every stored refuted finding with each refuting lens and reason in the deterministic per-task summary; add exact audit-projection tests.
- **Regression validation:** `cd engine && bunx vitest run tests/handlers/complete-wave-gate.test.ts`.

## Refuted Findings (not fixing)

None. The panel refuted 0 of 5 canonical critical findings. Minority intent-lens objections remain recorded in `.claude/reviews/review-and-fix-runs/run.ZLPfcCNxmg/result.json`, but no finding met the two-lens refutation threshold.

## Full Validation

1. `cd engine && bun run typecheck`
2. `cd engine && bun run test:unit`
3. `cd engine && bun run test:smoke`
4. `git diff --check`

Only paths from `.claude/reviews/review-and-fix-runs/run.ZLPfcCNxmg/result.json.scope`, newly created regression-test support paths added to the audited remediation set, and this plan may be staged.
