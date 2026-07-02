# PR Remediation Plan — Round 6

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-c
**Findings:** 4 critical, 20 advisory (deduplicated across 6 agents)

## Critical Fixes

### Fix 1: Trust-laundering ordering hole in update-task-status skip guard
- **Source:** code-reviewer (+ architecture-tech-lead TOCTOU finding, combined)
- **File:** engine/src/handlers/subagent-stop/update-task-status.ts:437
- **Issue:** Skip guard uses `testResultPassed` (any trust level), so an untrusted helper-reported pass written before SubagentStop preempts the ledger's trusted-fail — ground truth never persisted, wave gate passes. Additionally the guards run on a pre-lock read while the locked update overwrites unconditionally (TOCTOU).
- **Fix:** Move guards INSIDE the `mgr.update` callback (mirroring store-test-evidence's `skippedTrustedVerdict` pattern) and make the test_result skip trust-aware: skip only when existing verdict is `trusted-pass`/`trusted-fail` (keep the `status === "completed"` guard). Mirror the trust-aware guard in pi/extension.ts:343.

### Fix 2: Wave gate passes vacuously for NaN/empty wave
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/helpers/complete-wave-gate.ts:30,258; engine/src/handlers/helpers/mark-tests-passed.ts:18,34
- **Issue:** `parseWaveArg` does `Number(...)` unvalidated; `evaluateWaveGate` has no `waveTasks.length === 0` guard — all six checks pass vacuously, stamps `wave_gates["NaN"]`, prints "All waves complete!". Same unvalidated arg + false success in mark-tests-passed.
- **Fix:** Validate wave arg like lint-wave-gate.ts:28 (finite, integer, ≥1; error otherwise) in both helpers; make empty wave a failing verdict in evaluateWaveGate and an error in mark-tests-passed.

### Fix 3: StateManager.load() is validation-that-should-be-parsing
- **Source:** type-design-analyzer
- **File:** engine/src/state-manager.ts:56-73
- **Issue:** Casts disk JSON `as unknown as TaskGraph` after key-presence check; malformed/drifted `test_result.verdict` throws NonExhaustiveError inside `testResultPassed`'s `.exhaustive()`; unvalidated `current_phase`/`tasks` shapes flow into typed logic.
- **Fix:** Add `parseTaskGraph(raw: unknown)` mirroring parseMachine: parse union-typed fields (Phase, TaskStatus, ReviewStatus, TaskTestResult verdict) — out-of-union values fail loudly (stderr + reject load or drop field with note). Wire into load().

### Fix 4: README claims tool-vocabulary.ts has "zero imports"
- **Source:** comment-analyzer
- **File:** README.md:533
- **Issue:** Module imports GATE_WIRED_TOOLS from machine/types — the derivation is its documented purpose.
- **Fix:** Replace with "(pure constants — sole import: machine/types)".

## Advisory Fixes

1. update-task-status.ts:450 — use call-time `machinesDir()` instead of frozen `MACHINES_DIR` for `machineBound`; fold duplicate config imports. (code-reviewer + architecture)
2. store-test-evidence.ts:30 — track `matched` flag inside locked update; return `kind: "error"` when `--task` matches no task. (silent-failure-hunter)
3. cleanup-stale-subagents.ts:77 — count statSync failures and log one summary line (mirror failedRemovals pattern). (silent-failure-hunter)
4. block-direct-edits.ts:42 — write fs error to stderr before falling through to block. (silent-failure-hunter)
5. state-manager.ts:27-32 — guard pointer-file read (contextual error), log dangling-pointer fallback to local graph. (silent-failure-hunter)
6. update-task-status.ts:377 — contextual guard around JSON.parse(stdin) on standalone route (mirror cleanup-subagent-flag.ts:16). (silent-failure-hunter)
7. utils/lock.ts:42 — rethrow immediately when mkdirSync error code !== "EEXIST". (silent-failure-hunter)
8. Single-source SESSION_SUFFIXES: define `as const` tuple in a pure machine module, derive `SessionFileSuffix` type, import const in ledger.ts + cleanup-stale-subagents.ts + test. (pr-test-analyzer + architecture)
9. Test: JVM runner-family scoping negative test — `npm test` with fresh surefire XML returns null. (pr-test-analyzer)
10. Test: explicit `--outputFile` staleness — report older than FRESHNESS_MS yields null. (pr-test-analyzer)
11. Test: refreshBindingActivity mixed stale+fresh reap — fresh line survives, stale gone, anchor advanced. (pr-test-analyzer)
12. parse-machine: parse `agent` field through parseAgentType; type MachineDef.agent as AgentType. (type-design-analyzer)
13. test-report.ts parsers: enforce `Number.isInteger && >= 0 && failed <= total` on total/failed. (type-design-analyzer)
14. SpecCheck.verdict: parse into closed union at store-spec-check boundary. (type-design-analyzer)
15. complete-wave-gate.ts:2 header — list six checks (add lifecycle machine artifacts). (comment-analyzer)
16. update-task-status.ts:148 docstring — reword "fallback" label meaning. (comment-analyzer)
17. machines/README.md:35 — extend untrusted-label list (snapshot-read-failed, helper-reported) or mark "e.g.". (comment-analyzer)
18. README.md:545 — add record-evidence to post-tool-use line, parse-plan-models.ts to parsers. (comment-analyzer)
19. cli.ts:21 — model fail-closed polarity as route metadata in handler-routes.ts; derive FAILURE_EXIT_CODE; extend polarity test. (architecture)

## Deferred (structural refactors, tracked for a dedicated pass)

- Task as discriminated union keyed on status — persisted JSON format migration.
- SessionRegistry port threading through production handlers + SessionId threading through ledger signatures — mechanical but wide; pairs with port extension (refreshActivity/readBindings/loadMachine).
- Deleting frozen MACHINES_DIR/TASK_GRAPH_PATH config exports (~15 sites) — minimal fix applied at the one desynced site instead.
- WaveGate.tests_passed → named union — persisted format change.

## Validation Commands
```bash
cd engine && bun tsc --noEmit && bun test
```
