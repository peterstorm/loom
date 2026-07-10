# PR Remediation Plan — Round 17

**Date:** 2026-07-10
**Branch:** feat/deterministic-core-phase-c
**Findings:** 4 critical (2 code, 2 docs), 6 advisory
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead

## Critical Fixes

### Fix 1: collapseQuotes models only quote-stripping — backslash escapes AND `$'…'`/`$"…"` launder guarded paths past the front gate
- **Source:** code-reviewer + architecture-tech-lead (both live-verified, same root cause); pr-test-analyzer + type-design flagged the `$'…'` half as advisory
- **File:** engine/src/core/guard-state-file.ts:121 (`collapseQuotes`), consumed at :369 (front gate), chain scope, protected-dir check, and `placeholderFor`
- **Issue:** `collapseQuotes` stripped `'`/`"` but preserved backslash escapes verbatim and never decoded ANSI-C `$'…'`. Bash removes an unquoted `\x` (`.cl\aude` → `.claude`) and decodes `$'\x2e\x63…'` → `.c…` at execution time. Both spellings executed against the guarded path while the collapsed matching view still contained the backslash / literal `\x2e`, so `stateFilePatterns().test(collapseQuotes(command))` returned false → ALLOW. Live-verified: `echo FORGED > .claude/st\ate/active_task*.json`, `rm .claude/st\ate/active_task_gr\aph.json`, and hex/octal `$'…'` encodings of the task-graph path and `/tmp/claude-subagents` all forged/deleted state while the guard allowed them. The evidence extractor's `readRedirectTarget` already de-escapes backslashes — so the two shell scanners disagreed on the same input (a fail-open divergence).
- **Fix:** Extend `collapseQuotes` to reproduce every bash word-normalization that can hide a guarded literal, all strictly reveal-monotonic (fail-closed): drop unquoted/double-quoted backslash escapes; decode `$'…'` ANSI-C bodies (`\xHH`/`\uHHHH`/`\UHHHHHHHH`/`\NNN` octal/named escapes) via a new `decodeAnsiC` + `findAnsiCClose`; treat `$"…"` as `"…"`. Rewrote the docblock to enumerate the four normalizations and the reveal-monotonic argument.
- **Applied:** New `findAnsiCClose` + `decodeAnsiC` helpers; `collapseQuotes` now drops backslashes and decodes `$'…'`/`$"…"`. Regression rows added to guard-state-file.test.ts (backslash: 4 block; ANSI-C hex/octal + `$"…"`: 3 block + 1 allow precision; plus A2/A3 substitution-body and protected-dir quote-collapse pins). Live-verified the encoded forgeries now BLOCK.

### Fix 2: PreToolUse spawn gates fail OPEN on a corrupt task graph or malformed stdin
- **Source:** silent-failure-hunter (live-verified exit codes)
- **Files:** engine/src/handler-routes.ts (FAIL_CLOSED_ROUTES), engine/src/handlers/pre-tool-use/{validate-task-execution,validate-phase-order,validate-template-substitution}.ts
- **Issue:** The three Task-spawn gates were absent from `FAIL_CLOSED_ROUTES`, and their handlers did uncaught `JSON.parse(stdin)` / `mgr.load()`. A corrupt `active_task_graph.json` or malformed hook payload threw, hit `cli.ts main().catch`, and exited 1 — NON-blocking for PreToolUse — so the Task spawn proceeded with wave-order, dependency, review-gate, phase-order, and template-substitution enforcement silently skipped. validate-phase-order was worse: it caught the parse error and returned `allow` (explicit fail-open). Same class round-11 hardened for guard-state-file/block-direct-edits, but these gates were left out.
- **Fix:** Added the three routes to `FAIL_CLOSED_ROUTES` (a top-level crash on them now exits 2), and made each handler's stdin-parse boundary return an explicit fail-closed `block` (validate-phase-order's `allow` → `block`) matching the guard-state-file pattern.
- **Applied:** handler-routes.ts + three handlers updated; cli-fail-polarity.test.ts extended with the three fail-closed route assertions; new spawn-gates-fail-closed.test.ts pins the malformed-stdin block for all three plus route membership.

### Fix 3: wave-gate.md / spec-check.md / loom.md recommend `WAVE=$(jq … state)` — blocked by the guard this branch shipped
- **Source:** comment-analyzer (live-verified block/allow verdicts)
- **Files:** commands/wave-gate.md:55/162/236, commands/spec-check.md:28/33/62, commands/loom.md:365
- **Issue:** The guard's deny-by-default inversion (round 13) blocks binding a guarded read into a variable (`hasReadOnlyHead` fails a pure assignment). `WAVE=$(jq -r '.current_wave' .claude/state/active_task_graph.json)` → BLOCK. Every wave-gate / spec-check / re-spawn flow that captured the wave number this way looped on an impossible command (and shell vars don't persist across Bash tool calls anyway). spec-check runs inside every wave gate via spec-check-invoker.
- **Fix:** Replaced each capture with a self-contained jq program that resolves the wave inside the query: `jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | .id' …` (live-verified ALLOW). Added a one-line note at each site that the capture form is guard-blocked.
- **Applied:** All 7 sites rewritten; verified the new form allows and the old capture blocks via `guardStateFileDecision`.

### Fix 4 (docs): README max-function-lines default + stale counts
- **Source:** comment-analyzer
- **File:** README.md:444, :665, :744, :753, :59
- **Issue:** README claimed `max-function-lines (>60)` — the shipped default is 50 (`DEFAULT_MAX_LINES`); "46 test files" (now 84); per-category test counts stale; `/loom --status/--complete/--abort` shown as working (loom.md marks them planned).
- **Applied:** `max-function-lines` → "(default: 50)"; hard test counts dropped ("46 files"/"46 test files"/per-category parentheticals removed); `/loom` status/lifecycle block annotated "(planned — not yet implemented)".

## Advisory Fixes

### Fix 5: pi PI_FILE_TOOLS under-collects — misses capitalized Write/Edit and multi_edit (fail-open under pi)
- **Source:** type-design-analyzer (live-verified)
- **File:** engine/src/parsers/parse-files-modified.ts:10
- **Issue:** Round-16 Fix 8 routes pi's lint-target collection through `parseFilesModified(piJsonl, "pi")`, but `PI_FILE_TOOLS` matched only lowercase `write`/`edit`. pi treats `multi_edit` as first-class (extension.ts tool_result gate) and hedges on `write`/`Write` casing (extension.ts:341), so a pi subagent editing via multi_edit or capitalized tool blocks yielded `files_modified = []` → wave-gate lints an empty set. The exact fail-open Fix 8 set out to close, reintroduced for those tool shapes.
- **Applied:** `PI_FILE_TOOLS` now includes `multi_edit`/`multiedit` and the match is case-folded (`block.name.toLowerCase()`), with a docblock stating the fail-open it guards.

### Fix 6: wave-completion gate write (impl_complete) unpinned in engine + pi
- **Source:** pr-test-analyzer (mutation-verified: `if(isWaveComplete)`→`if(false)` survived the full suite)
- **File:** engine/src/handlers/subagent-stop/update-task-status.ts:705
- **Issue:** Round-16 Fix 12's 4 tests pinned only the pure `isWaveComplete` predicate and the resolution — not the `wave_gates[wave].impl_complete = true` write.
- **Applied:** Added a `runUpdateTaskStatus` integration describe to update-task-status-machine.test.ts: last task of a wave → `impl_complete: true`; a still-pending sibling → `impl_complete: false`.

### Deferred (unchanged from rounds 15–16)
- **Shared shell tokenizer** — architecture escalated it from deferred toward required (round 17 is the second consecutive round where scanner fragmentation produced a live hole; Fix 1's `collapseQuotes` extension is the interim). The specced guard/evidence segmentation-agreement property test remains the terminal fix. Kept deferred this round: it subsumes ~7 hand-rolled lexers and is a larger refactor than the point fix.
- Multi-hop `cd` laundering residual (documented round 16); SpecCheck verdict/count ADT cluster; complete-wave-gate checkbox regex extraction; the duplicated "task becomes implemented" write shape (type-design low, trusted-misuse already unrepresentable).
- README:219 five-step gate table omits Step 4b (advisory triage) — low, doc-completeness only.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit && bun test
```
