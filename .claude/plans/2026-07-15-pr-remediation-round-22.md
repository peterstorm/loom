# PR Remediation Plan — Round 22

**Date:** 2026-07-15
**Branch:** feat/deterministic-core-phase-c (loom) + feat/deterministic-core-phase-b (fugue)
**Findings:** 1 critical, 3 advisory (cross-repo review)

Review agents (6 parallel, both repos): loom code-reviewer, loom silent-failure-hunter,
loom type-design-analyzer, fugue code-reviewer, fugue silent-failure-hunter,
fugue type-design-analyzer.

## Critical Fixes

### Fix 1: Nested colonless-default set-but-empty guard bypass (loom)
- **Source:** loom code-reviewer (confidence 88; verified fail-open via `guardStateFileDecision`)
- **File:** `engine/src/core/shell-normalize.ts:209` (root cause), manifests via
  `referencesPattern` / `collapseQuotesColonlessEmpty` in `engine/src/core/guard-state-file.ts`
- **Issue:** Round-21 added `colonlessDefaultsEmpty` to catch a colonless default
  (`${x-w}`/`${x=w}`) expanding to EMPTY when the var is set-but-empty, so
  `.claude/stat${x-X}e` reassembles to `.claude/state`. But `revealDefaultWord`
  recursively normalized a colon-form default's word (`${x:-w}`) with a hardcoded
  `{ mode: "matching-view" }`, never threading `colonlessDefaultsEmpty`. A colonless
  default NESTED inside a revealed colon-form word therefore never produced its
  set-empty output.
  Verified against real bash: `unset x; y=; printf %s ".claude/stat${x:-${y-X}}e"`
  → `.claude/state`, yet `guardStateFileDecision("rm -rf .claude/stat${x:-${y-X}}e/")`
  returned **allow** — a fail-open of the identical vulnerability class round-21 fixed,
  one nesting level deeper. Could delete the loom state directory undetected.
- **Fix:** Thread the enclosing span's `colonlessEmpty` intent into `revealDefaultWord`
  (new 4th parameter) so nested colonless defaults inside a revealed word also collapse
  to empty under the guard's colonless-empty base, at arbitrary nesting depth. The flag
  is matching-view-only and false on the default/evidence-twin path, so the guard and
  evidence twin stay point-wise identical for the primary view — only the additional
  colonless-empty guard base gains the nested coverage.

## Advisory Dispositions

### Advisory 1 (loom type-design): `TaskTestResult` untrusted `label: string` — DECLINED
- **File:** `engine/src/types.ts:82`
- **Reason:** There is exactly ONE producer of an untrusted label in the codebase
  (`store-test-evidence.ts:48`, a single constant literal). A one-member union adds
  ceremony without invariant value — no typo risk with a single constant producer, and
  the value is not part of any closed operator-facing enum. Current shape is defensible.

### Advisory 2 (loom type-design): confirm `parseTaskGraph` narrows `test_result` — RESOLVED
- **File:** `engine/src/types.ts:76-79`
- **Reason:** Already enforced. `state-manager.ts:88-100` proves `test_result` into the
  union at the parse boundary: rejects a non-object, rejects `{verdict:"untrusted"}`
  without a boolean `passed` + string `label`, and rejects unknown verdicts. Not
  documentation-only. No change needed.

### Advisory 3 (fugue type-design): `node-crash` httpStatus↔retriability cross-field — DECLINED
- **File:** `packages/framework/src/types/errors.ts:89-99`
- **Reason:** The correlation is already single-sourced. Both (and only) node-crash
  producers that carry `httpStatus` — `llm-errors.ts:75` and `:180` — derive
  `retriability` from `classifyHttpStatus(status)`. No other call site builds a
  node-crash with an httpStatus. Encoding the correlation at the type level would
  fracture the `node-crash` variant (also used for non-HTTP crashes with no status) and
  ripple into consumers + the cross-repo integrity surface, for no practical gain on a
  structurally-typed wire ADT (a smart constructor cannot prevent literal construction
  in TS structural typing anyway).

## Validation Commands
```bash
cd engine
npx tsc --noEmit
bun test
```

## Result
- Typecheck: clean.
- Tests: 1583 pass, 0 fail (2 new regression tests added: nested colonless-in-colon at
  the normalize layer and the guard-decision layer, both cross-checked against real bash).
- Fugue: no code changes (clean review + declined advisory).
