# PR Remediation Plan — Round 11

**Date:** 2026-07-05
**Branch:** feat/deterministic-core-phase-c
**Findings:** 4 critical, 13 advisory (deduped from 6-agent review)

## Critical Fixes

### Fix 1: WHITELISTED_HELPERS substring bypass voids ledger/machine-dir guarding
- **Source:** type-design-analyzer
- **File:** engine/src/core/guard-state-file.ts:15
- **Issue:** `WHITELISTED_HELPERS.some((h) => command.includes(h))` runs before the
  state-file pattern check and matches anywhere in the command line (echo arg, comment,
  path). One allowed command can append forged trusted TestRun lines to
  `<session>.evidence.jsonl`, rewrite `.active`, or rm machine defs.
- **Fix:** Anchor the whitelist to actual helper invocation: split the command into
  segments (quote-aware, reuse segment logic style from extract-evidence) and only
  allow when a segment's head token invokes the helper. Additionally, evaluate the
  state-file block for SUBAGENT_DIR/MACHINES_DIR before the helper allow. Add tests
  for `echo cleanup-state; ... >> S.evidence.jsonl` shapes.

### Fix 2: dispatch.sh skips SubagentStop cleanup when task graph absent
- **Source:** silent-failure-hunter
- **File:** hooks/scripts/dispatch.sh:5
- **Issue:** Fast path exits 0 when local `active_task_graph.json` missing, so
  `cleanup-subagent-flag` (unbind + removeActive) never runs — binding leaks, stays
  fresh via session-activity TTL refresh, cross-credits parent evidence into dead
  epoch, gates parent, disarms gating for next bound agent.
- **Fix:** Mirror guard-state-file.sh — proceed when graph exists OR any
  `${SUBAGENT_DIR}/*.machine` binding exists.

### Fix 3: machines/README.md stale claim — missingRequirements "not yet consulted"
- **Source:** comment-analyzer + architecture-tech-lead
- **File:** machines/README.md:161
- **Issue:** update-task-status.ts consults missingRequirements at every impl
  SubagentStop and caps trusted-pass via `machine-incomplete` label since round 3.
- **Fix:** Rewrite paragraph: evidence-labeling half shipped; hard-blocking completion
  remains the follow-up.

### Fix 4: executable-models.md stale residual — call-start ordering shipped
- **Source:** comment-analyzer
- **File:** references/executable-models.md:199
- **Issue:** Claims previous-epoch artifacts can vouch and lists mtime-≥-command-start
  stamping as follow-up; both false after df605f9. Contradicts machines/README.md:98.
- **Fix:** Rewrite residual to match machines/README: remaining residuals are same-call
  staging and self-emitting "test" scripts; follow-ups only HMAC / out-of-reach storage.

## Advisory Fixes

### Fix 5: Shell shim runtime fail-safes (guard-state-file.sh, block-direct-edits.sh, dispatch.sh, cleanup-stale-subagents.sh)
- **Source:** code-reviewer + silent-failure-hunter
- guard-state-file.sh + block-direct-edits.sh: add bun/CLAUDE_PLUGIN_ROOT preamble
  (fail closed like enforce-phase-tools.sh), quote `"${CLAUDE_PLUGIN_ROOT}"`.
- dispatch.sh: add bun/CLAUDE_PLUGIN_ROOT check (fail open LOUDLY like
  record-evidence.sh); surface stderr instead of diverting all of it to the debug log.
- cleanup-stale-subagents.sh: run sweep when graph exists OR ${SUBAGENT_DIR} has entries.

### Fix 6: update-task-status skip branch leaves taskId in executing_tasks
- **File:** engine/src/handlers/subagent-stop/update-task-status.ts:564-575
- **Fix:** In stand-down branch return state with executing_tasks filtered of taskId.

### Fix 7: FileWrite.via required on domain type
- **File:** engine/src/machine/types.ts:54
- **Fix:** Make `via: FileWriteVia` required; parseEvent maps absence → "tool".

### Fix 8: eventsForEpoch dedup key non-injective
- **File:** engine/src/machine/evidence.ts:301
- **Fix:** `JSON.stringify([r.callId, r.event])`.

### Fix 9: parseTaskGraph proves only union fields
- **File:** engine/src/state-manager.ts:117
- **Fix:** Prove structural fields (id string, depends_on string[], wave number,
  file_list optional string[]) before the cast.

### Fix 10: guard routes crash fail-open
- **File:** engine/src/handlers/pre-tool-use/guard-state-file.ts:55, handler-routes.ts:37
- **Fix:** Wrap stdin JSON.parse in try/catch with fail-closed exit for guard-state-file
  and block-direct-edits; extend FAIL_CLOSED_ROUTES accordingly.

### Fix 11: findReport positional nowMs/callStartMs swap hazard
- **File:** engine/src/machine/report-discovery.ts:120
- **Fix:** Named-args object `{ nowMs, callStartMs }`.

### Fix 12: call-start stamp recency as Record relies on JS key ordering
- **File:** engine/src/machine/evidence.ts (parseCallStartMap/pruneCallStarts), ledger.ts
- **Fix:** Persist ordered array of `{ id, startMs }`; prune by slicing; lookup by scan.
  parseCallStartMap fails closed on old Record shape (corruption path already tested).

### Fix 13: pi call-start stamp comment overstates parity
- **File:** pi/extension.ts:94
- **Fix:** Replace "engine parity" comment with honest "producer only; no pi consumer yet".

### Fix 14: cleanup-stale-subagents.ts header enumeration stale
- **File:** engine/src/handlers/session-start/cleanup-stale-subagents.ts:9
- **Fix:** Refer to SESSION_SUFFIXES instead of enumerating.

### Fix 15: attributeExit doc omits `&`
- **File:** engine/src/machine/extract-evidence.ts:309
- **Fix:** State actual rule ("any operator except ||").

### Fix 16: missing tests
- Shim e2e tests for guard-state-file.sh (binding-without-graph → spawns; no graph/no
  bindings → skip; pin polarity) in engine/tests/e2e/hook-shims-fail-closed.test.ts.
- hooks-sync test pinning guard-state-file.sh to PreToolUse Bash matcher.
- readJunitDir mixed-mtime dir test (stale failing XML beside fresh passing one).
- dispatch.sh binding-without-graph test.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit && bun test
```
