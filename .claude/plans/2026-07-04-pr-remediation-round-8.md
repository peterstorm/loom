# PR Remediation Plan — Round 8

**Date:** 2026-07-04
**Branch:** feat/deterministic-core-phase-c
**Review:** 6-agent parallel (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent)
**Findings:** 0 critical, 7 advisory

Round 8 of a heavily-reviewed PR. code-reviewer, silent-failure-hunter,
pr-test-analyzer, and comment-analyzer each returned CLEAN (0/0). The codebase
was described as "reference-grade functional-core/imperative-shell work." Only
type-design (4 advisory) and architecture (3 advisory) surfaced items.

## Applied Fixes

### Fix 1: Brand the `.active` roster read-back (identity safety)
- **Source:** type-design-analyzer
- **Files:** `engine/src/machine/evidence.ts:225`, `engine/src/machine/ledger.ts:167`
- **Issue:** `readActiveAgents` returned raw `string[]` straight off disk and
  `resolveSoleActiveBinding` compared it against branded `AgentId`s as raw
  strings — the one place the otherwise-total brand discipline lapsed. This
  comparison gates whether contended evidence is cross-credited.
- **Fix:** `readActiveAgents` now maps each roster line through the same
  producer that wrote it (`rosterAgentId`), returning `AgentId[]`; the mapping
  (not dropping) preserves the count so a corrupt line can never silently
  shrink the roster into a false 2→1 attribution. `resolveSoleActiveBinding`'s
  `activeRoster` param is now `readonly AgentId[]`, closing the brand loop.
  Fake registry `active` map and the property-test roster literals updated to
  match.

## Deferred (documented, not regressions)

### Task/TaskId branding + validate-task-graph parse-don't-validate
- **Source:** type-design-analyzer (advisory 2, 3)
- **Reason:** `Task.id`/`agent`/`wave` are pre-existing unbranded primitives in
  the older task-graph layer; invariants live in `validateFull` via `as` casts.
  This is legacy the PR did not regress, and branding `TaskId` + threading a
  `parseTask` through `validate-task-graph.ts` is a cross-cutting refactor of
  the graph layer, out of scope for a review-remediation pass.
- **Recommendation:** dedicated follow-up: add `TaskId` brand + `parseTask`,
  reuse the existing known-agent parse for `agent`.

### WaveGate.tests_passed tri-state union
- **Source:** type-design-analyzer (advisory 4)
- **Reason:** `boolean | null` encodes {passed, failed, pending}. Migrating to a
  `"passed"|"failed"|"pending"` union changes the persisted task-graph JSON
  shape and touches every read site + state-manager serialization — behavior is
  correct today; a consistency nit not worth the compatibility surface here.

### SessionRegistry port threading through 3 remaining handlers
- **Source:** architecture-agent (advisory 1)
- **Reason:** `mark-subagent-active.ts`, `dispatch.ts`, `update-task-status.ts`
  call the concrete `ledger.ts` fs functions directly rather than the injected
  `SessionRegistry` port. Behavior-preserving but a multi-file signature
  refactor that would also want fresh fake-based tests — larger than a minimal
  remediation edit. The fs functions they call are the same ones the adapter
  wraps, so there is no defect.

### machine/index.ts barrel FC/IS sub-path split; advance-phase.ts fs seams
- **Source:** architecture-agent (advisory 2, 3)
- **Reason:** structural refactors (module-resolution-enforced core/shell split;
  lifting `existsSync`/`readdirSync` in `resolveTransition` to injected seams).
  The purity boundary is already machine-enforced by `machine-purity.test.ts`;
  these improve enforcement locality but are not defects.

## Validation

```bash
cd engine && npx tsc --noEmit   # → exit 0
bun test                        # → 1365 pass, 0 fail
```
