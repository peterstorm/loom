# PR Remediation Plan — Round 10

**Date:** 2026-07-05
**Branch:** feat/deterministic-core-phase-c
**Findings:** 2 critical, 18 advisory (10-agent review, determinism-focused)

## Critical Fixes

### Fix 1: Same-command report staging bypasses agent-authored-artifact veto
- **Source:** architecture-tech-lead
- **File:** engine/src/handlers/post-tool-use/record-evidence.ts:94-99 with engine/src/machine/extract-evidence.ts:558-585
- **Issue:** Veto set built from persisted ledger only; the current call's own shell-write targets aren't in it. One Bash line (`printf '{"numTotalTests":5,"numFailedTests":0}' > /tmp/r.json; npx vitest --version --outputFile=/tmp/r.json`) stages and vouches a forged trusted-pass.
- **Fix:** Union the veto set with the current command's own write targets (thread extractEvidence's already-minted FileWrite events / extractShellWriteTargets into findReportForSegment). Add one-call regression test.

### Fix 2: Spec-check gate fails open on empty/unreadable transcript
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/subagent-stop/store-spec-check-findings.ts:96
- **Issue:** `if (!transcript) return { kind: "passthrough" }` records nothing; wave-gate check 4 then passes vacuously as "skipped (no spec-check data)".
- **Fix:** Record `verdict: "EVIDENCE_CAPTURE_FAILED"` (mirroring the missing-count path) + stderr warning. Add test.

## Advisory Fixes

### Fix 3: Unquoted `&` not a segment separator — exit misattribution
- **File:** engine/src/machine/extract-evidence.ts:87 (splitter), :292 (attributeExit)
- **Fix:** Add `&` as a SegmentOp; backgrounded test segments yield exit null; tests pinning `X & Y` compositions.

### Fix 4: SubagentStart not idempotent — duplicate event disarms gate fail-open
- **File:** engine/src/machine/ledger.ts:264-269 (markAgentActive), :305-329 (bindMachineAgent)
- **Fix:** Set semantics keyed by agentId under the existing lock; skip duplicate roster/binding appends. Property/unit tests over duplicate interleavings with the fake.

### Fix 5: Bash-minted FileWrite advances guards the gate can't enforce
- **File:** engine/src/machine/extract-evidence.ts:568-570, advance.ts:16-30, types.ts
- **Fix:** Distinguish shell writes (`via: "shell"` field or distinct kind); tokensFor counts only tool-authored writes; shell writes still feed the veto. parseEvent stays fail-closed for old readers. Tests.

### Fix 6: No idempotency key on ledger appends — duplicate PostToolUse double-counts
- **File:** engine/src/handlers/post-tool-use/record-evidence.ts:101, ledger.ts:372-377
- **Fix:** Stamp `tool_use_id` as callId into evidence records; dedupe at fold (or append) on (epoch, callId). Additive wire change; old records parse as-is. Tests.

### Fix 7: missingRequirements never consulted — completion still self-reported
- **File:** engine/src/machine/advance.ts:100-107, engine/src/handlers/subagent-stop/update-task-status.ts
- **Fix:** At SubagentStop for machine-bound agents, fold the epoch snapshot and consult missingRequirements; non-empty ⇒ cap verdict at untrusted "machine-incomplete: <reqs>". Test.

### Fix 8: Veto path normalization uses current-call cwd
- **File:** engine/src/handlers/post-tool-use/record-evidence.ts:96
- **Fix:** Resolve FileWrite paths at mint time (against the minting call's cwd) rather than read time.

### Fix 9: updateGitHubIssue execSync has no timeout
- **File:** engine/src/handlers/helpers/complete-wave-gate.ts:366,373
- **Fix:** Add `timeout: 15000` to both calls.

### Fix 10: Silent catch on git rev-parse walk-up
- **File:** engine/src/config.ts:168
- **Fix:** One stderr line inside the catch.

### Fix 11: pi twin — unextractable task ID vanishes silently
- **File:** pi/extension.ts:359,447
- **Fix:** Mirror engine: WARNING + sole-executing-task inference + clear executing_tasks on ambiguity.

### Fix 12: pi twin — tool_call guard chain uncaught, undefined polarity
- **File:** pi/extension.ts:66-141
- **Fix:** try/catch around handler body; stderr naming the crashed guard; explicit block (fail-closed) polarity.

### Fix 13: pi twin — stale sweep per-file mtime + hardcoded TTL
- **File:** pi/extension.ts:147-160
- **Fix:** Reuse sweepStaleSessions + STALE_SUBAGENT_TTL_MS from the engine handler.

### Fix 14: isBindingFresh four same-typed number params
- **File:** engine/src/machine/evidence.ts:160
- **Fix:** Single named-params object `{boundAtMs, anchorMs, nowMs, ttlMs}`.

### Fix 15: readEvidence returns mutable array
- **File:** engine/src/machine/evidence.ts:264
- **Fix:** `readonly EvidenceRecord[]`, matching readBindings.

### Fix 16: mergeSummaries source homogeneity in prose only
- **File:** engine/src/machine/test-report.ts:74-87
- **Fix:** Runtime homogeneity check (return null / group by source) instead of comment.

### Fixes 17–23: Test gaps (pr-test-analyzer)
- update-task-status.ts:423 ambiguous multi-task inference branch
- utils/lock.ts:86 stealStaleLock live-lock restore path
- extract-evidence.ts backslash-escape property test for extractShellWriteTargets scanners
- store-spec-check-findings.ts malformed-stdin parity test
- types.ts:153 parseSpecCheckVerdict rejection case
- dispatch.ts:64 invalid session_id snapshot-failed labeling
- validate-task-graph.ts fixMinimal + file-arg route

## Deferred

### Task/TaskGraph/WaveGate structural refactor (readonly fields, Task.agent branding, WaveGate progression union)
- **Reason:** Cross-cutting refactor touching every handler that reads/writes the task graph; too large for a remediation round on a 13k-line PR.
- **Recommendation:** Dedicated follow-up phase; the WaveGate discriminated union should be designed alongside the wave-gate v2 work.

### ~~Call-scoped report freshness (call-start stamp)~~ — LANDED (follow-up commit, 2026-07-05)
- Implemented: PreToolUse Bash stamps tool_use_id → startMs into `<session>.callstart.json` (capped map of 32, swept via SESSION_SUFFIXES); findReport requires `mtime ≥ callStartMs − 2s` in addition to the 15-min bound; missing stamp fails closed for artifact-backed sources (stdout reporter JSON, inherently call-scoped, stays allowed); pi twin stamps in tool_call.

## Validation Commands
```bash
cd engine && bun run typecheck && bun test
```
