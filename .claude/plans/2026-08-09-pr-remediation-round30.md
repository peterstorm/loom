# PR Remediation — Round 30

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Base:** `main`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.Wu4DEgBQ0T`
- **Adjudicated result:** `.claude/reviews/review-and-fix-runs/run.Wu4DEgBQ0T/result.json`
- **Frozen scope:** 247 paths; exact list below
- **Panel:** reproduction, intent, security; threshold 2
- **Outcome:** 4 surviving criticals, 0 refuted criticals, 8 advisories

## Remediation order

### 1. Block external Pi subagents under session-scoped orchestration

- **Source:** `silent-failure-hunter-1` / `silent-failure-hunter`
- **Location:** `pi/extension.ts:289`
- **Claim:** External Pi subagents can bypass Loom gates during active child sessions because the external branch checks only `taskGraphPath()` and ignores the per-session task-graph pointer.
- **Minimal fix:** derive one active-graph predicate from the local graph, rejected child grant, and parsed session pointer; use it for Bash and external-subagent gating.
- **Regression validation:** targeted Pi extension tests covering an external agent in a child session with only the session pointer, plus `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`.

### 2. Detect and persist undeclared repository changes from failed attempts

- **Source:** `code-reviewer-1` / `code-reviewer`
- **Location:** `pi/extension.ts:773`
- **Claim:** Failed Pi implementation attempts can leave newly modified paths outside the attempt baseline untracked while preserving stale green task/review/spec evidence.
- **Minimal fix:** capture a compact spawn-time baseline of Git-visible changed paths, compare it after an attempt to detect newly dirty, reverted, deleted, or byte-changed paths, persist conservatively attributed paths, and invalidate stale proof/review/spec evidence whenever repository bytes changed. Keep the comparison in the shared artifact-baseline shell and the state decision in the existing pure stop-resolution core.
- **Regression validation:** utility tests for clean→dirty, dirty→changed, dirty→clean, deletion, and new untracked paths; Pi lifecycle regression proving a failed child that creates an undeclared file invalidates stale evidence and adds the path to `files_modified`.

### 3. Fail closed when reserved implementation finalization cannot persist

- **Sources:** `silent-failure-hunter-2` / `silent-failure-hunter`; accepted duplicate advisory `code-reviewer-2` / `code-reviewer`
- **Location:** `pi/extension.ts:799`
- **Claim:** Reserved implementation finalization failures are swallowed after stderr logging, allowing the tool result to look successful while lifecycle state remains unapplied.
- **Minimal fix:** return finalization diagnostics as data, merge them into the existing caller-visible processing-error channel, and return `isError: true` without losing per-result isolation.
- **Regression validation:** Pi extension regression with a missing/unavailable state manager or injected persistence failure, asserting a caller-visible error result and no false success.

### 4. Constrain evidence-capture failures to retryable reviewer identities

- **Source:** `type-design-analyzer-1` / `type-design-analyzer`
- **Location:** `engine/src/core/findings.ts:797`
- **Claim:** `review_evidence_failures` accepts arbitrary non-empty strings, allowing a loadable failed state no configured reviewer can clear.
- **Minimal fix:** make `evidenceFailureError` require active-run failures to belong to `review_run.expected_agents` and legacy failures to belong to the configured review-agent roster; pass the roster explicitly from state/validator shells.
- **Regression validation:** state-manager and validator tests rejecting unknown legacy identities and failures outside an active run's expected set while accepting valid configured/expected reviewers.

### 5. Resolve review authority under the state lock (accepted advisory)

- **Source:** `architecture-tech-lead-2` / `architecture-tech-lead`
- **Locations:** `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:95`, `pi/extension.ts:1317`
- **Claim:** Review evidence is parsed against a pre-lock task authority and applied to the locked current task, allowing review run/generation/scope drift.
- **Minimal fix:** read transcript bytes outside the lock, but run `resolveTaskReviewFindings` and scope constraint inside `StateManager.update` against the current task in both harnesses.
- **Regression validation:** Claude and Pi TOCTOU tests proving stale packet evidence is ignored and current scope authority is used after a concurrent task change.

### 6. Enforce actual byte equality for generated Pi agents (accepted advisories)

- **Sources:** `comment-analyzer-1`, `comment-analyzer-2` / `comment-analyzer`
- **Locations:** `engine/src/utils/render-pi-agent.ts:60`, `README.md:867`
- **Claims:** Code/docs say byte-for-byte while validation compares UTF-8-decoded strings.
- **Minimal fix:** read the generated file as bytes and compare it with the UTF-8 bytes of the deterministic render, preserving the stronger documented integrity contract.
- **Regression validation:** `engine/tests/utils/render-pi-agent.test.ts`, including invalid UTF-8 byte mismatch coverage.

### 7. Repair panel-phase and Pi resource documentation (accepted advisories)

- **Sources:** `type-design-analyzer-2`, `comment-analyzer-3`, `comment-analyzer-4`
- **Locations:** `engine/src/config.ts:147`, `engine/tests/panel-config.test.ts:254`, `docs/pi-usage.md:31`, `README.md:864`
- **Claims:** panel tests still describe a retired derivation; Pi mode docs omit `PI_CODING_AGENT_DIR` as a selector; README omits `references/` and `rules/` from rendered resource trees.
- **Minimal fix:** align test prose with the intentional singleton phase policy, document both Pi selectors accurately, and list all four rendered source trees.
- **Regression validation:** panel config/prose/resource contract tests plus repository text search for stale `derivePanelPhase` claims.

## Advisory deferred

- **`architecture-tech-lead-1`** — Wave tally publishes closure/outcomes before task-state mutation. The existing ordering is an explicit fail-closed anti-replay policy and changing it requires a separately designed, crash-recoverable commit protocol plus compatibility semantics, not a minimal PR remediation. No code change in this run.

## Refuted Findings (not fixing)

None. The panel retained all four canonical critical findings. The intent lens refuted `standalone-review:code-reviewer-1` because the old declared-path-only policy was documented, but reproduction and security upheld it; at threshold 2 it survives and is fixed.

## Validation

1. Targeted: `cd engine && bunx vitest run tests/utils/artifact-baseline.test.ts tests/pi-extension-review-events.test.ts tests/handlers/pi-stop-toctou.test.ts tests/handlers/subagent-stop/store-reviewer-findings.test.ts tests/handlers/validate-task-graph.test.ts tests/state-manager.test.ts tests/utils/render-pi-agent.test.ts tests/panel-config.test.ts`
2. Typecheck: `cd engine && bun run typecheck`
3. Full unit + smoke suite: `cd engine && bun run test`
4. Working-tree audit: compare staged paths exactly with the remediation allowlist; never stage standalone run evidence.

## Exact frozen review scope

- `.claude/plans/2026-07-16-architecture-panel-mode.md`
- `.claude/plans/2026-07-17-pr-remediation-round5.md`
- `.claude/plans/2026-07-17-pr-remediation-round6.md`
- `.claude/plans/2026-07-17-pr-remediation.md`
- `.claude/plans/2026-07-18-pr-remediation-round7.md`
- `.claude/plans/2026-07-18-pr-remediation-round8.md`
- `.claude/plans/2026-08-02-adversarial-review-panel.md`
- `.claude/plans/2026-08-02-pr-remediation-review-panel.md`
- `.claude/plans/2026-08-02-pr-remediation-round12.md`
- `.claude/plans/2026-08-02-pr-remediation-round13.md`
- `.claude/plans/2026-08-02-pr-remediation-round14.md`
- `.claude/plans/2026-08-02-pr-remediation.md`
- `.claude/plans/2026-08-03-model-profiles-proof-driven-quality.md`
- `.claude/plans/2026-08-03-pr-remediation-round15.md`
- `.claude/plans/2026-08-04-pr-remediation-round16.md`
- `.claude/plans/2026-08-04-pr-remediation-round17.md`
- `.claude/plans/2026-08-04-pr-remediation-round18.md`
- `.claude/plans/2026-08-04-pr-remediation-round19.md`
- `.claude/plans/2026-08-04-pr-remediation-round20.md`
- `.claude/plans/2026-08-04-pr-remediation-round21.md`
- `.claude/plans/2026-08-04-pr-remediation-round22.md`
- `.claude/plans/2026-08-04-pr-remediation.md`
- `.claude/plans/2026-08-05-pr-remediation.md`
- `.claude/plans/2026-08-09-pr-remediation-round23.md`
- `.claude/plans/2026-08-09-pr-remediation-round24.md`
- `.claude/plans/2026-08-09-pr-remediation-round25.md`
- `.claude/plans/2026-08-09-pr-remediation-round26.md`
- `.claude/plans/2026-08-09-pr-remediation-round27.md`
- `.claude/plans/2026-08-09-pr-remediation-round28.md`
- `.claude/plans/2026-08-09-pr-remediation-round29.md`
- `.claude/plans/2026-08-09-pr-remediation.md`
- `.gitignore`
- `CONTEXT.md`
- `README.md`
- `agents/adr-writer-agent.md`
- `agents/arch-designer-agent.md`
- `agents/arch-interviewer-agent.md`
- `agents/arch-judge-agent.md`
- `agents/architecture-agent.md`
- `agents/architecture-tech-lead.md`
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
- `commands/loom.md`
- `commands/review-and-fix.md`
- `commands/review-pr.md`
- `commands/specify.md`
- `commands/templates/impl-agent-context.md`
- `commands/templates/phase-arch-design.md`
- `commands/templates/phase-arch-finalize.md`
- `commands/templates/phase-arch-interview.md`
- `commands/templates/phase-arch-judge.md`
- `commands/templates/phase-architecture.md`
- `commands/templates/review-verify.md`
- `commands/wave-gate.md`
- `docs/deterministic-core.md`
- `docs/migration-claude-code-to-pi.md`
- `docs/pi-usage.md`
- `engine/.gitignore`
- `engine/package.json`
- `engine/src/cli.ts`
- `engine/src/config.ts`
- `engine/src/core/agent-skills.ts`
- `engine/src/core/artifact-baseline.ts`
- `engine/src/core/block-direct-edits.ts`
- `engine/src/core/findings.ts`
- `engine/src/core/harness-resources.ts`
- `engine/src/core/index.ts`
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
- `engine/src/core/spec-check.ts`
- `engine/src/core/standalone-review.ts`
- `engine/src/core/tool-vocabulary.ts`
- `engine/src/core/validate-phase-order.ts`
- `engine/src/core/validate-task-execution.ts`
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
- `engine/src/handlers/helpers/reconcile-implementation-proof.ts`
- `engine/src/handlers/helpers/repair-task-graph.ts`
- `engine/src/handlers/helpers/review-packet.ts`
- `engine/src/handlers/helpers/review-panel.ts`
- `engine/src/handlers/helpers/standalone-review.ts`
- `engine/src/handlers/helpers/store-review-findings.ts`
- `engine/src/handlers/helpers/store-spec-check.ts`
- `engine/src/handlers/helpers/validate-model-bindings.ts`
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
- `engine/src/handlers/task-execution.ts`
- `engine/src/machine/extract-evidence.ts`
- `engine/src/machine/test-report.ts`
- `engine/src/parsers/parse-transcript.ts`
- `engine/src/state-manager.ts`
- `engine/src/types.ts`
- `engine/src/utils/agent-definition.ts`
- `engine/src/utils/agent-transcript-path.ts`
- `engine/src/utils/artifact-baseline.ts`
- `engine/src/utils/git.ts`
- `engine/src/utils/loom-package-root.ts`
- `engine/src/utils/render-pi-agent.ts`
- `engine/src/utils/repository-path.ts`
- `engine/tests/core/agent-skills.test.ts`
- `engine/tests/core/artifact-baseline.test.ts`
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
- `engine/tests/core/review-remediation-lifecycle.test.ts`
- `engine/tests/core/round15.test.ts`
- `engine/tests/core/standalone-review.test.ts`
- `engine/tests/handlers/check-lifecycle-artifacts.test.ts`
- `engine/tests/handlers/collect-diff.test.ts`
- `engine/tests/handlers/complete-wave-gate.test.ts`
- `engine/tests/handlers/dispatch.test.ts`
- `engine/tests/handlers/helpers/lint-wave-gate.test.ts`
- `engine/tests/handlers/helpers/panel-contract.test.ts`
- `engine/tests/handlers/helpers/panel-run.test.ts`
- `engine/tests/handlers/helpers/quality-programs.test.ts`
- `engine/tests/handlers/helpers/reconcile-implementation-proof.test.ts`
- `engine/tests/handlers/helpers/repair-task-graph.test.ts`
- `engine/tests/handlers/helpers/review-cleanup-diagnostics.test.ts`
- `engine/tests/handlers/helpers/review-panel-multitask.test.ts`
- `engine/tests/handlers/helpers/review-panel.test.ts`
- `engine/tests/handlers/helpers/standalone-review.test.ts`
- `engine/tests/handlers/helpers/store-spec-check.test.ts`
- `engine/tests/handlers/pi-stop-toctou.test.ts`
- `engine/tests/handlers/populate-task-graph.test.ts`
- `engine/tests/handlers/pre-tool-use/block-direct-edits.test.ts`
- `engine/tests/handlers/pre-tool-use/spawn-gate-tool-names.test.ts`
- `engine/tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts`
- `engine/tests/handlers/pre-tool-use/validate-agent-skill.test.ts`
- `engine/tests/handlers/pre-tool-use/validate-task-execution.test.ts`
- `engine/tests/handlers/pre-tool-use/validate-template-substitution.test.ts`
- `engine/tests/handlers/review-findings-parity.test.ts`
- `engine/tests/handlers/store-review-findings.test.ts`
- `engine/tests/handlers/store-reviewer-findings.test.ts`
- `engine/tests/handlers/store-spec-check-findings.test.ts`
- `engine/tests/handlers/subagent-stop/advance-phase.test.ts`
- `engine/tests/handlers/subagent-stop/dispatch-resilience.test.ts`
- `engine/tests/handlers/subagent-stop/store-reviewer-findings.test.ts`
- `engine/tests/handlers/subagent-stop/update-task-status-machine.test.ts`
- `engine/tests/handlers/tally-gate-composition.test.ts`
- `engine/tests/handlers/update-task-status.test.ts`
- `engine/tests/handlers/validate-model-bindings.test.ts`
- `engine/tests/handlers/validate-phase-order.test.ts`
- `engine/tests/handlers/validate-task-graph.property.test.ts`
- `engine/tests/handlers/validate-task-graph.test.ts`
- `engine/tests/impl-agent-skill-contract.test.ts`
- `engine/tests/machine/advance.property.test.ts`
- `engine/tests/machine/extract-evidence.test.ts`
- `engine/tests/machine/hooks-sync.test.ts`
- `engine/tests/machine/test-report.test.ts`
- `engine/tests/panel-config.test.ts`
- `engine/tests/panel-templates.test.ts`
- `engine/tests/parsers/parse-plan-models.property.test.ts`
- `engine/tests/parsers/parsers.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `engine/tests/pi-imports.test.ts`
- `engine/tests/pi-resources.test.ts`
- `engine/tests/pi-test-evidence.test.ts`
- `engine/tests/pi-write-grant.test.ts`
- `engine/tests/prose-contract-round14.test.ts`
- `engine/tests/review-agent-contract.test.ts`
- `engine/tests/review-panel-config.test.ts`
- `engine/tests/review-panel-templates.test.ts`
- `engine/tests/runbook-contract.test.ts`
- `engine/tests/runtime-resource-portability.test.ts`
- `engine/tests/scripts/run-model-calibration.test.ts`
- `engine/tests/state-manager.test.ts`
- `engine/tests/utils/agent-transcript-path.test.ts`
- `engine/tests/utils/artifact-baseline.test.ts`
- `engine/tests/utils/git.test.ts`
- `engine/tests/utils/render-pi-agent.test.ts`
- `hooks/hooks.json`
- `package.json`
- `pi/extension.ts`
- `pi/loom-bridge.ts`
- `pi/resources.ts`
- `pi/transcript-adapter.ts`
- `pi/write-grant.ts`
- `references/executable-models.md`
- `references/panel-lenses.md`
- `references/review-lenses.md`
- `scripts/run-model-calibration.ts`
- `scripts/smoke-panel-mode.sh`
- `scripts/smoke-pi-resources.sh`
- `scripts/smoke-review-panel.sh`
- `scripts/smoke-standalone-review.sh`
- `scripts/sync-pi-agents.sh`
- `skills/lint-project/SKILL.md`
- `skills/lint-project/references/runner.md`
- `skills/review-and-fix/SKILL.md`
