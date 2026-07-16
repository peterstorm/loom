# PR Remediation Plan — Round 12

**Date:** 2026-07-08
**Branch:** feat/deterministic-core-phase-c
**Findings:** 4 critical (2 code, 2 docs), 11 advisory

## Critical Fixes

### Fix 1: Segment-scope the helper allow in guard-state-file
- **Source:** code-reviewer + silent-failure-hunter + pr-test-analyzer (all three, verified live)
- **File:** engine/src/core/guard-state-file.ts:77-99, engine/src/config.ts:119-134
- **Issue:** `commandInvokesWhitelistedHelper` allows the ENTIRE command line when any
  segment is a real helper invocation. Round 11 hoisted the SUBAGENT_DIR/MACHINES_DIR
  check before the allow but left `active_task_graph.json` / `review-invocations`
  unprotected: `bun cli.ts helper set-phase execute && chmod 644 .claude/state/active_task_graph.json && sed -i 's/trusted-fail/trusted-pass/' …` → allow.
  Forges test/spec/wave verdicts; defeats the ledger trust chain.
- **Fix:** Segment-scope the state-file write check: before returning the helper allow,
  every segment that matches STATE_FILE_PATTERNS + WRITE_PATTERNS must itself be a
  helper invocation. Helpers legitimately write the graph (single-segment redirect of
  helper output stays allowed); non-helper segments carrying a state-file write block.
  Add tests: multi-segment smuggle variants (`;`, `&&`, `|`) for task graph and
  review-invocations → block; single-segment `helper X > active_task_graph.json` → allow.

### Fix 2: Strip evidence/status fields at the populate-task-graph boundary
- **Source:** type-design-analyzer
- **File:** engine/src/handlers/helpers/populate-task-graph.ts:139-146
- **Issue:** Incoming decompose tasks are spread through unmodified; `validateFull`
  never checks `status`/`review_status`/`test_result`/`new_tests_written`/`test_evidence`,
  so agent-controlled stdin can mint `trusted-pass` verdicts and pre-passed reviews,
  pre-stamping every wave-gate check.
- **Fix:** Normalize at the boundary: force `status: "pending"`, `review_status: "pending"`,
  and strip `test_result`, `test_evidence`, `new_tests_written`, `new_test_evidence`,
  `critical_findings`, `advisory_findings` from incoming tasks. Add test.

### Fix 3: README Hook System section — add branch hooks
- **Source:** comment-analyzer
- **File:** README.md:353-420
- **Issue:** PreToolUse table omits `enforce-phase-tools`; PostToolUse omits
  `record-evidence`; `mark-subagent-active` row omits machine binding/epoch minting;
  pipeline diagram missing record-evidence leg. Contradicts hooks/hooks.json.
- **Fix:** Mirror commands/loom.md:483-497.

### Fix 4: README immediate lint tier is regex-only
- **Source:** comment-analyzer
- **File:** README.md:369,433
- **Issue:** Claims immediate tier runs "a small set of programmatic rules";
  loader.ts:81 filters to regex rules only. Contradicts CONTEXT.md:84.
- **Fix:** State regex-only, programmatic at full tier (wave gate).

## Advisory Fixes

### Fix 5: populate-task-graph --fix must re-validate
- **File:** engine/src/handlers/helpers/populate-task-graph.ts:83-85
- **Fix:** Re-run validateFull after fixFull; return error listing residual issues.

### Fix 6: store-spec-check count/findings mismatch fails closed
- **File:** engine/src/handlers/helpers/store-spec-check.ts:45
- **Fix:** Error when reported critical_count disagrees with parsed CRITICAL lines,
  mirroring the auto handler.

### Fix 7: Anchor generic test-summary matchers
- **File:** engine/src/handlers/subagent-stop/update-task-status.ts:102-108
- **Fix:** Anchor pytest/generic `(\d+) passed` to line start / summary shape so prose
  ("3 passed review") can't mint a passing untrusted result.

### Fix 8: Gate dispatch.sh debug log behind LOOM_DEBUG
- **File:** hooks/scripts/dispatch.sh:16
- **Fix:** Only append to the debug log when LOOM_DEBUG is set.

### Fix 9: mark-tests-passed honors new_tests_required == false
- **File:** engine/src/handlers/helpers/mark-tests-passed.ts:50 (vs README.md:224)
- **Fix:** Apply the same exemption as complete-wave-gate's checkTestEvidence so the
  helper and the final gate agree (and README:224 becomes true).

### Fix 10: wave-gate.md / README review_status + exemption wording
- **Files:** commands/wave-gate.md:183,185; README.md:248
- **Fix:** Check 1 notes the new_tests_required==false exemption; check 3 stated as
  "review_status is passed or blocked".

### Fix 11: README stale transcript-extraction phrasing
- **File:** README.md:5,502
- **Fix:** "resolve test evidence (evidence ledger first, labeled transcript fallback)".

### Fix 12: Reattach orphaned JSDoc blocks
- **Files:** engine/src/machine/types.ts:33-40 (Evidence doc), engine/src/machine/evidence.ts:73-78 (SESSION_SUFFIXES doc)
- **Fix:** Move blocks to their intended declarations.

### Fix 13: ledger.ts header file inventory
- **File:** engine/src/machine/ledger.ts:6-9
- **Fix:** Reference SESSION_SUFFIXES / list .active, .cleanup, .callstart.json.

### Fix 14: Extract shared parseWaveArg + DEFAULT_WAVE_GATE
- **Files:** complete-wave-gate.ts:35, lint-wave-gate.ts:26, mark-tests-passed.ts:16;
  wave-gate literal ×3
- **Fix:** Shared module handlers/helpers/wave-args.ts + newWaveGate() factory.

## Deferred

### runUpdateTaskStatus decomposition (architecture advisory)
- **Reason:** 237-line shell orchestrator refactor with no behavior change; pure logic
  already extracted and tested. High churn during a remediation round.
- **Recommendation:** Standalone refactor PR after this branch merges.

### pi extension call-start stamp behavioral coverage (test advisory)
- **Reason:** Producer-only path (nothing consumes pi stamps yet); regression degrades
  toward fail-closed. Needs handler extraction to test properly.
- **Recommendation:** Pin when pi grows an evidence consumer.

### Task paired evidence fields → union (type advisory)
- **Reason:** Persisted-state schema change rippling through parseTaskGraph and every
  reader; not a point fix.
- **Recommendation:** Fold into the NewTestEvidence-shaped union in a dedicated change.

### validateFull → ParseResult refactor (type advisory)
- **Reason:** Partially subsumed by Fixes 2 and 5 (boundary normalization + re-validate).
  Full parse-typed rewrite is a standalone change.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit && bun test
```
