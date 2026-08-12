# PR Remediation Plan — 2025-08-12

**Branch:** `feat/architecture-panel-mode-plan`  
**Review Run:** `run.31smyKgPLQ`  
**Run Directory:** `.claude/reviews/review-and-fix-runs/run.31smyKgPLQ`

## Surviving Critical Findings (mandatory)

### C1: block-direct-edits.ts:40 — Active roster grants write to review agents
**Panel votes:** reproduction=upheld, intent=refuted, security=upheld (2/3 upheld)

The `.active` file size check allows ANY active subagent to write, including
read-only review agents. The fix is to read the `.active` roster content and
verify the active agent is from `IMPL_AGENTS` (not `REVIEW_AGENTS` or verifiers).

**Fix:** Read the roster lines, check at least one is in `IMPL_AGENTS`. If only
review/verifier agents are active, keep blocking. Import `IMPL_AGENTS` from config.

### C2: orchestration-programs.ts:1506 — resumeRemediationFacade unverified done
**Panel votes:** 3/3 upheld

The resume path checks `raw.state.state === "done"` without parsing or validating
the remediation receipt. It fabricates a synthetic `verified-index-installed` outcome.

**Fix:** Replace the shallow check with `parseRemediationState` or at minimum
validate that the nested checkpoint contains the required `installationReceipt`
and `verifiedPaths` fields before returning done.

### C3: orchestration-programs.ts:1773 — finalizeStandaloneState ignores receipt failure
**Panel votes:** reproduction=upheld, intent=upheld, security=refuted (2/3 upheld)

`await handle.recordReceipt(receipt)` result is discarded. If recording fails,
the checkpoint is still written as done — losing the publication audit trail.

**Fix:** Check the `DomainResult` from `recordReceipt`. If it fails, return
`failed(...)` instead of proceeding to checkpoint the done state.

### C4: pi/extension.ts:582 — graphIsActive fail-open on unreadable paths
**Panel votes:** 3/3 upheld

`existsSync(taskGraphPath())` returns `false` for permission-denied or symlink-loop
paths, making `graphIsActive` false and disabling all orchestration guards.

**Fix:** Replace `existsSync` with a helper that fails closed — treating
`EACCES`, `ELOOP`, and other non-ENOENT errors as "active" (blocked state).

## Accepted Advisories

### A2: pi/extension.ts:315 — recordPiRequestCaptureRejection silent returns
**Fix:** Add `process.stderr.write(...)` diagnostics before each early return.

### A9: README.md:217 — spec_anchors overstated as mandatory
**Fix:** Change "Each task records spec anchors" to "Each task may record spec anchors".

### A10: store-reviewer-findings.ts:89 — Stale bug-description comment
**Fix:** Rewrite comment to describe the current guard behavior.

## Refuted Criticals
None.

## Validation Commands
```bash
cd engine && bun test
bun run typecheck  # if available
```
