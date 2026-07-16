# PR Remediation Plan — Round 4

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-c (PR #16)
**Findings:** 8 critical, 21 advisory (6 agents: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead)

## Critical Fixes

### Fix 1: store-test-evidence launders untrusted pass over trusted verdict
- **Source:** code-reviewer
- **File:** engine/src/handlers/helpers/store-test-evidence.ts:24-43
- **Issue:** Whitelisted helper unconditionally overwrites `test_result`; an agent can replace a ledger-derived `trusted-fail` with `{verdict: "untrusted", passed: true}`, which the wave gate accepts.
- **Fix:** Refuse to overwrite an existing trusted-pass/trusted-fail result (mirror update-task-status's skip guard); print a note when skipping. Test.

### Fix 2: fail-closed gate fails OPEN on crashes outside the handler
- **Source:** silent-failure-hunter
- **File:** engine/src/cli.ts:139-141
- **Issue:** `main().catch` exits 1 — non-blocking for PreToolUse. Import failure/stdin error silently disarms the gate.
- **Fix:** Derive failure polarity from argv before running: for `pre-tool-use enforce-phase-tools`, top-level catch exits 2. Test.

### Fix 3: gate silently disarms when bound machine can't load
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/pre-tool-use/enforce-phase-tools.ts:91
- **Issue:** `loaded.kind === "none"` for a *bound* agent passes through silently. Reachable via MACHINES_DIR env drift (bind uses import-time constant, gate uses call-time fn) or deletion of the machine file via unguarded Bash.
- **Fix:** Block (fail-closed) with "machine definition vanished" message; unify bind to call-time `machinesDir()`; add machines dir to STATE_FILE_PATTERNS. Update stale-binding test to pin the new behavior.

### Fix 4: uncaught markAgentActive failure corrupts attribution
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/subagent-start/mark-subagent-active.ts:48-50
- **Issue:** Lock/fs failure aborts bind + `.task_graph` write and leaves agent off the roster → cross-crediting into another epoch.
- **Fix:** try/catch around markAgentActive; on roster failure log and skip bindMachineAgent (unsound roster must not coexist with armed binding), but still write `.task_graph` path. Test.

### Fix 5: GATE_WIRED_TOOLS ↔ hooks.json sync is comment-only
- **Source:** pr-test-analyzer + architecture-tech-lead
- **File:** engine/src/machine/types.ts:72, hooks/hooks.json
- **Fix:** New test reading hooks/hooks.json asserting (a) every GATE_WIRED_TOOLS entry has a PreToolUse matcher wiring enforce-phase-tools.sh, (b) record-evidence.sh PostToolUse matcher covers {Read, Bash} ∪ FILE_MODIFYING_TOOLS.

### Fix 6: quote-unaware command splitting mints forged trusted-pass
- **Source:** type-design-analyzer (verified end-to-end)
- **File:** engine/src/machine/extract-evidence.ts:23-31
- **Issue:** Separators inside quoted strings split anyway; `true "; npx vitest --reporter=json "; echo '{...}'` classifies as a test run → trusted-pass. Also no word boundary on runner head-match ("npm testify", "mvn -pl core install").
- **Fix:** Refuse to classify segments with unbalanced quotes/backticks; require token boundary after runner pattern; ensure `mvn -pl <module> install` (no test goal) doesn't classify. Property test with runner patterns embedded in quoted strings + boundary negative tests.

### Fix 7+8: stale "five checks" enumeration (docs)
- **Source:** comment-analyzer
- **Files:** commands/wave-gate.md:182, README.md:244
- **Fix:** Document the sixth check (lifecycle machine artifacts, fail-closed unreadable plan); align ordering with evaluation order.

## Advisory Fixes

1. cleanup-stale-subagents.ts:21 — judge staleness by group max mtime across .machine/.active/.evidence.jsonl, not per-file.
2. report-discovery.ts:37-68 — log swallowed fs errors to stderr; document planted-artifact channel in machines/README.md residual limits.
3. complete-wave-gate.ts:145-206 — lifecycle existence check honors suffix-matched task file_list variants (snapshotGateDeps stats them too).
4. extract-evidence.ts:83-96 — don't mint FileRead/FileWrite for failed tool calls (inspect tool_response error shape).
5. update-task-status.ts:386 — invalid machine counts as bound (degraded), not fallback.
6. dispatch.ts:55-60 — null sentinel distinguishes failed evidence snapshot from empty ledger.
7. complete-wave-gate.ts:204 — snapshotGateDeps loadPlanModels asserts requested path equals snapshotted path; mismatch fails closed.
8. complete-wave-gate.ts:19-24 — carry error message into `unreadable` variant.
9. cleanup-subagent-flag.ts:11 — guard JSON.parse on standalone CLI route.
10. hooks/scripts/record-evidence.sh — stderr note for existing-but-unreadable SUBAGENT_DIR.
11. errMessage helper (`e instanceof Error ? e.message : String(e)`) at record-evidence.ts, dispatch.ts, enforce-phase-tools.ts, mark-subagent-active.ts.
12. record-evidence.ts:51 — stderr note when recorder stands down on contended session.
13. ledger.ts:145-152 — soleActiveBinding requires roster exactly [bound agent]; extract pure `resolveSoleActiveBinding` into evidence.ts, adapter + fake both call it.
14. update-task-status.ts:143-167 — demote stale trusted-pass when FileWrite events follow the deciding run; property test.
15. evidence.ts — brand `Epoch` (epochOf sole producer); drop MachineBinding's stored-derived epoch or keep consistent by construction.
16. ledger.ts:64-72 — parseSessionId smart constructor (reject `/`, `\`, `..`, whitespace).
17. types.ts:126 — type enforcedTools/allowedTools as `(typeof GATE_WIRED_TOOLS)[number]`.
18. validate-model-bindings.ts:159 — discriminated union instead of `ValidationResult & { models?: PlanModels }`.
19. machines/README.md:92 — fix dangling "therefore"; restate sole-active premise inline.
20. agents/code-implementer-agent.md:24 + commands/templates/impl-agent-context.md:19 — ledger-first evidence framing.
21. Tests: Requirement.min > 1; shell fail-closed branches (spawn bash); recorder never-blocks contract; mermaid renderer branches.

## Validation Commands
```bash
cd engine && bun test && bunx tsc --noEmit
```

## Deferred
- report-discovery mtime-≥-command-start stamping (needs PreToolUse timestamps; documented as residual limit instead, per reviewer's stated minimum).

## Implementation addendum
- extract-evidence fix 6 landed stronger than planned: quote-aware `splitCommandSegments` (separators inside quotes don't split) PLUS unbalanced-segment refusal — the refusal alone was defeatable by balancing the quotes.
- mark-subagent-active now resolves the task-graph path via call-time `taskGraphPath()` (same import-time-drift class as the MACHINES_DIR fix).
- cleanup-stale-subagents sweep extracted as `sweepStaleSessions(dir, cutoff)` so the fs test runs hermetically (SUBAGENT_DIR freezes at first config import under bun's shared module cache).
- machines/README.md contention paragraph updated: the recorder now stands down with a stderr note (fix 12), not silently.
