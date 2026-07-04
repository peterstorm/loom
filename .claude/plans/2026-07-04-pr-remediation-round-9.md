# PR Remediation Plan — Round 9

**Date:** 2026-07-04
**Branch:** feat/deterministic-core-phase-c
**Findings:** 0 critical, 21 advisory (5-agent parallel review: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, architecture-tech-lead)

Zero criticals — the deterministic core is mature. Per the review-and-fix workflow's "only advisory" edge case, the user opted for the **targeted high-value set**: concrete, low-risk fixes only. The larger type/architecture refactors (WaveGate/Task discriminated unions, EpochMs/DurationMs brands, SessionRegistry three-way port + symmetric adoption) were deferred to avoid churning a mature branch.

## Advisory Fixes Applied

### Fix 1: pi adapter bypasses the parseSessionId fail-closed brand
- **Source:** silent-failure-hunter
- **File:** pi/extension.ts:66 (uses at :117, :119, :260)
- **Issue:** `getSessionId() ?? "unknown"` was interpolated directly into `SUBAGENT_DIR` paths (`${sessionId}.active`, `.task_graph`), bypassing `parseSessionId` — the path-traversal guard the engine enforces at every boundary (`evidence.ts` `SESSION_UNSAFE`). Not attacker-reachable (harness-generated id) but the one place the codebase's uniform fail-closed session-path discipline was abandoned.
- **Fix:** Parse the id through `parseSessionId` at both write sites (tool_call tracking, subagent_stop cleanup); stand down loudly with a stderr note when unsafe, mirroring `record-evidence.ts:55-60`. `shouldBlockDirectEdit`/`StateManager.fromSession` already parse internally, so only the raw path-interpolation sites needed guarding.

### Fix 2: anyBindingExists hardcodes ".machine" suffix
- **Source:** architecture-tech-lead (conf 65)
- **File:** engine/src/handlers/pre-tool-use/enforce-phase-tools.ts:35
- **Issue:** The gate's binding scan used a literal `.endsWith(".machine")` instead of deriving from the centralized suffix vocabulary, risking drift from `SESSION_SUFFIXES`.
- **Fix:** Extracted `MACHINE_SUFFIX = ".machine"` in evidence.ts as the single source (referenced by `SESSION_SUFFIXES`), re-exported through the machine barrel, and consumed it in `anyBindingExists`.

### Fix 3: parsePiFilesModified pi-branch untested
- **Source:** pr-test-analyzer (rating 6/10)
- **File:** engine/src/parsers/parse-files-modified.ts:34-58 (test: engine/tests/parsers/parsers.test.ts)
- **Issue:** The pi-transcript branch (`{ type: "toolCall", name, arguments }`) is live production code (threaded by pi/extension.ts) with zero behavioral coverage — a format-shape regression would ship silently.
- **Fix:** Added 4 tests: explicit-pi write via `path`, edit via `file_path` fallback, non-assistant/non-file-tool rejection, and auto-detect from the session header line.

## Deferred (documented, not fixed)

Larger refactors that would churn the mature branch — tracked for a future dedicated pass:
- **WaveGate** 4-flag bag → discriminated union on a `status` discriminant (type-design, engine/src/types.ts:137-142)
- **Task** god-object: brand `agent` as `AgentType`, introduce `WaveNumber` newtype (type-design, engine/src/types.ts:111-135)
- **EpochMs/DurationMs** brands to close the `isBindingFresh` argument-swap hazard (type-design, evidence.ts:155-162)
- **SessionRegistry port**: three-way `bindingState` result (absent/corrupt/bindings) + symmetric bind/unbind adoption so the fail-closed and bind paths are fake-testable (architecture, conf 78-80)
- **SpecCheck** redundant count-vs-array; **Requirement.min** positivity in the type; **Clock** injection into the registry
- pi transcript-format mismatch to `parseBashTestOutput` (fails closed but silent); remaining test edge-branches (tee quoted target, persisted-file catch, terminal-phase blockExplanation)

## Validation Commands
```bash
cd engine && bunx tsc --noEmit          # exit 0
cd engine && bunx vitest run            # 1369 pass, 0 fail
```
