# PR Remediation Plan — Round 14

**Date:** 2026-07-09
**Branch:** feat/deterministic-core-phase-c
**Findings:** 4 critical, 14 advisory (after dedup across 6 agents)

## Critical Fixes

### Fix 1: Process substitution bypasses helper-allow confinement
- **Source:** code-reviewer (verified live: guard returns "allow")
- **File:** engine/src/core/guard-state-file.ts:105
- **Issue:** `hasCommandSubstitution` only checks `$(` and backticks. Bash process substitution `<(…)` / `>(…)` executes its body like `$(…)`, is opaque to the segment splitter, and lands inside the helper segment — `bun cli.ts helper set-phase execute <(sed -i s/trusted-fail/trusted-pass/ .claude/state/active_task_graph.json)` → allow.
- **Fix:** Extend `hasCommandSubstitution` to also match `<(` and `>(`. Add regression tests beside the round-13 rows in engine/tests/handlers/pre-tool-use/guard-state-file.test.ts.

### Fix 2: Interpreter eval writes (`bun -e`, `perl -e`, `ruby -e`) invisible to WRITE_PATTERNS
- **Source:** code-reviewer (verified live: all four probes returned "allow")
- **File:** engine/src/config.ts:136
- **Issue:** WRITE_PATTERNS covers python/node interpreter writes but not `bun` — the one interpreter guaranteed present. `bun -e "await Bun.write('.claude/state/active_task_graph.json', …)"` forges the task graph; `bun -e "require('fs').appendFileSync(…evidence.jsonl…)"` appends forged trusted evidence. perl/ruby eval forms also uncovered. Contradicts machines/README.md:139-141.
- **Fix:** Add `bun` write/eval pattern (e.g. `bun .*(write|fs\.|-e |--eval)`) plus perl/ruby eval forms to WRITE_PATTERNS. Regression tests: bun/perl/ruby forge probes blocked; legit `bun test` + state-file read still allowed where applicable.

### Fix 3: Glob/brace state-file paths bypass STATE_FILE_PATTERNS
- **Source:** pr-test-analyzer (verified live: `sed -i … .claude/state/active_task*.json` → allow)
- **File:** engine/src/config.ts:119
- **Issue:** STATE_FILE_PATTERNS matches only the exact literals `active_task_graph|review-invocations`. Glob (`active_task*.json`, `.claude/state/*.json`) and brace (`active_task_{graph,x}.json`) writes never trip `writesStateFile` — same forgery class rounds 11-13 each treated as critical.
- **Fix:** Add the escaped state directory (dirname of TASK_GRAPH_PATH) to STATE_FILE_PATTERNS, mirroring the SUBAGENT_DIR/MACHINES_DIR dir-guard rationale at config.ts:110-117. Add glob/brace regression rows for both state files, with and without helper prefix.

### Fix 4: pi impl-branch trust guards run pre-lock (TOCTOU)
- **Source:** architecture-tech-lead
- **File:** pi/extension.ts:414-466
- **Issue:** The engine twin (update-task-status.ts:557-588) re-finds the task and re-checks `completed`/trusted-verdict INSIDE the locked `mgr.update` per its own TOCTOU comment. The pi mirror checks on a pre-lock `mgr.load()` snapshot, then its locked update maps the task unconditionally — a trusted verdict landing between read and write is silently overwritten by an untrusted pass.
- **Fix:** Move the target re-find + completed/trusted-verdict guards inside pi's `mgr.update` callback, mirroring the engine's `skippedExistingVerdict` pattern.

## Advisory Fixes

### Fix 5: Auto spec-check handler lacks count-mismatch guard its manual twin has
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/subagent-stop/store-spec-check-findings.ts:136-145
- **Fix:** Add the same `reportedCritical !== critical.length` fail-closed guard store-spec-check.ts:48-54 enforces; correct the manual helper's "mirroring the auto handler" comment.

### Fix 6: Unanchored `truncate ` / `install ` WRITE_PATTERNS tokens
- **Source:** silent-failure-hunter, pr-test-analyzer
- **File:** engine/src/config.ts:136
- **Fix:** Anchor as `(?:^|\s)truncate ` / `(?:^|\s)install ` matching the adjacent `ln ` fix; add a precision row (`npm install` + state-file read no longer over-blocked).

### Fix 7: parseReportField re-mint fix unpinned by test
- **Source:** pr-test-analyzer
- **File:** engine/src/machine/evidence.ts:256 (test: engine/tests/machine/ledger.test.ts)
- **Fix:** Add a `toEqual` row feeding a valid-counts report carrying an extra smuggled field, asserting the parsed record is exactly `{total, failed, source}`. Also rename the stale "(isReportSummary rejection)" test title to `parseReportField`.

### Fix 8: pi inlines WaveGate default literal round-12 single-sourced
- **Source:** architecture-tech-lead
- **File:** pi/extension.ts:481, :577
- **Fix:** Import and use `newWaveGate()` at both sites.

### Fix 9: pi dead `specDir` local; spec/plan extraction hardcodes paths
- **Source:** code-reviewer
- **File:** pi/extension.ts:329, 337-341
- **Fix:** Use the loaded `specDir` (state.spec_dir ?? default) in the path match instead of the hardcoded `.claude/specs/` literal, mirroring engine advance-phase behavior.

### Fix 10: mark-subagent-active.sh missed the shim-hardening sweep
- **Source:** architecture-tech-lead
- **File:** hooks/scripts/mark-subagent-active.sh:9
- **Fix:** Add the documented failure-policy preamble (fail loud, stderr names the consequence: "machine NOT bound, agent runs UNGATED"), quote `${CLAUDE_PLUGIN_ROOT}`, add coverage in hook-shims-fail-closed.test.ts.

### Fix 11: Docs drift (5 items, comment-analyzer)
- README.md:703 — "Task stuck `in_progress`" names a nonexistent status; mirror loom.md:537's row.
- README.md:210 — "hooks extract pass/fail evidence from the transcript" → ledger-first phrasing (mirror line 224).
- README.md:691 + tree label at :535 — drop "pure" claim for engine/src/core/ (keep harness-agnostic).
- engine/src/core/guard-state-file.ts:3 — header claims "Pure function"; give it the honest "Not pure: reads the filesystem" treatment block-direct-edits.ts:3 got.
- engine/src/handlers/helpers/populate-task-graph.ts:137 — "real Write evidence" → "transcript-parsed Write tool calls (existence-checked)".

## Deferred

### Dead `"failed"` TaskStatus + failure_reason/retry_count (type-design-analyzer)
- **Reason:** Part of the already-deferred Task evidence-union refactor cluster; round-13 consciously chose docs-only. Compiler-checked removal is safe but touches TASK_STATUSES, resume-after-clear, pi status counting — batch with the union refactor.

### store-spec-check marker-parsing unification (architecture-tech-lead)
- **Reason:** Structural extraction of a shared `parseSpecCheckMarkers`; Fix 5 closes the fail-closed gap now, unification batched for a dedicated refactor.

### WRITE_PATTERNS allowlist inversion (architecture-tech-lead)
- **Reason:** Recommended long-term shape (read-only allowlist for state-file-referencing segments) — a semantic redesign of the guard, too large for minimal-edit remediation. Fixes 1-3 close all live-verified bypasses this round.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit
cd engine && bun test
```
