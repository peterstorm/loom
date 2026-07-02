# PR Remediation Plan — loom

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-c (PR #16)
**Findings:** 4 critical, ~25 advisory (deduped across 6 review agents)

## Critical Fixes

### Fix 1: Gate fails open on parsed input missing session_id/tool_name
- **Source:** silent-failure-hunter (critical), code-reviewer (advisory — same finding)
- **File:** engine/src/handlers/pre-tool-use/enforce-phase-tools.ts:53-54
- **Issue:** Well-formed JSON lacking `session_id`/`tool_name` returns passthrough even when bindings exist, contradicting the fail-closed policy the malformed-stdin branch implements.
- **Fix:** Missing fields → `anyBindingExists() ? blockResult(...) : passthroughResult()`. Add test: valid JSON, missing session_id, binding exists → block.

### Fix 2: Corrupt binding file silently opens the gate
- **Source:** silent-failure-hunter
- **File:** engine/src/machine/ledger.ts:58-71; engine/src/handlers/pre-tool-use/enforce-phase-tools.ts:57-58
- **Issue:** `readBindings` drops malformed lines silently; a binding file that exists but parses to zero bindings yields passthrough with zero logging.
- **Fix:** Log skipped malformed lines (mirror `readEvidence`); in the gate, distinguish "file absent" (passthrough) from "file present, zero bindings parsed" (fail closed). Add tests.

### Fix 3: 9 tests fail under `bun test` (vi.resetModules unsupported)
- **Source:** pr-test-analyzer
- **File:** engine/tests/handlers/validate-model-bindings.test.ts:313; engine/tests/handlers/check-lifecycle-artifacts.test.ts:100
- **Issue:** `vi.resetModules()` is undefined in bun's vitest shim; the fail-closed funnel and wave-gate check-5 tests never assert under bun.
- **Fix:** Make config lookups lazy (read env at call time) in the affected handlers so tests set env without module reload; remove `vi.resetModules` dance. Suite must be green under BOTH `bun test` and `vitest run`.

### Fix 4: Gate's fail-closed branches untested
- **Source:** pr-test-analyzer
- **File:** engine/src/handlers/pre-tool-use/enforce-phase-tools.ts:72,82
- **Issue:** No test covers invalid-machine → block, or evaluation-crash catch-all → block.
- **Fix:** Handler-level tests via `LOOM_MACHINES_DIR` with a corrupt `<agent>.machine.json`.

## Advisory Fixes (in scope)

1. **parse-machine.ts:88** — validate `enforcedTools ⊆ GATE_WIRED_TOOLS` (Edit/Write/MultiEdit, constant kept next to hook registration) + test. (code-reviewer)
2. **update-task-status.ts:133** — `resolveTestEvidence`: judge the LAST TestRun; stale trusted failure must not outrank a later untrusted exit-0 run (route to labeled low-trust fallback; never promote untrusted to trusted pass). Add `[fail, untrusted-pass]` test. (code-reviewer)
3. **test-report.ts:158-162** — wrap the explicit `--outputFile` readFileSync; on error fall through to next report source preserving the TestRun fact with `report: null` + test. (silent-failure-hunter)
4. **dispatch.ts:29 / mark-subagent-active.ts:14** — defensive top-level JSON.parse; on failure emit specific "cleanup skipped — bindings may leak" stderr; add regression test that a cleanupSubagentFlag crash still runs update-task-status. (silent-failure-hunter, pr-test-analyzer)
5. **mark-subagent-active.ts:21,33** — wrap `bindMachineAgent` in its own try/catch (loud "agent will run UNGATED" stderr; still write `.task_graph` path); perform the `.active` append inside the same binding lock to close the append-vs-cleanup race. (silent-failure-hunter, architecture)
6. **ledger.ts:86-91** — `soleActiveBinding` must verify the single active agent IS the bound agent + leaked-binding test. (pr-test-analyzer)
7. **dispatch.ts ordering** — snapshot the epoch's ledger evidence BEFORE unbind and pass it to update-task-status, closing the bind-time truncation window. (architecture, silent-failure-hunter)
8. **config.ts:89** — derive STATE_FILE_PATTERNS from SUBAGENT_DIR (not hardcoded "claude-subagents") and broaden to guard `.active` appends and `rm` of the directory itself. (code-reviewer, silent-failure-hunter)
9. **hooks/scripts/enforce-phase-tools.sh:15** — unreadable SUBAGENT_DIR → exit 2 (fail closed), distinct from "no bindings". (silent-failure-hunter)
10. **Doc fixes** (comment-analyzer, all 7): machines/README.md:36 (trusted vs trusted-pass), :48 (silent recorder stand-down), :82 (missingRequirements claim); update-task-status.ts:117 label-taxonomy comment; agents/decompose-agent.md:19 + commands/templates/phase-decompose.md:71 (pathsMatch suffix-match reality); commands/templates/phase-architecture.md:176 (git add pathspec failure); commands/loom.md:481 (hook table + new hooks).

## Deferred (documented, not in this pass — architectural refactors beyond minimal-fix scope)

- PhaseDef discriminated union on `terminal`; branded MachineDef; branded AgentId/AgentType; three-variant judgeTestRun verdict; Stray discriminated union; `test_result` discriminated Task field (type-design-analyzer — all valid, all reshape types across many call sites).
- Binding liveness/TTL (pid-stamped bindings mirroring isStaleLock) (architecture).
- Module-level purity split of test-report.ts/ledger.ts + pureModules self-linting (architecture).
- complete-wave-gate side effects inside mgr.update callback (architecture, pre-existing pattern).
- SessionRegistry port for property-testing interleavings (architecture).

## Validation Commands
```bash
cd engine && bun run typecheck   # or npx tsc --noEmit
cd engine && bun test
cd engine && npx vitest run
```
