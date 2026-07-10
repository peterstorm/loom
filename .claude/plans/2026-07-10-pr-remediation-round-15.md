# PR Remediation Plan — Round 15

**Date:** 2026-07-10
**Branch:** feat/deterministic-core-phase-c
**Findings:** 5 critical, 12 advisory (after dedup across 6 agents)

Focus of this round: commit 30fe5ec (guard-state-file allowlist inversion) was unreviewed
until now. Three independent agents found live-verified bypasses in its new parsing layer.

## Critical Fixes

### Fix 1: `>&<file>` redirect misclassified as fd-dup — write bypass
- **Source:** code-reviewer + pr-test-analyzer + type-design-analyzer (all verified live: allow)
- **File:** engine/src/core/guard-state-file.ts:146
- **Issue:** `hasOutputRedirect` exempts every `>` followed by `&` as an fd-dup. Bash `>&word`
  where word is a filename redirects stdout+stderr TO THE FILE. `echo FORGED >& active_task_graph.json`
  → allow (forges task graph); `bun cli.ts helper set-phase execute >& $SUBAGENT_DIR/s.evidence.jsonl`
  → allow (forges the protected evidence ledger — defeats both the read-only redirect check and the
  helper protected-dir guard, since both rely on hasOutputRedirect).
- **Fix:** Only exempt `>&` when the char after `&` is a digit or `-`; otherwise it is a file write:
  ```ts
  if (c === ">") {
    if (segment[i + 1] !== "&") return true;
    const after = segment[i + 2];
    if (after === undefined || !/[0-9-]/.test(after)) return true; // >&file
  }
  ```
  Also fix the prose invariant at lines 119-125 (currently states all `>&` are fd-dups).
  Test rows (guard-state-file.test.ts): `echo forged >& active_task_graph.json` block;
  `echo forged >&.claude/state/active_task_graph.json` block; helper `>&` into evidence ledger block;
  `cat active_task_graph.json >&2` allow; `cat active_task_graph.json 2>&1` allow.

### Fix 2: `|&` pipe operator fragments the pipe-chain trust unit
- **Source:** code-reviewer + silent-failure-hunter (both verified live: allow)
- **File:** engine/src/machine/extract-evidence.ts:101 (`|` branch of splitCommandSegmentsWithOps),
  surfacing via pipeChains in engine/src/core/guard-state-file.ts:270
- **Issue:** Bash `|&` (= `2>&1 |`) is parsed as `|` + background `&`, emitting a spurious empty
  segment and starting a NEW chain, so the downstream executor escapes the chain-scope check.
  `cat active_task_graph.json |& xargs rm` → allow; `echo 'rm active_task_graph.json' |& sh` → allow.
  Plain-pipe equivalents correctly block.
- **Fix:** In the `|` branch, consume a following `&` as part of one pipe op:
  `else if (command[i+1] === "&") { push("|"); i++; }` — bash-accurate for the evidence-extraction
  consumer too (it currently mis-emits an empty background segment there as well).
  Test rows: the three `|&` probes above block; `cmd1 |& cmd2` in extract-evidence tests still
  attributes segments correctly (re-run evidence tests).

### Fix 3: `rg` in READ_ONLY_STATE_COMMANDS can exec arbitrary programs (`--pre`)
- **Source:** architecture-tech-lead
- **File:** engine/src/config.ts:157-164
- **Issue:** `rg --pre <cmd> . active_task_graph.json` invokes `<cmd> <FILE>` per input file —
  a pre-staged script receives the guarded path and can rewrite/delete it. Violates the allowlist's
  own membership criterion ("unable to write a file under ANY flag combination"). Also `--hostname-bin`.
- **Fix:** Remove `rg` from READ_ONLY_STATE_COMMANDS (grep remains for legit reads). Audit `more`
  for the same class (interactive shell-escape; non-interactive acts like cat) — remove if present,
  deny-by-default. Test rows: `rg --pre /tmp/w.sh . active_task_graph.json` blocks;
  `rg pattern active_task_graph.json` now blocks (unenumerated); `grep pattern active_task_graph.json`
  still allows. Update the allowlist docblock's excluded-command list with the rg rationale.

### Fix 4: docs/pi-usage.md documents the retired denylist and a workaround the new guard blocks
- **Source:** comment-analyzer
- **File:** docs/pi-usage.md:196-207 (also :130)
- **Issue:** Describes "state file pattern + write operation pattern" (retired model) and recommends
  `echo "content mentioning the file" > /tmp/doc.md` — which the allowlist guard BLOCKS (guarded
  token + redirect on one line). An agent following this doc loops on an impossible workaround.
- **Fix:** Rewrite around the deny-by-default model: a line naming guarded state passes only if every
  guarded segment is a whitelisted helper or an allowlisted read-only head with no output redirect;
  workaround = never name the guarded path in a writing command line.

### Fix 5: config.ts STATE_FILE_PATTERNS docblock still says "combined with a write pattern"
- **Source:** comment-analyzer
- **File:** engine/src/config.ts:114
- **Issue:** "so ANY reference to the dir combined with a write pattern blocks" — the write-pattern
  concept was retired by 30fe5ec twenty lines below.
- **Fix:** Reword to "any reference to the dir in a segment that is not an allowlisted read-only
  command or whitelisted helper blocks". Keep the glob/brace rationale at :118-122.

## Advisory Fixes

### Fix 6: cleanup-stale-subagents.sh missing the runtime-guard preamble every sibling shim has
- **Source:** silent-failure-hunter
- **File:** hooks/scripts/cleanup-stale-subagents.sh (final line)
- **Fix:** Add the sibling preamble: check CLAUDE_PLUGIN_ROOT set + `command -v bun`, drain stdin,
  `echo "cleanup-stale-subagents: runtime unavailable — stale sweep skipped" >&2; exit 0` before exec.

### Fix 7: helper-owned protected-dir redirect guard is unpinned
- **Source:** pr-test-analyzer (mutation-verified: deleting guard-state-file.ts:318 fails no test)
- **Fix:** Add rows: helper `> $SUBAGENT_DIR/s.evidence.jsonl` blocks; helper `>> $MACHINES_DIR/*.machine.json`
  blocks; helper `> active_task_graph.json` (its own file) allows.

### Fix 8: pi Stop-handler TOCTOU re-check has no regression test
- **Source:** pr-test-analyzer
- **File:** pi/extension.ts:457-494
- **Fix:** Extract the verdict-resolution decision (untrusted pass must not overwrite concurrent
  trusted verdict / completed task; still clears executing_tasks) to an exported pure function and
  pin it with a direct test.

### Fix 9: WHITELISTED_HELPERS is a mutable exported string[]
- **Source:** type-design-analyzer
- **File:** engine/src/config.ts:72
- **Fix:** Declare `as const` / ReadonlyArray (drop the `as readonly string[]` cast at the use site).

### Fix 10: README.md:707 "reads are fine" overstates the allowlist model
- **Source:** comment-analyzer
- **Fix:** "reads via read-only commands (jq, cat, grep, …) are fine".

### Fix 11: machines/README.md:139-142 forgery-blocked claim lacks the graph-absent caveat
- **Source:** comment-analyzer
- **Fix:** Add the caveat: the guard arms only while the task graph exists (guard-state-file.sh
  supports the binding-persists/graph-removed mode); Bash ledger writes are possible in that window.

### Fix 12: pi/extension.ts:14,27 claims imported engine functions are "pure functions"
- **Source:** comment-analyzer
- **Fix:** Reword to "harness-agnostic, no Claude Code dependency" (guardStateFile /
  validateTaskExecution / resolveTransition all do fs I/O).

### Fix 13: Three core validators claim "Pure function" while importing node:fs
- **Source:** comment-analyzer
- **Files:** engine/src/core/validate-task-execution.ts:3, validate-phase-order.ts:3,
  validate-template-substitution.ts:3
- **Fix:** Apply the round-14 "Not pure: reads the filesystem" header treatment.

### Fix 14: artifacts/tests/test-loom.sh stale "write patterns" legacy section
- **Source:** comment-analyzer
- **File:** artifacts/tests/test-loom.sh:267-270
- **Fix:** Retitle to the allowlist model or delete the stale section (it targets a nonexistent
  .claude/hooks/PreToolUse/ path).

### Fix 15: Guard path patterns freeze MACHINES_DIR at import; bind/gate resolve at call time
- **Source:** architecture-tech-lead
- **File:** engine/src/config.ts:124,133
- **Fix:** Build the guarded-path patterns lazily from machinesDir() at decision time (a
  `guardedPathPatterns()` helper or equivalent), mirroring mark-subagent-active / update-task-status.
  Test: re-pointed LOOM_MACHINES_DIR is guarded.

## Deferred

### WaveGate.tests_passed tri-state boolean|null → status union (type-design-analyzer)
- **Reason:** Changes the persisted state-file schema (JSON on disk) — needs a migration/compat
  decision, not a minimal edit. newWaveGate is already the single construction seam.
- **Recommendation:** Batch with the deferred Task evidence-union refactor cluster.

### Shared shell tokenizer for guard + extract-evidence (architecture-tech-lead)
- **Reason:** Structural extraction of ~7 char-level scanners into one utils module + property test
  asserting guard and evidence segmentation agree. The known divergence (findClosingParen ignores
  backticks) currently fails CLOSED, so no live hole. Dedicated refactor.

### Standing deferrals (rounds 13-14, unchanged): dead "failed" TaskStatus / evidence-union
refactor; store-spec-check marker-parsing unification.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit
cd engine && bun test
```
