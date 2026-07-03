# PR Remediation Plan — Round 7

**Date:** 2026-07-03
**Branch:** feat/deterministic-core-phase-c
**Findings:** 4 critical, 17 advisory (6 review agents: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead)

## Critical Fixes

### Fix 1: Trusted verdict is permanent — retry's new trusted ground truth can never supersede it
- **Source:** code-reviewer (confidence 90)
- **File:** engine/src/handlers/subagent-stop/update-task-status.ts:500-509 (mirror: pi/extension.ts)
- **Issue:** The locked skip guard preserves any existing trusted verdict unconditionally. When a re-spawned impl agent's fresh epoch yields a genuine `trusted-pass` (real exit 0 + parsed report), it is discarded. Composed with `complete-wave-gate.ts:59` (trusted-fail = missing evidence) and `store-test-evidence.ts:37` (also refuses trusted), the first real red run permanently wedges the task — no reset path exists.
- **Fix:** Make the guard trust-aware on both sides: skip only when the existing verdict is trusted AND the incoming resolution's verdict is `"untrusted"`. Newer ground truth (trusted-pass OR trusted-fail) supersedes older ground truth; laundered text still can't. Mirror in pi/extension.ts. Keep `store-test-evidence.ts` as-is (its input is untrusted stdin).
- **Tests:** existing trusted-fail + new snapshot `{exit: 0, report: {total: n, failed: 0}}` → persists trusted-pass; existing trusted-pass + new untrusted → preserved; status "completed" → still skipped. Check `update-task-status.property.test.ts` for an invariant that encodes the old behavior and refine it to "trusted never overwritten *by untrusted*".

### Fix 2: Wave gate check 4 fails OPEN on EVIDENCE_CAPTURE_FAILED spec checks
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/helpers/complete-wave-gate.ts:101-113
- **Issue:** `critical_count ?? 0` coalesces the unknown count to zero, so a spec_check record with `verdict: "EVIDENCE_CAPTURE_FAILED"` and no `critical_count` passes as "Spec alignment verified (verdict: EVIDENCE_CAPTURE_FAILED)".
- **Fix:** Fail closed when `verdict === "EVIDENCE_CAPTURE_FAILED"` OR `critical_count === undefined`, with a message including `state.spec_check.error` and instructing re-run of /spec-check.
- **Tests:** add EVIDENCE_CAPTURE_FAILED and missing-critical_count cases to complete-wave-gate.test.ts.

### Fix 3: Forgeable trusted-pass — exit misattribution + Bash-authored artifact veto blind spot
- **Source:** silent-failure-hunter
- **Files:** engine/src/machine/extract-evidence.ts:303-310, engine/src/handlers/post-tool-use/record-evidence.ts:72-84
- **Issue:** (a) `classifyTestCommand` selects one segment but `extractBashOutcome` records the whole command line's exit — `false && npx vitest run --outputFile=X; true` classifies vitest (never executed) with exit 0. (b) The `--outputFile` veto set is built only from Edit/Write FileWrite events; a report staged via Bash (`cat > /tmp/r.json <<EOF`) mints nothing and vouches. Combined: forged trusted-pass, which Fix 1's guard then makes durable against untrusted correction.
- **Fix:**
  - **Exit ownership rule** (fail closed to `exit: null` = untrusted when unprovable): let segments be s1 op1 s2 … sn with classified segment si. Single segment: attribute as today. Multi-segment: exit 0 is attributable iff i == n and op(n-1) ∈ {`&&`, `;`, `|`} (never after `||`); nonzero exit is attributable iff i == n and op(n-1) is `;` (a `&&`-guarded test may never have run). Preserve the operators in `splitCommandSegments` (or a sibling) to make this decision. `cd engine && bun test` with exit 0 MUST remain trusted (pin with a test — usability regression guard).
  - **Bash write minting:** mint FileWrite evidence for redirect/tee targets in every Bash segment — quote-aware scan for `>`, `>>`, `&>`, `n>`/`n>>` targets and `tee [-a]` file args; normalize paths the same way other FileWrite paths are. This makes cross-call staging visible to the veto.
  - Update the veto comment in record-evidence.ts (it currently over-claims), and document the remaining residual (cp/mv/dd of=/interpreter-authored writes) in machines/README.md and references/executable-models.md "known residuals", alongside the existing ledger-forgery residual.
- **Tests:** `false && npx vitest run --outputFile=X; true` exit 0 → NOT trusted-pass; `npm test || true` → untrusted; `A && npm test` nonzero → untrusted (not trusted-fail); `A; npm test` nonzero → trusted-fail; `cd engine && bun test` exit 0 → trusted-pass; Bash `cat > /tmp/r.json` staging then vitest `--outputFile=/tmp/r.json` → vetoed; unrelated redirect path → does not veto. Also add the missing backslash-escape classifier tests (`\"` quote-state, `\#` vs `#`, escaped separators) — pr-test-analyzer advisory, same file.

### Fix 4: withLock stale-reap is not atomic — mutual exclusion violable
- **Source:** architecture-tech-lead (confidence 90)
- **File:** engine/src/utils/lock.ts:16-68
- **Issue:** (1) mkdir-then-write-pid leaves a missing-pid window in which a contender judges the live lock stale and rmSyncs it; (2) two contenders can both observe a genuinely stale lock and the second's rmSync deletes the first's fresh lock; (3) releaseLock removes the lock unconditionally even when ownership was stolen.
- **Fix:** (a) atomic birth — create a private temp dir containing the pid file, `renameSync` it onto the lock dir (rename fails when a non-empty lock dir exists, preserving EEXIST semantics); (b) atomic steal — reap via `renameSync(lockDir, tomb)` where only the winning renamer removes the tomb and retries, losers fall through to normal retry; (c) ownership-checked release — only remove if the pid file still names `process.pid`. Keep the public `withLock` API and retry/backoff behavior.
- **Tests:** stale lock (dead pid) is stolen and acquired; a lock dir already renamed away (tomb race) makes the loser retry, not crash; releaseLock is a no-op when the pid file names another pid; fresh lock with live pid is never reaped.

## Advisory Fixes

### Fix 5: Bare JSON.parse on directly-registered route
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/subagent-stop/store-spec-check-findings.ts:74
- **Fix:** mirror the malformed-stdin guard + named consequence its siblings got (cleanup-subagent-flag.ts:16-24, update-task-status.ts:383-391), noting findings were NOT stored.

### Fix 6: Unguarded final I/O in mark-subagent-active
- **Source:** silent-failure-hunter
- **File:** engine/src/handlers/subagent-start/mark-subagent-active.ts:53,134-137
- **Fix:** wrap the pointer-file mkdirSync/writeFileSync in try/catch naming the degradation (cross-repo SubagentStop resolves to the LOCAL task graph when the pointer is absent).

### Fix 7: isReportSummary skips count-sanity invariant
- **Source:** type-design-analyzer
- **Files:** engine/src/machine/evidence.ts:165-173, engine/src/machine/test-report.ts:33-34,58
- **Fix:** extract one shared `parseReportSummary` (non-negative integers, failed ≤ total) used by parseVitestJson, parseJunitXml, AND isReportSummary. Test the ledger read-back rejection (`{total: 0.5, failed: 0}`).

### Fix 8: Phase / PHASE_ORDER dual source of truth
- **Source:** type-design-analyzer
- **Files:** engine/src/types.ts:54, engine/src/config.ts:16
- **Fix:** derive `type Phase = (typeof PHASES)[number]` from a single const tuple (same pattern as TASK_STATUSES). Mind import direction; the tuple can live in types.ts with config re-exporting PHASE_ORDER.

### Fix 9: BoundaryRule.module invariant comment-only
- **Source:** type-design-analyzer
- **Files:** engine/src/linter/programmatic/no-cross-boundary-imports.ts:19, config.ts:88,107-134
- **Fix:** reject empty module in parseBoundary; make prefix matching segment-aware (match iff path === m, or startsWith(m + "/"), or startsWith(m + ".") for file prefixes like "engine/src/state-manager") so siblings (`state-managerX/`) can't match; make the doc comment describe the actual rule; `maxFunctionLines` must be a positive integer (`Number.isInteger`). Tests for each.

### Fix 10: DEFAULT_PURE_MODULES flags its own codebase
- **Source:** comment-analyzer
- **File:** engine/src/linter/programmatic/no-io-in-pure-modules.ts:19-20
- **Fix:** `engine/src/core/` and `engine/src/parsers/` contain fs imports + (this PR) process.stderr.write, both banned by the rule. Drop those two entries from the defaults (only `machine/` entries are verified by machine-purity.test.ts) or narrow them accurately; update comments so the shipped defaults are truthful. Verify by running the rule over the repo.

### Fix 11: "Pure function" mislabels
- **Source:** comment-analyzer
- **Files:** engine/src/core/block-direct-edits.ts:3, engine/src/core/index.ts:2
- **Fix:** reword to "harness-agnostic — no stdin parsing" (it does fs I/O and stderr writes).

### Fix 12: README six-check list omits new_tests_required exemption
- **Source:** comment-analyzer
- **File:** README.md:224 and check 1 (~line 246)
- **Fix:** note the `new_tests_required === false` exemption implemented in complete-wave-gate.ts:58-59.

### Fix 13: SessionId brand demanded at only one entry point
- **Source:** type-design-analyzer
- **Files:** engine/src/machine/ledger.ts, engine/src/machine/evidence.ts:226,246-253, handlers (record-evidence.ts, enforce-phase-tools.ts, cleanup-subagent-flag.ts, mark-subagent-active.ts)
- **Fix:** thread `SessionId` through the exported ledger API and the SessionRegistry port; parse once at each handler boundary via parseSessionId; the throw in sessionFilePath becomes unreachable-by-type. Use branded AgentId for `resolveSoleActiveBinding`'s roster where rosterAgentId already produces it. Keep the documented `unbind` raw-string asymmetry.

### Fix 14: SessionRegistry port not threaded through production handlers
- **Source:** architecture-tech-lead (confidence 76; self-acknowledged deferral at evidence.ts:240-244)
- **Fix:** give each lifecycle handler core a `(registry: SessionRegistry, …)` shape with `fsSessionRegistry` as default arg (same pattern as DiffDeps in update-task-status.ts:277-301). Widen the port with `refreshBindingActivity`/`readBindings` as needed; `loadMachine` may stay concrete with a note. Where cheap, add a handler-level test against fake-session-registry.ts.

### Fix 15: Coverage gaps (pr-test-analyzer advisories)
- populate-task-graph.test.ts re-implements the overwrite guard — replace shadow tests with funnel tests through the real handler (pattern: validate-model-bindings.test.ts). (6/10)
- enforce-phase-tools.ts:51,60 — passthrough-when-ungated arms + anyBindingExists catch untested. (5/10)
- state-manager.ts:35-42 — dangling session-pointer fallback (warn + local fallback) untested. (5/10)
- update-task-status.ts:385-391 — malformed-stdin guard untested. (4/10)
- store-spec-check.ts — helper has zero tests incl. parseSpecCheckVerdict rejection wiring. (4/10)
- validate-task-graph.ts:43-52,95-115 — fixMinimal + non-array/non-boolean type-error branches untested. (3/10)
- (backslash-escape classifier tests are folded into Fix 3.)

## Deferred

### Task per-status discriminated union + readonly fields
- **Reason:** persisted wire-format refactor with blast radius across every handler; prior rounds deliberately deferred. Not a minimal remediation edit.
- **Recommendation:** separate PR; model completed⟹test_result, failed⟹failure_reason, blocked⟹critical_findings as a per-status union mirroring PhaseDef.

### /tmp SUBAGENT_DIR trust root + execSync gh interpolation
- **Reason:** security-review scope (multi-user host threat model); HMAC follow-up already documented in machine/types.ts:26-29.
- **Recommendation:** run loom:security-agent over config.ts:86 and complete-wave-gate.ts:357-364,431 before any multi-tenant deployment.

### Stdout-JSON report forgery residual
- **Reason:** accepted + documented (machines/README.md:92-107, executable-models.md:183-207). Not re-litigated.

## Validation Commands
```bash
cd /home/peterstorm/dev/claude-plugins/loom/engine && bunx tsc --noEmit
cd /home/peterstorm/dev/claude-plugins/loom/engine && bun test
```
