# PR Remediation Round 28 — Adjudicated Standalone Review

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.6dTHisRgF7`
- **Scope:** exactly the 244 paths listed in [Frozen scope](#frozen-scope), sourced from `result.json.scope`
- **Diff:** 44,322 additions / 2,988 deletions
- **Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead
- **Panel:** reproduction, intent, blast-radius; threshold 2
- **Adjudication:** 7 surviving criticals, 0 refuted criticals, 11 accepted advisories

All advisories are accepted for this remediation. Duplicate findings are retained as distinct source evidence but share one minimal production fix where they identify the same defect.

## Surviving critical fixes

### 1. Include committed task tests in new-test proof

- **Source:** `code-reviewer-1` — code-reviewer — `engine/src/handlers/subagent-stop/update-task-status.ts:487`
- **Claim:** Committed implementation tests are invisible because collection omits the task `start_sha`→`HEAD` diff.
- **Fix:** Extend the injected Git diff port with a path-scoped committed-diff operation, pass the locked task's validated `start_sha` through both completion and reconciliation callers, and merge committed, staged, unstaged, and attributed-untracked diffs without broadening beyond task-attributed paths.
- **Regression:** Add a collector test where only the committed diff contains a new test/assertion and prove it satisfies new-test evidence; retain the empty-attribution fail-closed test.
- **Validation:** `cd engine && bunx vitest run tests/handlers/collect-diff.test.ts tests/handlers/helpers/reconcile-implementation-proof.test.ts`

### 2. Prevent cross-task proof attribution in sequential chains

- **Source:** `code-reviewer-2` — code-reviewer — `engine/src/handlers/task-execution.ts:62`
- **Claim:** Sequential overlapping tasks share a pre-chain baseline, allowing one task's bytes to satisfy another task's proof.
- **Fix:** Fail closed on overlapping declared paths inside a multi-task sequential reservation until the harness can register a fresh baseline immediately before each child. Keep disjoint sequential chains supported and emit an actionable instruction to use separate sequential calls for path handoff.
- **Regression:** Replace the permissive overlap test with rejection coverage and verify disjoint sequential batches still register.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-task-execution.test.ts`

### 3. Persist malformed Pi reviewer evidence as evidence-capture failure

- **Sources:**
  - `code-reviewer-3` — code-reviewer — `pi/extension.ts:1231`
  - `pr-test-analyzer-1` — pr-test-analyzer — `pi/extension.ts:1231`
- **Claim:** Successful review results with malformed messages fall into a logging-only catch and lack regression coverage.
- **Fix:** Parse reviewer messages with `parsePiMessages` before dereference. On parser failure, resolve the reservation-bound/extracted task, apply the existing `evidence-failed` review resolution, log the typed diagnostic, and continue processing siblings.
- **Regression:** Add malformed array-entry and malformed block cases asserting `review_status=evidence_capture_failed`, reviewer attribution, diagnostic persistence, and healthy-sibling isolation.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/pi-test-evidence.test.ts`

### 4. Fail closed for unknown Loom-owned Pi agent names

- **Source:** `silent-failure-hunter-1` — silent-failure-hunter — `engine/src/core/model-profiles.ts:396`
- **Claim:** An unrecognized `loom:` Pi agent is classified as external and bypasses Loom policy in graphless/standalone operation.
- **Fix:** Make namespace ownership independent of catalog resolution: any unresolved `loom:` item returns `unknown-agent`; only unresolved non-Loom names may form an external batch. Preserve mixed-ownership rejection.
- **Regression:** Add single, parallel, and chain unknown-`loom:` cases plus a bare external control.
- **Validation:** `cd engine && bunx vitest run tests/core/model-profiles.test.ts tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts`

### 5. Fail closed for unknown Loom-owned Claude agent names

- **Source:** `silent-failure-hunter-2` — silent-failure-hunter — `engine/src/handlers/pre-tool-use/validate-agent-model.ts:75`
- **Claim:** A failed agent parse currently allows an unrecognized `loom:` Claude spawn without proving its model binding.
- **Fix:** Distinguish reserved Loom namespace from external utilities before the allow branch; block unknown `loom:` names with the parser's policy diagnostic and retain pass-through only for non-Loom names.
- **Regression:** Add Claude and Pi tool-input cases proving unknown `loom:` names block while genuine external names remain allowed.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-model-bindings.test.ts tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts`

### 6. Detect missing Pi review results in a reserved batch

- **Source:** `pr-test-analyzer-2` — pr-test-analyzer — `pi/extension.ts:835`
- **Claim:** A shorter `details.results` array does not persist an evidence failure for omitted reserved reviewer slots.
- **Fix:** Reconcile review reservations against returned result cardinality/slots after releasing roster entries. For each omitted reserved review item, apply `evidence-failed` to its trusted task binding; do not fabricate findings. The panel's blast-radius minority reasoning is honored: the fix targets the missing typed diagnostic, not a false claim that finalization can pass.
- **Regression:** Reserve two reviewers, return one, and assert the omitted reviewer appears in `review_evidence_failures` while the returned sibling is processed.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

## Accepted advisory fixes

### 7. Make evidence-failure review retries executable

- **Source:** `code-reviewer-4` — code-reviewer — `commands/wave-gate.md:146`
- **Fix:** Include `evidence_capture_failed` in retry selection and document reuse of the task's active packet/registration and review generation. Create a packet only when no active packet-bound run exists; re-spawn only failed/missing reviewer slots against the same packet.
- **Validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts tests/prose-contract-round14.test.ts`

### 8. Apply the same unknown-Loom rule at the skill gate

- **Source:** `silent-failure-hunter-3` — silent-failure-hunter — `engine/src/handlers/pre-tool-use/validate-agent-skill.ts:80`
- **Fix:** Block unknown `loom:` agents before the generic unvalidated-agent allow branch; preserve external utility pass-through.
- **Regression:** Add unknown reserved-namespace and external-name controls.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-agent-skill.test.ts`

### 9. Refuse successful lossy task-graph repair

- **Source:** `silent-failure-hunter-4` — silent-failure-hunter — `engine/src/handlers/helpers/validate-task-graph.ts:660`
- **Fix:** Add explicit `--accept-data-loss` parsing. Without it, return a non-zero contract error when `fixFull` reports `dataLoss`, before emitting a replacement graph; with it, emit the repaired graph and audit notes. Keep non-lossy `--fix` idempotent.
- **Regression:** Assert lossy repair fails without acknowledgment, succeeds with the flag, and a second accepted repair is byte-idempotent.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts`

### 10. Co-remediate the duplicate Pi review parsing advisory

- **Source:** `silent-failure-hunter-5` — silent-failure-hunter — `pi/extension.ts:1231`
- **Fix:** Covered by item 3; retain this source identity in audit and assertions.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 11. Prove rejected child grants block later writes

- **Source:** `pr-test-analyzer-3` — pr-test-analyzer — `pi/extension.ts:549`
- **Fix:** Add an extension integration test that triggers a rejected child write grant, then emits Edit and Write tool calls in the same child session and proves both are blocked by the persisted rejected-session capability state.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/pi-write-grant.test.ts`

### 12. Parse artifact baseline paths canonically and align them with file_list

- **Source:** `type-design-analyzer-1` — type-design-analyzer — `engine/src/core/artifact-baseline.ts:8`
- **Fix:** Route persisted baseline artifacts through the canonical repository-relative path parser and require `artifact_baseline` (not only attempt baseline) to match `file_list` exactly in order at the state boundary. Keep attempt baseline's allowed appended modified paths.
- **Regression:** Reject absolute, traversal, aliased, duplicate, and file-list-drift baseline paths.
- **Validation:** `cd engine && bunx vitest run tests/core/artifact-baseline.test.ts tests/state-manager.test.ts`

### 13. Construct parsed Pi transcript values instead of casting unknown input

- **Source:** `type-design-analyzer-2` — type-design-analyzer — `pi/transcript-adapter.ts:82`
- **Fix:** Model known content blocks as a discriminated union, validate required text/tool-call/tool-result fields, copy parser-proven values into fresh immutable message objects, and retain opaque typed blocks only through an explicit safe representation.
- **Regression:** Reject malformed text/tool-call fields and prove returned values are normalized copies consumed safely by both adapters.
- **Validation:** `cd engine && bunx vitest run tests/pi-test-evidence.test.ts tests/pi-extension-review-events.test.ts`

### 14. Share task-agent validity at the load boundary

- **Source:** `type-design-analyzer-3` — type-design-analyzer — `engine/src/state-manager.ts:151`
- **Fix:** Parse `Task.agent` against the shared `KNOWN_AGENTS` authority during `parseTaskGraph`, so loader and operator validator accept the same state space.
- **Regression:** Add loader tests for unknown, blank, and known agents and parity coverage with `validateFull`.
- **Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/validate-task-graph.test.ts`

### 15. Publish panel tally artifacts through no-follow atomic helpers

- **Source:** `architecture-tech-lead-1` — architecture-tech-lead — `engine/src/handlers/helpers/review-panel.ts:569`
- **Fix:** Add shared exclusive/no-follow staging and atomic publish operations in `panel-run.ts`. Use them for standalone result/outcomes and wave closure/outcomes while preserving replay markers and crash-dead-end semantics.
- **Regression:** Exercise final-leaf symlink swaps and verify outside targets remain unchanged for both standalone and wave tally publication.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/panel-run.test.ts tests/handlers/helpers/review-panel.test.ts tests/handlers/helpers/standalone-review.test.ts`

### 16. Stamp implementation completion on a passing wave gate

- **Source:** `architecture-tech-lead-2` — architecture-tech-lead — `engine/src/handlers/helpers/complete-wave-gate.ts:384`
- **Fix:** Set `impl_complete: true` in the pure pass transition and preserve idempotency.
- **Regression:** Start from a contradictory false flag, apply the pass twice, and assert a stable true gate.
- **Validation:** `cd engine && bunx vitest run tests/handlers/complete-wave-gate.test.ts`

### 17. Match AuthoredDag nodes structurally

- **Source:** `architecture-tech-lead-3` — architecture-tech-lead — `engine/src/handlers/helpers/validate-model-bindings.ts:122`
- **Fix:** Parse each sidecar node as an object with a non-empty `id`, derive the exact identity set, fail closed on unknown/malformed node shapes, and compare declared plan nodes only against that set. Update prose that currently claims substring matching.
- **Regression:** Prove an id in metadata/description does not satisfy a declared node, duplicate/malformed ids fail, and exact ids pass.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-model-bindings.test.ts tests/runbook-contract.test.ts`

## Refuted Findings (not fixing)

None. `result.json.refuted_critical_findings` is empty.

Panel audit note: `standalone-review:pr-test-analyzer-2` received one blast-radius refutation — “A missing result is not lost from review authority… the valid narrower issue is missing evidence_capture_failed diagnostics” — but survived with reproduction and intent votes. The remediation is deliberately narrowed to that diagnostic/state defect.

## Full validation and delivery

1. `cd engine && npm run typecheck`
2. `cd engine && npm run test:unit`
3. `cd engine && npm run test:smoke`
4. `git diff --check`
5. Stage only the audited remediation path set plus this plan; verify staged names equal the allowlist.
6. Commit and push normally; never force-push.

## Frozen scope

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
