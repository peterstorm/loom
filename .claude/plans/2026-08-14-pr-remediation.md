# PR Remediation — 2026-08-14 (Standalone Review round 43)

## Branch

`feat/architecture-panel-mode-plan` @ `19712b6` (working tree was clean at review start)

## Review Run Directory

`.claude/reviews/review-and-fix-runs/run.36548d2bf7` (standalone-review, kind=all, 367-file changed-path-union scope; 6 reviewers; refutation panel with lenses reproduction/intent/blast-radius; tally-published `result.json` digest `cb22aa44…`).

## Surviving Critical (mandatory — 1)

### C1: Stepped brace sequences bypass the state-file guard
- **id:** `comment-analyzer-1` (upheld 3/3 lenses)
- **file:** `engine/src/core/guard-state-file.ts:219`
- **claim:** `sequenceOptions` covers only unstepped `{x..y}`; bash also expands stepped ranges, and `{a..y..4}` → `a e i m q u y` includes `e`, so `rm -rf .claude/stat{a..y..4}` deletes the guarded `.claude/state` while the guard returns `allow`.
- **verification:** reproduced live (`guardStateFileDecision(...)` → `allow`; bash expands `{a..y..4}` → `a e i m q u y`). Panel verifiers confirmed the exemplar in the stored claim was brace-stripped by `sanitizeProse`, but the substance reproduces with the braced form; blocked the suggestion that it be refuted.
- **fix (implemented, tested):**
  1. `sequenceOptions` now parses optional step (`{x..y..s}`, `[+-]?` signed endpoints and steps), direction from endpoints, step magnitude (zero ⇒ step 1), alpha + signed-integer only, mixed types literal — semantics pinned against real bash (38-case differential sweep, all match).
  2. Zero-padding fidelity for numeric forms (`{01..100}` → `001…100`, `{-5..-01}` → `-05…-01`), matching bash's raw-endpoint-length rule.
  3. Doc at 217-219 updated to state true coverage.
  4. Regression pins added: `engine/tests/handlers/pre-tool-use/guard-state-file.test.ts` — new `it("stepped brace sequences match bash expansion (round-29 fail-open)")` with 10 assertions.
- **validation:** `bun test engine/tests/handlers/pre-tool-use/guard-state-file.test.ts` (92 pass), `bun test engine/tests/core/guard-state-file-walkers.test.ts` (5 pass).

## Advisory Dispositions (37 listed → 24 unique; duplicates are the machine-summary vs `findings`-block echoes of the same claim)

### Accepted (fix in this remediation)

| # | id(s) | Claim | Fix |
|---|-------|-------|-----|
| A1 | silent-failure-hunter-1/5 | `readJunitDir` silently drops malformed JUnit XML (null parse) with no log | Log per-file `findReport: malformed JUnit report '<p>' (ignored for trust)` in `report-discovery.ts` |
| A2 | silent-failure-hunter-2/6 | explicit `--outputFile` branch silently skips a missing file | Add `else if (!existsSync(path))` log (stale case already logged by `isFresh`) |
| A3 | silent-failure-hunter-3/7 | `--outputFile` parse-null falls through silently | Add `findReport: malformed --outputFile report '<path>'` log |
| A4 | silent-failure-hunter-4/8 | stdout JSON branch silently ignores unparseable summary | Log `findReport: --reporter=json requested but stdout carried no parseable summary` |
| A5 | pr-test-analyzer-1/8 | `statusRunDirectoryObservation` invalid branch (mismatched root / symlink / occupied) untested | Add CLI/unit tests for the `invalid` observation |
| A6 | pr-test-analyzer-2/9 | `inspectRunDirectoryEntry` symlink/non-directory `occupied` branches untested | Add lstat-based unit tests (symlink planted at run-dir path → `occupied`; recovery refused) |
| A7 | pr-test-analyzer-3/10 | `prepareOrphanedWaveGateRecovery` no direct unit tests (distinct-replacement refusal, task-reset isolation) | Add direct unit tests |
| A8 | pr-test-analyzer-4/11 | `recoverOrphanedWaveGateFacade` refusal branches untested (non-pristine replacement, pre-registered under different authority, same run id) | Add tests |
| A9 | pr-test-analyzer-5/12 | wave-gate status branch for runId-mismatched Run Directory observation untested | Add test |
| A10 | pr-test-analyzer-6/13 | `parseOrphanedWaveGateRetirement` negatives + parseTaskGraph installation-audit invariants untested | Add negative parser tests |
| A11 | pr-test-analyzer-7/14 | `literalShellWords` rejection branches (unterminated quote, escaped quotes, line-continuation) untested | Add tests |
| A12 | type-design-analyzer-1/4 | `tests_passed: false` unproducible; `WaveGate.tests_passed` typed `boolean | null`; dead branch `validate-task-execution.ts:79` | Narrow type to `true | null`, reject `false` at load boundary (`waveGateError`), drop dead branch |
| A13 | type-design-analyzer-2/5 | Code change after critical spec-check leaves `blocked: true` (cause cleared); gate message prints "BLOCKED due to:" with no reason; `committedTerminalStatus` withholds terminal status | Clear `blocked: false` in both code-change reset paths (`update-task-status.ts:397` Claude + `:854` pi mirror) exactly when `spec_check` is cleared for the wave |
| A14 | comment-analyzer-2 | Orphaned "Decide between the structured block…" JSDoc above `consumeClaim`; `chooseSource` (line 364) undocumented | Reattach the doc to `chooseSource` |
| A15 | comment-analyzer-3 | Dangling JSDoc `state-manager.ts:82` above `waveGateError` (duplicates `taskUnionError` doc) | Delete the orphan |
| A16 | comment-analyzer-4 | `update-task-status.ts:766-770` labels one region "Section 2/3" then "Section 3" | Merge into one "Section 3" comment |
| A17 | comment-analyzer-5 | `review-panel.ts:911` "two integers, two integers, a set difference" duplicated phrase | Reword: "two integer comparisons, an equality, a floor comparison, and a set difference" |
| A18 | comment-analyzer-6 | `standalone-review.ts:247` cites `orchestration-programs` module that does not exist | Update to `programs/helpers.ts` (`metadata`) |
| A19 | architecture-tech-lead-1 | `core/grandfathered-spawn-model.ts` does fs I/O despite header claiming shell does it; missing from `perFileAllow`; repo's own linter flags `node:fs`/`node:path` | Move `engineIssuedClaudeModelFromRunDir` into `handlers/pre-tool-use/validate-agent-model.ts`; keep `engineIssuedClaudeModel` pure; update test import |

### Deferred (evidence-based reasons)

| # | id(s) | Claim | Reason |
|---|-------|-------|--------|
| D1 | type-design-analyzer-3 | `OrphanedWaveGateRecoveryExpectation` carries raw strings; only the shell facade re-parses | Runtime enforcement is correct (facade re-parses with branded parsers; raw-string comparison only ever errs fail-closed). Branding the registration type touches the protected-state journal schema — a design change for the ADT/branding pass, not a remediation fix. |
| D2 | architecture-tech-lead-2 | `panel-program.ts` twin architecture/refutation reducers (~75% identical) | Real drift hazard, but extraction of a 2685-line parameterized panel kernel is a structural refactor of the adjudication machinery mid-pipeline; both panels are behaviorally correct and heavily tested. Deferred to a dedicated refactor phase with the panel-kernel work. |
| D3 | architecture-tech-lead-3 | `remediation-machine.ts` mixes 26 stringly-typed errors with typed records | Mechanical but broad; zero correctness impact (all sites fail closed). Error-contract unification deferred to the typing pass. |
| D4 | architecture-tech-lead-4 | `pi/extension.ts` 2250-line god module, duplicate listeners | Wiring decomposition would re-order listener semantics with no harness test seam; behavior is currently exercised by e2e hooks tests. Deferred to the harness-adapter refactor. |
| D5 | architecture-tech-lead-5 | Module-global WeakSet/WeakMap proof registries | Deliberate anti-tamper device; replacing with explicit proof tokens spans five core modules and every reducer entry point. Runtime correct; deferred to the proof-token design. |

### Dismissed

None — every advisory carried concrete evidence; none were in-scope noise.

## Refuted Criticals

None (0 refuted). Panel outcomes: `standalone-review:comment-analyzer-1` survived — upheld_by reproduction, intent, blast-radius; no lens refuted. Verifier notes: the stored claim's exemplar was brace-stripped by the `sanitizeProse` pipeline, but all three lenses independently reconstructed the braced form `rm -rf .claude/stat{a..y..4}` and reproduced the fail-open; `state {a..y..4}` → `state` membership confirmed against real bash.

## Change Set (planned)

- `engine/src/core/guard-state-file.ts` — stepped sequences + doc (done)
- `engine/tests/handlers/pre-tool-use/guard-state-file.test.ts` — pins (done)
- `engine/src/machine/report-discovery.ts` — 4 loud-failure logs
- `engine/src/handlers/pre-tool-use/validate-agent-model.ts` — absorb fs read
- `engine/src/core/grandfathered-spawn-model.ts` — pure core only
- `engine/tests/core/grandfathered-spawn-model.test.ts` — import source update
- `engine/src/types.ts` / `engine/src/state-manager.ts` — `tests_passed: true | null` + load rejection + orphan doc removal
- `engine/src/core/validate-task-execution.ts` — drop dead `false` branch
- `engine/src/handlers/subagent-stop/update-task-status.ts` — `blocked: false` reset (2 sites) + section-comment merge
- `engine/src/core/review-output.ts` — reattach JSDoc
- `engine/src/core/review-panel.ts` — phrase fix
- `engine/src/core/standalone-review.ts` — stale module reference
- `engine/tests/…` — new tests for A5-A11, A12, A13

## Validation Commands

```bash
bun test engine/tests/handlers/pre-tool-use/guard-state-file.test.ts
bun test engine/tests/core/guard-state-file-walkers.test.ts
bun test engine/tests/core/validate-task-execution.test.ts
bun test engine/tests/state-manager.test.ts engine/tests/state-manager-load-guards.test.ts
bun test engine/tests/handlers/update-task-status.test.ts
bun test engine/tests/machine/report-discovery.test.ts
bun test engine/tests/core/grandfathered-spawn-model.test.ts
bun test engine/tests/handlers/pre-tool-use/validate-agent-model.test.ts
bun test engine/tests/orchestration.test.ts engine/tests/core/wave-gate-machine.test.ts engine/tests/handlers/helpers/orchestration.test.ts
bun test engine/tests/core/review-output.test.ts engine/tests/core/review-panel.test.ts engine/tests/core/standalone-review.test.ts
bun test engine/tests/pi-imports.test.ts
bun run engine/scripts/lint-boundaries.ts 2>/dev/null || <project lint gate>
bun run typecheck (per repo convention)
full suite: bun test engine/tests/
```

## Phase 4 Remediation Run

Fresh run directory under `.claude/reviews/review-and-fix-runs` (registered `remediation` program); supportPaths: this plan + any regression/fixture paths outside reviewed scope. Source review run stays immutable authority.
