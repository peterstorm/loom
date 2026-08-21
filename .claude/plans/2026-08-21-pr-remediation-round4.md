# PR Remediation Plan — 2026-08-21 (Round 4)

**Branch:** `feat/architecture-panel-mode-plan`
**Review Run:** `run.u9EaUy9AHf`
**Run Directory:** `.claude/reviews/review-and-fix-runs/run.u9EaUy9AHf`
**Canonical result:** `result.json` (digest `e32cb6ace468e7ce111d87357faa12652eae1b70c8f7492a6290f2148d0a52f2`)

## Scope

The exact frozen scope of `run.u9EaUy9AHf` (500 files, digests in the run's
`contexts/` packets). Remediation touches only in-scope paths plus the support
paths registered at remediation start (this plan file).

## Review-run provenance note

All seven attempt-1 reviewer slots were terminally capture-rejected: the
attempt-1 spawn (10:56) ran ~3h on the local `desktop-vllm/qwen3.8-27b` model
and was aborted mid-flight (turn interrupt at 13:59:48). The fail-closed capture
layer persisted seven `request-capture-rejected` events (seq 0–6). `resume` then
advanced every slot to the registered attempt-2 retry; the attempt-2 batch
(7/7) was captured cleanly and the run published its canonical `result.json`.

## Surviving Critical Findings (mandatory)

None. `surviving_critical_findings` is empty; no refutation panel was routed
(`panel: null`), `refuted_critical_findings` is empty.

## Advisory Dispositions (12 total — 9 accepted, 3 deferred, 0 dismissed)

### ACCEPTED

**A1 — `code-reviewer-1` — `engine/src/core/test-evidence.ts:45` (maven pass-then-fail misclassified as passed)**
Verified: the maven branch returns `passed: true` whenever a `BUILD SUCCESS`
string co-occurs with the LAST zero-failure `Tests run:` tally, with no veto for
a LATER non-zero failure tally or a later `BUILD FAILURE` — unlike the runner
loop directly below, whose same-line-or-later non-zero-failure veto is the
established rule. Reproduction: run 1 `Tests run: 5, Failures: 0, Errors: 0` +
`BUILD SUCCESS`, run 2 `Tests run: 5, Failures: 1, Errors: 0` + `BUILD FAILURE`
→ currently `passed: true`.
**Fix:** mirror the runner-loop veto in the maven branch — a non-zero
`Failures:`/`Errors:` tally or a `BUILD FAILURE` on the same line or a later
line than the accepted zero-failure tally vetoes the pass (fall through to the
runner loop, then `passed: false`). Keep the existing "first fails, last passes"
pin green (later zero-failure tally wins).
**Regression pin:** new test "vetoes maven pass when a later run fails"
(fail-then-pass stays green, pass-then-fail red).

**A2 — `silent-failure-hunter-1` — `engine/src/orchestration/run-directory-handle.ts:1409` (errno cause dropped from refusal)**
Verified: `occupiedArtifactBytes` (line 1385) collects the errno message into
the `__unreadable` sentinel precisely so "an unreadable slot can never be
mistaken for a free slot", but `occupiedArtifactConflict` composes its refusal
as `artifact slot is occupied by unreadable bytes: <path>` and drops the
collected cause — EACCES, ELOOP, and EISDIR are indistinguishable. No test pins
the current string. The refusal still fails closed; only the operator-facing
cause is lost.
**Fix:** include the collected cause in the refusal:
`artifact slot is occupied by unreadable bytes: <path> (<cause>)`. Add a pin.

**A3 — `pr-test-analyzer-1` — `artifacts/tests/test-validate-task-graph.sh` (orphaned shell test, never executed)**
Verified: referenced by no runner, package script, smoke script, or hook; its
header documents one prior stale-CLI-path rot; it passes 21/21 when run
manually today; the vitest suite (`engine/tests/handlers/validate-task-graph.test.ts`,
978 lines) is pure-function only (no subprocess spawns), so this script is the
only end-to-end `bun engine/src/cli.ts helper validate-task-graph` coverage.
**Fix (wire, not delete — it carries unique integration coverage):** add
`bash ../artifacts/tests/test-validate-task-graph.sh` to the `test:smoke` chain
in `engine/package.json`, and correct the script's stale `Run:` header hint
(`.claude/tests/...` → `artifacts/tests/...`).

**A4 — `pr-test-analyzer-2` — `engine/src/core/git-sha.ts:2` (SHA-256 branch of the git-sha grammar untested)**
Verified: `EXACT_GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/`; existing pins
cover 40-char acceptance and 39-char/uppercase/`HEAD~1` rejection only; the
state-manager load-guard error message promises "a lowercase 40- or
64-character Git SHA". A SHA-1-only regex would pass the whole suite.
**Fix:** one-line pins: accept `"a".repeat(64)`; reject `"a".repeat(63)` and
`"a".repeat(65)` through the same grammar path the load guard uses.

**A5 — `type-design-analyzer-2` — `engine/src/types.ts:835` / `parse-plan-models.ts:188` (`parseTier` collapses missing and unrecognized)**
Verified: `parseTier(raw: string | null): InvariantTier | null` returns `null`
both when the `**Tier:**` line is absent and when its value is unrecognized;
`validate-model-bindings.ts:156` re-derives the distinction downstream and the
author's typo text is lost from the error.
**Fix:** three-state parse result
(`{ status: "absent" } | { status: "ok"; tier } | { status: "unrecognized"; raw }`)
carried on the parsed invariant; the validator reports an explicit
unrecognized-tier error quoting the raw value while the absent-tier error stays
distinct. No behavior change for valid plans.

**A6 — `type-design-analyzer-3` — `engine/src/core/shell-command.ts:90` (`hasUnbalancedQuotes` parity over-flags escaped quotes)**
Verified: raw per-character odd/even count ignores backslash escapes —
`echo "a\"b"` (3 raw `"`) and `echo "a'b"` (1 raw `'`) are well-formed yet
flagged, so the sole caller (`extract-evidence.ts:100`) refuses to classify
them and evidence is lost. The error direction is fail-closed (no safety hole),
but the stated contract ("quote-balance verdict") overstates what the body
guarantees, and one existing test pin (`shell-command.test.ts:193`) encodes the
over-flag as intended behavior.
**Fix:** derive the verdict from the shared quote-state scan (the same state
machine `splitCommandSegmentsWithOps` and `scanUnquoted` already implement):
a segment is unbalanced iff the scan ends inside an open quote. Soundness:
state-machine-unbalanced ⇒ some quote char has odd count ⇒ parity-unbalanced,
so the new check accepts a strict superset of previously-classified segments
and never re-accepts a command the splitter reads ambiguously. Expose the final
quote state from `shell-quoting.ts` without duplicating the loop; update the
`:193` pin to the corrected semantics and add escaped-quote pins.

**A7 — `comment-analyzer-1` — `engine/src/core/review-output.ts:124` (stale `/wave-gate Step 4b` references)**
Verified: 3 source comments (lines 124, 193, 354) plus 4 test comments
(`tally-gate-composition.test.ts:188`, `review-agent-contract.test.ts:40`,
`review-output-round14.test.ts:175`, `review-output.test.ts:626`) cite a
numbered "Step 4b" that no longer exists — `commands/wave-gate.md` v3.0.0 has
no numbered steps; advisory triage now lives in the engine's `await-user`
advisory-disposition action.
**Fix:** reword all 7 sites to name the current mechanism; keep each comment's
rationale (lost advisories must fail closed).

**A8 — `code-simplifier-1` — tripled optional-field `canonicalRecord` error factory**
Verified: three structurally identical factories — `publication.ts:928`
(kind `publication-authority-unavailable`), `publication.ts:1132` (kind
`invalid-accepted-agent-result`), private `remediation-machine.ts:350` (kind
`standalone-result-publication-authority-unavailable`, re-implementing the shape
of a module it already imports).
**Fix:** one kind-parameterized helper in
`orchestration-contract/errors.ts` (`optionalFieldError(kind, message, field?)`
returning the shared `Readonly<{ kind; field?; message }>` shape, preserving
the omit-key-not-undefined encoding rule); each named factory becomes a
one-line delegation; the private copy in `remediation-machine.ts` is deleted.
No produced error value changes.

**A9 — `code-simplifier-2` — `engine/src/core/review-output.ts:794` (doc comment stranded on the wrong function)**
Verified: the comment at lines 794–806 explains `blockStatusNote` (line 817) —
including the `carriedOver` duplicate-over-loss trade-off — but sits above
`criticalTally`'s own doc comment, leaving `blockStatusNote` undocumented.
**Fix:** move the comment block directly above `function blockStatusNote`.
Behavior-neutral.

### DEFERRED

**A10 — `type-design-analyzer-1` — `engine/src/types.ts:383` (Task findings-triple lockstep is a doc-comment invariant)**
Reason: genuine invariant-in-comment debt on the widest bag-of-optionals in the
scope, but a complete fix is a discriminated-union redesign of a persisted
state-file schema with six coordinated writers plus a load-boundary migration —
a deepening project that is not a practical in-scope fix this round. The
invariant is currently enforced fail-closed at the load boundary
(`findingsLockstepError`), so no invariant is unenforced in the meantime.
Revisit in an architecture deepening session (pairs naturally with A11/A12).

**A11 — `architecture-tech-lead-1` — `engine/src/state-manager.ts:94` (~1100 lines of pure TaskGraph invariants in the shell I/O module)**
Reason: verified real FC/IS locality debt (1514-line module; boundary ledger
denies `core/ → state-manager`), but the extraction is a ~1100-line module move
plus boundary-ledger changes plus a test-suite migration — a deepening project,
not a remediation fix. Load-boundary checks enforce the invariants today.

**A12 — `architecture-tech-lead-2` — `engine/src/config.ts:650` (I/O at module load time)**
Reason: verified — `export const TASK_GRAPH_PATH = findTaskGraphPath()` runs fs
probes plus a git subprocess at import, and six core modules import `config`
for its pure catalog projections. The const/function dual is a documented
deliberate design; splitting the 49-export module into a pure leaf plus a
shell config module is a deepening project, not a practical in-scope fix this
round. Load-time resolution is fail-closed and tested.

### DISMISSED

None.

## Refuted-findings audit

None — the critical set was empty, so the Refutation Panel was never routed
(`panel: null` in `result.json`), and `refuted_critical_findings` is empty.

## Changed files (as applied)

- A1 — `engine/src/core/test-evidence.ts` (maven veto), `engine/tests/handlers/update-task-status.test.ts` (3 pins: pass-then-fail, later-errors-veto, cross-line exemption)
- A2 — `engine/src/orchestration/run-directory-handle.ts` (errno cause in refusal), `engine/tests/orchestration/publication-faults.test.ts` (self-symlink ELOOP pin)
- A3 — `engine/package.json` (wired into `test:smoke`), `artifacts/tests/test-validate-task-graph.sh` (stale `Run:` header corrected)
- A4 — `engine/tests/core/git-sha.test.ts` (NEW: 64-char accept, 63/65-char reject, non-hex/uppercase/non-string pins, length property)
- A5 — `engine/src/types.ts` (`PlanInvariantTier` three-state union), `engine/src/parsers/parse-plan-models.ts` (three-state `parseTier`, re-export), `engine/src/parsers/index.ts` (re-export), `engine/src/handlers/helpers/validate-model-bindings.ts` (exhaustive `match`, split missing/unrecognized errors), `engine/tests/parsers/parse-plan-models.test.ts`, `engine/tests/parsers/parse-plan-models.property.test.ts`, `engine/tests/handlers/validate-model-bindings.test.ts`
- A6 — `engine/src/core/shell-quoting.ts` (shared `walkQuotedText` + exported `openQuoteAfter`), `engine/src/core/shell-command.ts` (state-based `hasUnbalancedQuotes`), `engine/tests/core/shell-command.test.ts` (over-flag pin corrected, even-count-open pin added)
- A7/A9 — `engine/src/core/review-output.ts` (3 stale references reworded; stranded doc comment moved above `blockStatusNote`), plus the 4 test-comment sites: `engine/tests/handlers/tally-gate-composition.test.ts`, `engine/tests/review-agent-contract.test.ts`, `engine/tests/core/review-output-round14.test.ts`, `engine/tests/core/review-output.test.ts`
- A8 — `engine/src/core/orchestration-contract/errors.ts` (`fieldFailureError` helper), `engine/src/core/orchestration-contract/index.ts` (deliberate curated export), `engine/src/core/orchestration-contract/publication.ts` (two one-line delegations), `engine/src/core/remediation-machine.ts` (private copy deleted, delegates)

Support paths (outside the frozen review scope, registered at remediation start):

- `.claude/plans/2026-08-21-pr-remediation-round4.md` (this plan)
- `engine/tests/core/git-sha.test.ts` (new regression pin for A4)

## Validation commands

```bash
cd engine && bunx tsc --noEmit
cd engine && bunx vitest run            # full unit suite
cd engine && env -u PI_CODING_AGENT npm run test:smoke   # includes the wired shell test
bash artifacts/tests/test-validate-task-graph.sh         # also run directly
```

Stop without staging or committing if any of these cannot pass.

## Status (2026-08-21, post-implementation)

All 9 accepted advisories implemented; 3 deferred (A10/A11/A12) unchanged.

### Validation evidence

- `bunx tsc --noEmit` — clean. `npm run typecheck` (adds `noUnusedLocals`/`noUnusedParameters` over `src|tests`) — clean.
- Full unit suite (`vitest run --testTimeout=15000`, run with `PI_CODING_AGENT` unset per the project's own `test` script): **4938 passed, 1 skipped, 3 failed** — all 3 failures are the Pi runtime version-skew guard in `tests/handlers/helpers/orchestration.test.ts` (session-binding tests spawn the CLI inheriting THIS session's `LOOM_PI_EXTENSION_RUNTIME_*` env vars, whose revision predates this branch's edits). They pass 93/93 in the same file when those two env vars are unset, and are unrelated to this diff (untouched code). In a session with a freshly-loaded runtime (post `/reload`) the revisions match and they pass.
- `test:smoke` full chain — green: panel-mode 22/22, review-panel 19/19, smoke-standalone-review PASS, smoke-orchestration-facades PASS, smoke-pi-resources PASS, test-validate-task-graph 21/21 (the newly wired script).
- Covering suites per change: update-task-status 54/54, git-sha 6/6, shell-command/normalize/guard-walkers/extract-evidence 136/136, parse-plan-models + validate-model-bindings 88/88, orchestration kernel (acyclic, property, public-surface, remediation-machine, remediation-lifecycle, machine-purity) 219/219.

### Distill pass (apply mode, post-implementation)

Moves applied: reuse-before-rewrite (A1 reuses the module's `lastMatch` idiom on the already-stripped string; A6 exposes the final quote state from the shared `walkQuotedText` instead of a fourth hand-rolled loop; A8's single `fieldFailureError`); constraint-carrying comments fixed, not added (A7/A9). No behavior or interface changed beyond the planned A5/A6 type changes.

Opportunities skipped: A10/A11/A12 (deepen territory — deferred above with reasons); the A8 public wrappers (`publicationResolutionFailure`, `authorityResolutionFailure`) stay as one-line delegations — they are established public surfaces, so call sites and signatures are untouched; the `validate-model-bindings.test.ts` fixture wrapping is left explicit rather than hidden behind a test helper (each assertion reads its exact three-state shape).
