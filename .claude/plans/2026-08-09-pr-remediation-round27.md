# Adjudicated PR Remediation — Round 27 — 2026-08-09

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.ge2uJEcwwH`
- **Exact frozen scope:** the 243 paths in `result.json.scope`
- **Diff reviewed:** 43,376 additions, 2,965 deletions; TypeScript, Markdown, JSON, Bash, package/config files
- **Panel:** `reproduction`, `intent`, `security`; strict-majority threshold 2
- **Adjudication:** 7 canonical critical entries survived; 0 were refuted; 9 advisories were accepted
- **Duplicate handling:** four independently attributed critical entries describe the same Pi evidence-provenance defect. All remain audited below and are discharged by one production fix plus one regression family; no finding is removed or manually deduplicated.

## Remediation order

### 1. Preserve Pi test-evidence provenance

- **Sources:**
  - `code-reviewer-1` (`code-reviewer`), `pi/extension.ts:1091` — fallback evidence is mislabeled `pi-structured`.
  - `silent-failure-hunter-1` (`silent-failure-hunter`), `pi/extension.ts:1091` — fallback evidence can satisfy proof obligations.
  - `pr-test-analyzer-1` (`pr-test-analyzer`), `pi/extension.ts:1091` — the extension consumer path lacks a regression.
  - `type-design-analyzer-1` (`type-design-analyzer`), `pi/extension.ts:1091` — the wrapper is tested instead of its nullable value.
- **Minimal fix:** bind `structuredEvidence.value` once; use it both to select evidence and to construct provenance. Emit `pi-structured:` only for non-null parser-proven paired tool evidence; retain `transcript-regex (fallback)` otherwise.
- **Regression:** drive print-only, `|| true`, and piped test-looking commands through the Pi implementation-result consumer and prove their fallback evidence cannot satisfy the Pi structured proof policy; retain a positive paired-tool-result case.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/pi-test-evidence.test.ts tests/core/proof-obligations.test.ts`

### 2. Invalidate stale implementation evidence when Pi transcript capture fails

- **Source:** `code-reviewer-2` (`code-reviewer`), `pi/extension.ts:1003` — malformed successful retry evidence can preserve stale proof/review state after bytes change.
- **Minimal fix:** make the malformed-transcript branch use the same attempt-baseline comparison and untrusted stop-resolution invalidation semantics as other failed evidence attempts. A changed implemented task must become pending with stale proof, review, spec-check, and wave-gate evidence cleared; unchanged attempts retain valid prior evidence.
- **Regression:** cover malformed Pi messages for changed and unchanged retries of implemented tasks and assert cleanup of `executing_tasks` plus the correct evidence transition.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts tests/pi-test-evidence.test.ts tests/handlers/subagent-stop/update-task-status-machine.test.ts`

### 3. Revalidate execution authority under the state lock

- **Source:** `silent-failure-hunter-2` (`silent-failure-hunter`), `engine/src/handlers/task-execution.ts:86` — eligibility is checked only before locking.
- **Minimal fix:** inside `StateManager.update`, reparse task bindings from the current graph, recheck ownership and `taskExecutionDecision`, and compare each current task's baseline scope with the preflight scope before registering any execution. Keep the batch atomic: any stale task blocks the whole batch and writes no baseline or execution marker.
- **Regression:** mutate dependency status/current wave/review gate/task existence and artifact scope between preflight and the locked update; prove each stale reservation is rejected without ghost state.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-task-execution.test.ts tests/handlers/pi-stop-toctou.test.ts`

### 4. Fail closed for rejected Pi child write grants

- **Source:** `silent-failure-hunter-3` (`silent-failure-hunter`), `pi/extension.ts:203` — stale active-roster cleanup can authorize a rejected session.
- **Minimal fix:** make membership in `rejectedChildWriteGrantSessions` an unconditional direct-edit denial before `shouldBlockDirectEdit`; do not represent rejection merely as task-graph existence. Preserve the existing Bash state-file guard behavior.
- **Regression:** simulate grant rejection plus failed/stale active-roster cleanup and prove edit/write/multi_edit remain blocked.
- **Validation:** `cd engine && bunx vitest run tests/pi-write-grant.test.ts tests/pi-extension-review-events.test.ts tests/handlers/pre-tool-use/block-direct-edits.test.ts`

## Accepted advisories

### 5. Parse Pi transcript payloads from `unknown`

- **Source:** `code-reviewer-3` (`code-reviewer`), `pi/transcript-adapter.ts:39` — non-array/non-object payloads throw before typed validation.
- **Minimal fix:** accept `unknown` at exported transcript boundaries, validate the top-level array and each message/content object before dereferencing, and return accumulated typed errors.
- **Regression:** property/table tests for null, primitives, objects, malformed arrays, and valid messages through both adapter exports.
- **Validation:** `cd engine && bunx vitest run tests/pi-test-evidence.test.ts tests/pi-imports.test.ts`

### 6. Reject non-canonical stored finding IDs

- **Source:** `code-reviewer-4` (`code-reviewer`), `engine/src/core/findings.ts:357` — surrounding whitespace is accepted but retained raw state later breaks brief parsing.
- **Minimal fix:** require the raw ID to equal its trimmed representation before parsing, while retaining agent normalization behavior.
- **Regression:** reject leading/trailing whitespace at load/repair boundaries and prove valid IDs still round-trip into panel briefs.
- **Validation:** `cd engine && bunx vitest run tests/core/findings.test.ts tests/handlers/validate-task-graph.test.ts tests/core/review-panel.test.ts`

### 7. Fail closed when a Loom agent definition cannot be resolved

- **Source:** `silent-failure-hunter-4` (`silent-failure-hunter`), `engine/src/handlers/pre-tool-use/validate-agent-skill.ts:109` — validated Loom agents currently skip skill enforcement.
- **Minimal fix:** block unresolved agents in `VALIDATED_AGENTS`; preserve allow behavior for unvalidated external utility agents. Return an actionable package-root/sync diagnostic.
- **Regression:** cover unresolved validated agents as blocked and unresolved external agents as allowed.
- **Validation:** `cd engine && bunx vitest run tests/handlers/pre-tool-use/validate-agent-skill.test.ts tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts`

### 8. Make StateManager writes validated and diagnostically lossless

- **Sources:**
  - `silent-failure-hunter-5` (`silent-failure-hunter`), `engine/src/state-manager.ts:531` — temp cleanup errors are swallowed and chmod may mask the primary failure.
  - `architecture-tech-lead-3` (`architecture-tech-lead`), `engine/src/state-manager.ts:527` — produced graphs are persisted without runtime parsing.
- **Minimal fix:** parse the produced graph before serialization/rename; reject invalid output without replacing authority. Preserve the primary write error, aggregate temp-cleanup failures, and report permission-restoration failure without replacing an earlier cause. Avoid retry ambiguity after successful rename.
- **Regression:** invalid transform, write failure plus cleanup failure, successful rename plus chmod failure, and ordinary success/lock restoration.
- **Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/validate-task-graph.property.test.ts`

### 9. Align PR review scope documentation with committed branch changes

- **Sources:**
  - `comment-analyzer-1` (`comment-analyzer`), `commands/review-pr.md:39` — `git status` misses committed PR changes.
  - `comment-analyzer-2` (`comment-analyzer`), inferred `commands/review-pr.md:39` from its canonical claim — duplicate marker describes the same mismatch.
- **Minimal fix:** document the same explicit scope rule used by standalone review: `--files`, otherwise the sorted union of unstaged, staged, and `main...HEAD` changed paths; empty scope fails.
- **Validation:** `cd engine && bunx vitest run tests/runbook-contract.test.ts tests/prose-contract-round14.test.ts`

### 10. Make standalone brief construction preserve its own invariant

- **Source:** `architecture-tech-lead-1` (`architecture-tech-lead`), `engine/src/core/review-panel.ts:313` — an arbitrary subject ID can produce a self-invalid standalone brief.
- **Minimal fix:** remove the caller-controlled standalone subject or narrow it to `typeof STANDALONE_REVIEW_SUBJECT`; always use the reserved subject for task IDs and finding IDs.
- **Regression:** every standalone constructor output round-trips through `serializeFindingBrief` and `parseFindingBriefJson`; non-standalone subjects are unrepresentable/rejected.
- **Validation:** `cd engine && bunx vitest run tests/core/review-panel.test.ts tests/core/standalone-review.test.ts`

### 11. Recheck full Review Packet authority before binding

- **Source:** `architecture-tech-lead-2` (`architecture-tech-lead`), `engine/src/handlers/helpers/review-packet.ts:217` — lock-time binding checks only generation and prior finding IDs.
- **Minimal fix:** derive a canonical task-authority snapshot for every task-derived packet input (identity metadata, scope, modified paths, plan/spec/proof context, generation and prior findings), compare it under the locked update, and reject drift before registration. Recheck repository HEAD and artifact identity immediately before bind or include their canonical digest in the same authority comparison.
- **Regression:** mutate file scope, modified paths, proof obligations, plan context, metadata, HEAD, and artifact bytes between construction and binding; prove packet cleanup and no active registration.
- **Validation:** `cd engine && bunx vitest run tests/core/review-packet.test.ts tests/handlers/helpers/review-panel.test.ts tests/handlers/pi-stop-toctou.test.ts`

## Refuted Findings (not fixing)

None. The tally published zero `refuted_critical_findings`. The intent lens voted to refute `standalone-review:silent-failure-hunter-2` because the preflight/locked-registration split is documented, but reproduction upheld the concrete race and security was uncertain; with threshold 2 the finding survived and remains mandatory.

## Full validation

```bash
cd engine
npm run typecheck
npm run test
```

Also run repository formatting/lint checks when detected, inspect `git diff --check`, and stage only the audited remediation path set plus this plan.
