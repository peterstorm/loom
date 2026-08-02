# PR Remediation Plan

**Date:** 2026-08-02
**Branch:** feat/architecture-panel-mode-plan
**Findings:** 3 critical, 10 advisory (deduplicated from 6 reviewers)

## Critical Fixes

### Fix 1: Enforce the approach-gate minimum panel size
- **Source:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead
- **File:** `engine/src/config.ts:214`
- **Issue:** `clampPanelDesigners` permits one candidate although finalization requires at least two approaches.
- **Fix:** Introduce a shared minimum of two, clamp to `[2, PANEL_LENS_COUNT]`, align runbook/docs, and update boundary/property tests.

### Fix 2: Stop classifying ordinary code expressions as placeholders
- **Source:** code-reviewer, pr-test-analyzer, type-design-analyzer, architecture-tech-lead
- **File:** `engine/src/core/validate-template-substitution.ts:35`
- **Issue:** Dots and hyphens in the residual matcher block legitimate JSX/member and arithmetic expressions.
- **Fix:** Restore the shipped underscore-only template grammar and replace the widened-grammar tests with code-bearing prompt regressions.

### Fix 3: Isolate and validate panel-run artifacts
- **Source:** all six reviewers
- **File:** `commands/loom.md:213`
- **Issue:** Stable paths, existence-only checks, and directory-wide reads can admit stale interviews/candidates into a rerun.
- **Fix:** Use a unique run directory, require fresh non-empty outputs, create an exact candidate manifest, and make judges/finalizer consume only manifest-listed candidates.

## Advisory Fixes

### Fix 4: Parse interview digests before fan-out
- **Source:** silent-failure-hunter
- **File:** `commands/loom.md:219`
- **Issue:** Missing, duplicate, empty, or invalid digest labels silently degrade lens and criterion selection.
- **Fix:** Add a pure typed digest parser plus CLI helper; stop and retry the interviewer on contract errors.

### Fix 5: Parse, validate, sanitize, and aggregate judge verdicts
- **Source:** silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead
- **File:** `commands/loom.md:245`
- **Issue:** Raw LLM JSON is trusted and no deterministic multi-judge aggregation/tie-break rule exists.
- **Fix:** Add a pure typed verdict parser plus helper, validate exact candidate coverage/criterion/scores, sanitize prose, persist canonical run-scoped verdicts, and specify score/tie aggregation.

### Fix 6: Enforce the no-repanel loop-back invariant
- **Source:** type-design-analyzer, architecture-tech-lead
- **File:** `engine/src/core/validate-phase-order.ts:52`
- **Issue:** Panel identities collapse to `architecture`, so panel agents are allowed from plan-alignment despite the documented single-agent loop-back.
- **Fix:** Recognize panel agents explicitly and only allow them while `current_phase === ARCH_PANEL_PHASE`; add behavioral tests.

### Fix 7: Enforce the designer's declared skill
- **Source:** type-design-analyzer, architecture-tech-lead
- **File:** `engine/src/handlers/pre-tool-use/validate-agent-skill.ts:17`
- **Issue:** `ARCH_PANEL_AGENTS` is omitted from the skill-validation set.
- **Fix:** Include panel agents and add a registry/integration assertion.

### Fix 8: Remove unsafe dynamic prose and plugin re-resolution from templates
- **Source:** code-reviewer, silent-failure-hunter
- **File:** `commands/templates/phase-arch-interview.md`, `commands/templates/phase-arch-judge.md`, `commands/templates/phase-arch-finalize.md`
- **Issue:** Interview prose can trigger the placeholder gate, and subagents re-resolve a potentially wrong/swallowed plugin cache path.
- **Fix:** Pass validated interview/manifest paths and the already resolved `loom_dir` as explicit variables.

### Fix 9: Align candidate previews and priority semantics
- **Source:** comment-analyzer, architecture-tech-lead
- **File:** `commands/templates/phase-arch-design.md`, `agents/arch-designer-agent.md`
- **Issue:** Candidate files omit codebase fit from the promised preview and call preferences hard constraints even when lenses intentionally trade them off.
- **Fix:** Distinguish constraints from evaluation preferences and add codebase-fit to the fixed candidate format and gate preview.

### Fix 10: Correct transition and registry documentation
- **Source:** comment-analyzer
- **File:** `commands/loom.md`, `engine/src/config.ts`, architecture plan
- **Issue:** Comments confuse completed phase with transition target, overstate Set immutability, imply TS constants are invoked by markdown, and ignore `--skip-plan-alignment`.
- **Fix:** Correct comments/runbook wording and mark obsolete architecture-plan snippets as proposal snapshots.

### Fix 11: Make smoke cleanup fail visibly
- **Source:** silent-failure-hunter
- **File:** `scripts/smoke-panel-mode.sh:32`
- **Issue:** Cleanup errors are swallowed on an otherwise successful test.
- **Fix:** Preserve the original status, report cleanup failures, and fail an otherwise green run when cleanup cannot complete.

### Fix 12: Harden panel lifecycle tests
- **Source:** pr-test-analyzer
- **File:** `engine/tests/panel-config.test.ts`, `engine/tests/panel-templates.test.ts`, handler tests
- **Issue:** Existing tests encode the bad minimum and do not exercise digest/verdict contracts, exact manifests, code-bearing prompts, skill enforcement, or loop-back blocking.
- **Fix:** Add unit/property/contract tests for each remediated invariant.

### Fix 13: Clarify `fatal_flaw` nullability and persisted verdict behavior
- **Source:** comment-analyzer
- **File:** `agents/arch-judge-agent.md`, panel templates, README
- **Issue:** The JSON example quotes a value described as nullable and docs claim verdicts are never persisted despite validation needing a durable handoff.
- **Fix:** Show JSON `null`, document canonical run-scoped verdict files, and retain the outcome summary in AD-1.

## Post-Implementation Review Closure

A targeted re-review found acceptance gaps in Fixes 3, 5, 11, and 12. They were closed before commit:

- Run directories now use atomic `mktemp -d`; the helper anchors them to an explicit in-repo `panel-runs` root, rejects symlinked path components, and binds manifests to the requested N plus the exact interview-derived lens set and filenames.
- The helper verifies non-empty regular artifacts, rejects symbolic links/canonical escapes, and reports synchronous stdout failures instead of exiting successfully with empty output.
- Candidate retries repeat freshness checks, and plan-alignment loop-backs consume the exact manifest path recorded in AD-1.
- Sensitive-boundary casing is canonicalized; empty/brace-only fatal flaws are rejected.
- CLI, path-alias/symlink, skill-gate, complete-label, and template/runbook contract tests were added; smoke cleanup preserves the primary failure code.

## Deferred

### Persist every panel substage in the global task-graph state
- **Reason:** The reviewers disagreed on severity, and adding panel mode/stage/run-id to the global task-graph schema would be a broad state-machine migration rather than a minimal PR remediation. Run isolation, exact manifests, typed boundary parsers, and the current-phase panel gate close the concrete stale/malformed/loop-back failures without changing the global lifecycle schema.
- **Recommendation:** If panel orchestration moves from the markdown shell into executable engine code, model `single | panel(stage, runId)` as a discriminated union in that migration.

## Validation Commands

```bash
cd engine && bun run typecheck
cd engine && bun test
bash scripts/smoke-panel-mode.sh
git diff --check
```
