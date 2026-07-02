# PR Remediation Plan — Round 5

**Date:** 2026-07-02
**Branch:** feat/deterministic-core-phase-c (PR #16)
**Findings:** 5 critical, 33 advisory (12-agent cross-repo review, loom half)

## Critical Fixes

### Fix 1: Raw session_id path construction bypasses the SessionId brand boundary
- **Source:** type-design-analyzer
- **File:** engine/src/handlers/subagent-start/mark-subagent-active.ts:105, engine/src/state-manager.ts:17 (resolveTaskGraph), engine/src/core/block-direct-edits.ts:17
- **Issue:** `${SUBAGENT_DIR}/${session_id}.task_graph` etc. built from unparsed hook input (one site is a WRITE). A session_id like `../../x` addresses files outside SUBAGENT_DIR — the exact class `parseSessionId` was built to make unrepresentable. Contradicts ledger.ts's "single path-construction boundary" claim.
- **Fix:** Add suffix-typed path helpers to ledger.ts (e.g. `sessionScopedPath(dir, sessionId: SessionId, suffix: ".task_graph" | ".active" | ...)`) built on the same parse boundary as `sessionFilePath`. Route all raw interpolation sites through them: parse the incoming session_id with `parseSessionId` first; on parse failure fail closed (skip write / treat as no task graph) with a loud stderr line.

### Fix 2: AgentType brand is path-unsafe yet flows into machineDefPath
- **Source:** type-design-analyzer
- **File:** engine/src/machine/evidence.ts:29 (BINDING_UNSAFE), engine/src/machine/ledger.ts:362 (machineDefPath), engine/src/handlers/subagent-start/mark-subagent-active.ts:74
- **Issue:** `BINDING_UNSAFE = /[\t\n\r:]/` proves binding-encoding safety only; an agent_type containing `/` or `..` loads a machine definition from OUTSIDE machinesDir — a traversal-substituted permissive machine defeats the gate. mark-subagent-active even passes the raw (pre-parse) agent_type to loadMachine.
- **Fix:** Extend BINDING_UNSAFE to also reject `/`, `\`, whitespace, and reject `..` sequences (update the docstring: brand now proves binding-encoding AND path safety). Change `loadMachine`/`machineDefPath` signatures to take `AgentType` (branded), not string. In mark-subagent-active, parse agent_type BEFORE loadMachine and use the branded value. Update affected tests.

### Fix 3: pi subagent-stop loop has no per-result error isolation
- **Source:** silent-failure-hunter
- **File:** pi/extension.ts:239-481
- **Issue:** A throwing mgr.load/mgr.update while processing result #1 aborts the for-loop; results #2..N never processed, tasks stuck `executing`, zero diagnostics. Claude-side dispatch.ts wraps every handler in safeRun for exactly this; pi side left open.
- **Fix:** Wrap each result's processing in try/catch that writes agent type, task id, and cause to stderr and continues with the next result (mirror dispatch.ts's safeRun pattern).

### Fix 4: agents/code-implementer-agent.md:24 misstates the transcript fallback condition
- **Source:** comment-analyzer
- **Issue:** Claims fallback happens "only when no ledger evidence exists"; resolveTestEvidence actually falls back whenever the ledger yields no TRUSTED verdict (no report artifact / pass demoted by later FileWrite).
- **Fix:** Replace with: "It falls back to transcript scanning whenever the ledger yields no trusted verdict — no ledger evidence at all, an exit-0 run with no report artifact, or a pass invalidated by later file writes — and that fallback is always labeled untrusted."

### Fix 5: commands/templates/impl-agent-context.md:19 — same false condition
- **Source:** comment-analyzer
- **Fix:** Same wording fix as Fix 4. Keep the "do NOT finish without Bash test output showing pass markers" line.

## Advisory Fixes

### A1: extract-evidence.ts:134 — quote-unaware comment/env-prefix strips drop legitimate evidence
- **Source:** code-reviewer
- **Fix:** Make the comment strip and env-prefix strip quote-aware (respect the same quote state the splitter tracks, or operate only outside quoted regions). `npm test -- --grep "issue #123"` and `FOO="a b" npm test` must classify. Add tests for both.

### A2: report-discovery.ts:98 — agent-writable report artifact can mint trusted-pass; residual undocumented
- **Source:** code-reviewer
- **Fix:** (a) Document the residual in references/executable-models.md and machines/README.md known-residuals lists. (b) Cheap hardening: in record-evidence, reject an explicit --outputFile path that already appears as a FileWrite event in the current epoch's ledger snapshot (recorder has it available); log the rejection. Add a test.

### A3: pi/extension.ts:163 — empty catch drops resume context silently
- **Fix:** stderr line before return: `loom(pi): resume context skipped — task graph unreadable: <cause>`.

### A4: pi/extension.ts:229 — details.results shape drift is silent no-op or throw
- **Fix:** `Array.isArray` check; log unrecognized shape to stderr and return.

### A5: dispatch.ts:84 — failed evidence snapshot collapses to undefined (indistinguishable from no-snapshot)
- **Fix:** Thread a distinct sentinel (e.g. `{ kind: "snapshot-failed" }` vs `{ kind: "snapshot", events }` vs undefined) into runUpdateTaskStatus; label the verdict `snapshot-read-failed` instead of misleading `degraded` when the snapshot failed. Update comment contract + tests.

### A6: parse-bash-test-output.ts:27 — persisted-output read failure silently falls back
- **Fix:** One stderr line naming the unreadable file and the fallback.

### A7: cleanup-stale-subagents.ts:69 — sweepStaleSessions swallows all failures
- **Fix:** Log outer readdir failure; count and log failed removals (match the pi twin's logging).

### A8: tool-vocabulary.ts:11 — exported mutable Set/array
- **Fix:** `ReadonlySet<string>` + `readonly string[]` via `as const`.

### A9: types.ts:82 — GATE_WIRED_TOOLS / FILE_MODIFYING_TOOLS / hooks.json triplication
- **Fix:** Derive FILE_MODIFYING_TOOLS from GATE_WIRED_TOOLS (or add a sync test asserting set equality; hooks.json half already pinned by hooks-sync.test.ts). Prefer derivation.

### A10: advance.ts:93 — missingRequirements fail-open narrowing
- **Fix:** If last phase is somehow non-terminal, return the impossible-state as failure (e.g. return a sentinel requirement like "machine invariant violated: terminal phase missing") rather than []. Keep pure; add test.

### A11: ledger.ts — non-atomic rewrites with lock-free readers (torn reads)
- **Source:** architecture-tech-lead
- **Fix:** temp-file + renameSync for all full-file rewrites (refreshBindingActivity, removeActiveAgent, bindMachineAgent, unbindMachineAgent). Appends stay as-is.

### A12: no-io-in-pure-modules.ts — deny-list gaps
- **Fix:** Add node:crypto, node:os, node:process, node:worker_threads, node:readline to IO_IMPORTS; add Date.now(), setTimeout/setInterval, crypto.randomUUID, process.stdout.write/process.stderr.write to BANNED_GLOBALS. Tighten isPureModule matching to prefix/exact rather than bare includes(). Update rule tests.

### A13–A17: Test additions
- mark-tests-passed.ts error-polarity dedicated test.
- record-evidence.sh binding-present + runtime-unavailable branch (exit 0 + loud stderr).
- enforce-phase-tools.sh "bun not found → exit 2" (spawn with PATH lacking bun).
- evidence.ts isReportSummary rejection: malformed report sub-object demotes to report: null.
- hooks.json command routes ⊆ cli.ts KNOWN_HANDLERS sync test.

### A18–A26: Comment/doc corrections
- commands/wave-gate.md:43 — "must produce ledger evidence (a real Bash test run) or transcript pass markers".
- README.md:244 + commands/wave-gate.md:182 — reconcile check numbering with complete-wave-gate stderr labels (renumber the stderr labels 1–6 in complete-wave-gate.ts; that fixes the mismatch at the source).
- test-report.ts:81 — "The R2 trust rule" → "The TestRun trust rule".
- engine/src/types.ts:66 + test-report.ts:69-71 — drop the fictional tests_passed/tests_trusted mainline predecessor narration; keep the constraint statement.
- mark-subagent-active.ts:1 — header must name all three jobs (active flag, task_graph path, machine binding + epoch minting).
- update-task-status.ts:405 — rephrase to a general "preserve previously-set evidence regardless of status" invariant (no fictional crash-detection writer).
- dispatch.ts:3 — "invoked via the dispatch.sh shim; reads stdin once, calls only relevant handlers".
- enforce-phase-tools.ts:9 — drop "(deliberate, per review)" narration, keep rationale.
- commands/loom.md:500 — update-task-status row: only sets "implemented".

### A27: enforce-phase-tools-fail-closed.test.ts:93 — env mutation comment
- **Fix:** Add a comment noting reliance on bun's sequential single-process execution (or a withMachinesDir helper).

## Deferred (documented, not in this round)

- ContentionObserved ledger fact + fold-time demotion (architecture Issue 1) — new evidence kind, design change; document as known residual in executable-models.md instead.
- SessionRegistry port threading through production handlers — structural refactor; docstring adjusted in this round (engine/src/machine/evidence.ts now states production handlers call ledger.ts directly and the port is exercised by property tests only); the threading itself remains deferred.
- StateManager.load parseTaskGraph boundary; Task aggregate ADT redesign; PhaseState↔MachineDef tying — larger type redesigns, next refactor PR.
- Gate triple-read consolidation; machine/index.ts pure sub-barrel — next refactor PR.

## Implementation notes (round-5 execution, 2026-07-02)

- All critical fixes (1–5) and all advisory fixes (A1–A27) landed; nothing new deferred.
- Fix 1 scope note: the two raw interpolations in pi/extension.ts were left as-is — their sessionId comes from pi's sessionManager (not hook input), which is outside the parse boundary this fix targets; the three engine sites named by the finding are routed through parseSessionId + sessionScopedPath (or the branded id).
- A9 derivation direction: GATE_WIRED_TOOLS (machine/types.ts, hooks-sync-pinned) stays the source tuple; FILE_MODIFYING_TOOLS is derived from it in core/tool-vocabulary.ts. The core/ boundary allowlist gained the pure machine modules (evidence, types) to permit this and Fix 1's parseSessionId import.
- A17: KNOWN_HANDLERS extracted to engine/src/handler-routes.ts (importing cli.ts would run main()); cli.ts imports it, hooks-sync.test.ts pins hooks.json shim routes ⊆ KNOWN_HANDLERS.
- Pre-existing (NOT this round): parsers/ and core/ files that import node:fs while matched by DEFAULT_PURE_MODULES globs (e.g. parse-bash-test-output.ts, block-direct-edits.ts) — the A6 stderr line adds to an already-IO file; reclassifying the pure-module globs is a separate decision.

## Validation Commands
```bash
cd engine && bun x tsc --noEmit && bun test
```
