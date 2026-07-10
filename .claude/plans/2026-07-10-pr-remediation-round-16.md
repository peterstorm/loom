# PR Remediation Plan — Round 16

**Date:** 2026-07-10
**Branch:** feat/deterministic-core-phase-c
**Findings:** 7 critical (3 code, 4 docs), 15 advisory
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead

## Critical Fixes

### Fix 1: Remove `cd` from READ_ONLY_STATE_COMMANDS — cwd-relocation bypass
- **Source:** code-reviewer + silent-failure-hunter (both live-verified)
- **File:** engine/src/config.ts:172
- **Issue:** `cd` is allowlisted as a read-only head, but it re-scopes path resolution: `cd .claude/state && rm *.json` → allow (deletes task graph); `cd /tmp/claude-subagents && printf '{}' > sess.evidence.jsonl` → allow (forges evidence ledger). The follow-on writer segment names no guarded literal (relative names after cwd moved), so its chain is skipped as out-of-scope (guard-state-file.ts:321). Regression from 30fe5ec.
- **Fix:** Remove `"cd"` from `READ_ONLY_STATE_COMMANDS`. Cost is fail-closed only: `cd <guarded-dir> && <read>` blocks, but reads never need to cd into a guarded dir (full-path reads still allow, and `cd <unguarded-dir> && jq . .claude/state/active_task_graph.json` still allows — the cd chain is skipped, the jq chain is judged normally). Update the allowlist docblock rationale.
- **Regression tests** (guard-state-file.test.ts) — block rows:
  - `cd .claude/state && rm *.json`
  - `cd .claude/state && cp /tmp/forged.json active_task*.json`
  - `cd .claude/state; sed -i 's/trusted-fail/trusted-pass/' *.json`
  - `cd /tmp/claude-subagents && rm -rf .`
  - `cd .claude/state && n=active_task_; printf FORGED > ${n}graph.json`
  - `cd /tmp/claude-subagents && printf '{}' > sess.evidence.jsonl`
  - allow rows: `cd /repo && jq . .claude/state/active_task_graph.json`; `cd src && grep -r foo .`
- **Residual to document:** multi-hop `cd .claude; cd state; rm *.json` never names a guarded literal on the line and stays invisible to any raw-text gate. Document honestly in machines/README.md known-residual-limits and the allowlist docblock (beside the graph-absent caveat) rather than silently owning it.
- **Applied:** Removed `cd` from `READ_ONLY_STATE_COMMANDS` (engine/src/config.ts) with docblock rationale + multi-hop residual note; residual also documented in machines/README.md known-residual-limits; 6 block + 2 allow regression rows added to guard-state-file.test.ts.

### Fix 2: Quote-split literal laundering defeats the front gate
- **Source:** code-reviewer (live-verified)
- **File:** engine/src/core/guard-state-file.ts:308 (front gate), :321 (chain scope), :328 (protected-dir check)
- **Issue:** Bash concatenates adjacent quoted word parts, but `stateFilePatterns()` requires literals contiguous in raw text. `echo FORGED > .cl'aude'/state/active_'task_graph'.json` → allow (forges task graph). Same class as the substitution laundering closed in rounds 13/14; plain quote concatenation is the cheaper member and is wide open.
- **Fix:** Run the pattern tests (front gate line 308, chain scope line 321, protected-dir line 328, and `placeholderFor`) against a quote-collapsed normalization of the text — strip unescaped `'`/`"` characters from a copy using the same quote-scanner semantics the file already has. This errs only fail-closed: a quoted argument that *mentions* a guarded name gets judged, never skipped.
- **Regression tests** — block rows:
  - `echo FORGED > .cl'aude'/state/active_'task_graph'.json`
  - `rm .cl""aude/state/active_task_gr""aph.json`
  - `sed -i 's/x/y/' .cl'aude'/state/active_'task_graph'.json`
  - allow rows: `jq '.tasks' active_task_graph.json` (read head), `grep "active_task_graph" README.md`
- **Applied:** Added `collapseQuotes()` (same quote-scanner semantics, backslash-escape aware) in guard-state-file.ts; front gate, chain scope, protected-dir check, and `placeholderFor` classification now test the quote-collapsed view (matching only — placeholder outputs unchanged); 3 block + 2 allow rows added.

### Fix 3: `>&<digit/dash><path>` redirect misclassified as fd-dup — both scanners
- **Source:** architecture-tech-lead (critical, live-verified) + silent-failure-hunter/type-design-analyzer (advisory, same root cause)
- **Files:** engine/src/core/guard-state-file.ts:150-154 (`hasOutputRedirect`), engine/src/machine/extract-evidence.ts:352-357 (`readRedirectTarget`)
- **Issue:** Bash treats `>&word` as fd-duplication only when the ENTIRE word is digits (or exactly `-`); a word starting with a digit that continues into a path is a filename redirect. The round-15 fix checks a single char. Live-verified: `mkdir 2 && echo FORGED >&2/../.claude/state/active_task_graph.json` → guard allows, bash forges the task graph. Evidence twin: `extractShellWriteTargets("echo X >&2/../report.json")` returns `[]`, so no FileWrite evidence is minted — a path to laundering a fabricated report past the agent-authored-artifact veto.
- **Fix:** In both functions, scan the full redirect word after `>&` up to the next whitespace/redirect/separator. Treat as fd-dup only if the whole word matches `/^[0-9]+$/` or is exactly `-`; otherwise it's a file write (guard: `return true`; evidence: collect as written path). Fix the docblock at guard-state-file.ts:120-125 (its stated invariant is false) and the placeholder claim if touched. Use the same classification logic in both files (a small shared helper is acceptable; full shared-tokenizer refactor stays deferred).
- **Regression tests:**
  - guard block: `mkdir 2 && echo FORGED >&2/../.claude/state/active_task_graph.json`; `echo x >&2foo` with a guarded token in the segment
  - guard allow: `some-cmd >&2`, `cmd 2>&1`, `cmd >&-`
  - evidence: `extractShellWriteTargets("echo X >&2/../report.json")` yields the path; `>&2` yields `[]`
- **Applied:** New shared `classifyFdDupWord()` in extract-evidence.ts (whole-word digits or `-` = fd dup); used by both `hasOutputRedirect` (guard) and `readRedirectTarget` (evidence); false docblock invariants corrected; guard rows (2 block, 3 allow) + evidence rows (`>&2/../report.json` mints; `>&2`/`2>&1`/`>&-` do not) added.

### Fix 4: loom.md step 4d.C instructs a guard-blocked `chmod`
- **Source:** comment-analyzer
- **File:** commands/loom.md:320-324
- **Issue:** Instructs orchestrator to run `chmod 444 .claude/state/active_task_graph.json` right after populate-task-graph; guard blocks it (chmod not allowlisted, pinned by test), and StateManager already leaves the file at 444 (state-manager.ts:181-195). An agent following the doc loops on an impossible command.
- **Fix:** Delete step C or reword to "the helper leaves the file chmod 444 — do not run chmod yourself; the guard blocks it."
- **Applied:** loom.md step 4d.C reworded — the helper leaves the file chmod 444, do not run chmod (guard blocks it); "only hooks" widened to hooks + whitelisted helpers (also covers Fix 18 loom.md:324 site).

### Fix 5: loom.md:439 "Set chmod 444 immediately after creation"
- **Source:** comment-analyzer
- **File:** commands/loom.md:439
- **Issue:** Same class; cli.ts init-state already chmods 444 (cli.ts:87,103) and the Bash chmod is guard-blocked.
- **Fix:** Reword to state the engine does this automatically.
- **Applied:** loom.md:439 reworded — the engine sets chmod 444 automatically (cli.ts init-state + every StateManager write); do not run chmod yourself.

### Fix 6: wave-gate.md GH-comment fallback is unreachable
- **Source:** comment-analyzer
- **File:** commands/wave-gate.md:151-152
- **Issue:** Fallback "log summary to `.claude/state/wave-{N}-review.md`" — the state dir is guarded (Bash write blocks) and the Write tool is blocked by block-direct-edits. Unreachable by every tool path.
- **Fix:** Point the fallback at a non-guarded location: `.claude/reviews/wave-{N}-review.md`.
- **Applied:** wave-gate.md fallback now targets `.claude/reviews/wave-{N}-review.md` with a note that `.claude/state/` is guarded against every write path.

### Fix 7: README.md:226 repeats the unreachable fallback
- **Source:** comment-analyzer
- **File:** README.md:226
- **Fix:** Change together with Fix 6 (same target path).
- **Applied:** README.md:226 fallback path changed to `.claude/reviews/wave-{N}-review.md` together with Fix 6.

## Advisory Fixes

### Fix 8: pi Stop mirror never persists `files_modified` — lint-wave-gate lints nothing under pi
- **Source:** code-reviewer
- **File:** pi/extension.ts:459-474 vs engine/src/handlers/subagent-stop/update-task-status.ts:657
- **Issue:** Engine persists `files_modified` on the task; pi's `UntrustedStopResolution` carries no such field and pi never calls `parseFilesModified` (imported, unused). lint-wave-gate.ts:33 collects lint targets exclusively from `files_modified`, so under pi every wave-gate lint runs over an empty set and reports clean — silent gate pass.
- **Fix:** Thread `filesModified` (parsed from transcriptText via `parseFilesModified`) through `UntrustedStopResolution`/the shared pure function so BOTH engine and pi persist it via the same seam. Pin with a test (pi path and engine path agree).
- **Applied:** `UntrustedStopResolution` gained `filesModified`; `applyUntrustedStopResolution` persists it as `files_modified`; pi re-encodes per-result messages as pi-format JSONL and threads `parseFilesModified(piJsonl, "pi")` through the shared seam. Pinned in pi-stop-toctou.test.ts (persistence + skip path) and parsers.test.ts (exact re-encoding shape).

### Fix 9: pi/extension.ts dead imports
- **File:** pi/extension.ts:12,22,25,38
- **Fix:** Remove `parseFrontmatter`, `parseTranscript`, `parsePhaseArtifacts`, `HARNESS` (unused; pi/ escapes the engine tsconfig). `parseFilesModified` becomes used by Fix 8 — keep it.
- **Applied:** Removed dead imports `parseFrontmatter`, `parseTranscript`, `parsePhaseArtifacts`, `HARNESS` from pi/extension.ts; `parseFilesModified` kept (now used by Fix 8).

### Fix 10: cleanup-stale-subagents.sh preamble has no regression test
- **Source:** pr-test-analyzer
- **File:** hooks/scripts/cleanup-stale-subagents.sh:17 / engine/tests/e2e/hook-shims-fail-closed.test.ts
- **Fix:** Add the two standard rows (CLAUDE_PLUGIN_ROOT unset → drain stdin, loud stderr, exit 0; bun missing → same), matching the five sibling shims.
- **Applied:** Added a cleanup-stale-subagents.sh describe block to hook-shims-fail-closed.test.ts: quiet fast path; CLAUDE_PLUGIN_ROOT unset → exit 0 + loud stale-sweep-skipped stderr; bun missing → same.

### Fix 11: Delete dead export `commandInvokesWhitelistedHelper`
- **Source:** pr-test-analyzer
- **File:** engine/src/core/guard-state-file.ts:100
- **Issue:** Referenced nowhere in production or tests; its any-segment semantics mirror the retired vulnerable pre-round-11 model — a future caller could misuse it as the guard.
- **Fix:** Delete (compiler-checked).
- **Applied:** Deleted `commandInvokesWhitelistedHelper` from guard-state-file.ts (compiler-checked: zero references).

### Fix 12: Extract pure `isWaveComplete` for the pi Stop wave-completion path
- **Source:** pr-test-analyzer
- **File:** pi/extension.ts:484-501
- **Issue:** Wave-completion computation and `impl_complete` gate write are untested; completion check runs on a post-update load outside the lock.
- **Fix:** Extract a pure `isWaveComplete(state, wave)` (engine core, shared by pi), call it inside the locked update where feasible, pin with tests.
- **Applied:** Extracted pure `isWaveComplete(state, wave)` into update-task-status.ts; the engine post-resolution check uses it; pi now decides wave completion + the impl_complete gate write INSIDE the same locked update as the resolution (post-update load removed). Pinned with 4 tests in pi-stop-toctou.test.ts.

### Fix 13: pi roster writes agent TYPE where engine contract expects AgentId
- **Source:** type-design-analyzer
- **File:** pi/extension.ts:161
- **Fix:** Route through `rosterAgentId`/the SessionRegistry port for symmetry with `markAgentActive`. If pi genuinely has no agent id available at that seam, document the latent mismatch at the write site and defer.
- **Applied:** pi roster write routed through `rosterAgentId(agent)` (same producer as the engine roster — line guaranteed parseable); the id-vs-type latent mismatch (pi exposes no per-spawn agent id at this seam) documented at the write site and deferred.

### Fix 14: README.md config table drift
- **Files:** README.md:614 (`PHASE_TRANSITIONS` → `VALID_TRANSITIONS`), README.md:622 (`STATE_FILE_PATTERNS` → lazy `stateFilePatterns()`, matches guarded directories too)
- **Applied:** README.md config table: `PHASE_TRANSITIONS` → `VALID_TRANSITIONS`; `STATE_FILE_PATTERNS` row → lazy `stateFilePatterns()` matching guarded files AND directories.

### Fix 15: loom.md hook table pre-inversion phrasing
- **File:** commands/loom.md:487
- **Fix:** Mirror README.md:364 / wave-gate.md:18 deny-by-default phrasing.
- **Applied:** loom.md:487 guard-state-file row reworded to the deny-by-default phrasing (mirrors README.md:364 / wave-gate.md:18).

### Fix 16: loom.md dispatch rows list nonexistent `.sh` files
- **File:** commands/loom.md:499-503
- **Fix:** Correct to TS handlers under engine/src/handlers/subagent-stop/ routed by dispatch.sh.
- **Applied:** loom.md dispatch rows corrected to the TS handlers under engine/src/handlers/subagent-stop/ routed by dispatch.sh.

### Fix 17: placeholderFor comment overclaims "Alphanumeric/slash only"
- **File:** engine/src/core/guard-state-file.ts:169
- **Fix:** Placeholders contain `_`/`-`; the load-bearing property is "cannot form a redirect/separator", contingent on operator-set LOOM_SUBAGENT_DIR — state that honestly.
- **Applied:** placeholderFor comment now states the honest load-bearing property (cannot form a redirect/separator; literal parts [A-Za-z_/]) and its contingency on an operator-set LOOM_SUBAGENT_DIR staying shell-special-free.

### Fix 18: "Only hooks write via this manager" omits whitelisted helpers
- **Files:** engine/src/state-manager.ts:4, commands/loom.md:324
- **Fix:** Reword to "hooks and whitelisted helpers (populate-task-graph, complete-wave-gate, set-phase)".
- **Applied:** state-manager.ts header reworded to hooks and whitelisted helpers (populate-task-graph, complete-wave-gate, set-phase, …); loom.md:324 covered by the Fix 4 rewrite.

## Deferred

### SpecCheck verdict/critical_count coupling (type-design advisory)
- **Reason:** Modeling change (`{ verdict: "PASSED"; critical_count: 0 } | …`) ripples through both store sites and pi; batched with the standing mutable-Task/WaveGate/evidence-union ADT cluster deferred in rounds 14–15.
- **Recommendation:** Fold into that refactor; wave-blocking is count-driven and correct today.

### complete-wave-gate checkbox regex extraction (pr-test advisory, rating 3)
- **Reason:** Pure logic trapped in the execSync boundary; reviewer explicitly routed it to the deepen backlog.

### Shared shell tokenizer (standing, round 15)
- **Reason:** Would subsume the duplicated char scanners and close the backslash-in-quote branches; property test (guard/evidence segmentation agreement) specced. Fix 3 shares its redirect-word classifier as an interim step.

### Multi-hop `cd` laundering (residual, documented by Fix 1)
- **Reason:** `cd .claude; cd state; rm *.json` never names a guarded literal on any line — invisible to any raw-text gate by construction. Documented in machines/README.md known residuals.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit && bun test
```
