# PR Remediation — run.raf20260818b

**Branch:** `feat/architecture-panel-mode-plan`
**Base:** `main` · **HEAD at review:** `8faa352`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.raf20260818b`
**Canonical result:** `run.raf20260818b/result.json` (digest `f844ea82…`, 41359 bytes)
**Scope:** frozen 448-file scope, `kind: all`, `files: null`

## 1. Adjudication summary

| Bucket | Count |
|---|---|
| Reviewers spawned | 7 (2 required a second admission attempt) |
| Criticals found | 2 |
| Refutation panel lenses | 3 (`reproduction`, `intent`, `security`), threshold 2 |
| **Surviving criticals** | **2** |
| **Refuted criticals** | **0** |
| Advisories | 23 |
| Advisories accepted | 22 |
| Advisories deferred | 1 |
| Advisories dismissed | 0 |

### Refuted-finding audit

**None.** The panel refuted nothing this round. Both criticals were upheld
unanimously (3/3 lenses each), so there is no refuted-finding evidence to
retain and nothing was excluded from remediation on panel grounds.

## 2. Surviving criticals — mandatory fixes

### C1 — `pi/extension.ts:1474` — unguarded `manager.update` aborts the whole batch

*Agent:* `silent-failure-hunter` · *Upheld by:* reproduction, intent, security

The `await manager.update(...)` that records missing reserved review/spec-check
evidence sits unguarded in the `else` branch of the `tool_result` subagent
handler. The structurally identical call at `:1338`
(`finalizeReservedImplementations`) *is* wrapped in try/catch and converts a
throw into a `processingErrors` entry plus a `loom(pi):` stderr diagnostic. The
enclosing `pi.on("tool_result", …)` handler has no top-level try/catch either,
so a `StateManager` load/write failure here propagates out and skips the
per-result evidence loop at `:1543` — the loop whose own comment says a throw
"must not abort … that leaves tasks stuck executing with zero diagnostics".

**Fix:** wrap the `:1474` update in the same try/catch shape used at `:1338` —
push a diagnostic onto `processingErrors`, write the `loom(pi):` stderr line,
and let the handler continue to the per-result loop.

### C2 — `no-cross-boundary-imports.ts:187` — allowlist comment cites a non-existent export

*Agent:* `comment-analyzer` · *Upheld by:* reproduction, intent, security

The comment justifying the `engine/src/machine/evidence` entry in the
`engine/src/orchestration/` allowlist claims it is needed for `SessionId`,
`RequestId`, and the run-directory suffix vocabulary. `machine/evidence.ts`
exports no `RequestId`; the sole consumer, `orchestration/session-run-bindings.ts`,
imports `ORCHESTRATION_RUNS_SUFFIX`, `parseSessionId`, and `SessionId` from it,
and gets `RequestId` from `../core/orchestration-contract` — a separately
allowed path. The comment documents a fail-closed boundary control, so the
misattribution misleads about what the allowlist entry actually grants.

**Fix:** correct the comment to name only what `machine/evidence` actually
supplies to this boundary (`SessionId`/`parseSessionId` and
`ORCHESTRATION_RUNS_SUFFIX`), and note that `RequestId` arrives via the
separately allowed `core/orchestration-contract` entry.

## 3. Advisory dispositions

### Accepted (22)

| ID | Site | Fix |
|---|---|---|
| A1 `silent-failure-hunter-2` | `core/panel-program.ts:2442,2457` | `catch {` → `catch (error) {`, interpolate the message into `panelError`, matching the documented sibling fix at `:2208`/`:2252`. |
| A2 `pr-test-analyzer-1` | `pre-tool-use/block-direct-edits.ts:34` | Add a direct test for `activeRosterProbe`'s catch branch (non-ENOENT `statSync` failure → `null` + stderr). |
| A3 `pr-test-analyzer-2` | `linter/programmatic/exhaustive-discriminant-branching.ts:82` | Add tests exercising `branchBody`'s paren-depth/quote-skipping scan (`)` inside a string literal, nested call in the condition). |
| A4 `type-design-analyzer-1` | `orchestration-contract/actions.ts:210` | Retype `exactDiagnosticConstants` to `DomainResult<void, …>` — it is a gate, and no caller reads its record. |
| A5 `type-design-analyzer-2` | `machine/ledger.ts:169` | `readBindings` returns `readonly MachineBinding[]`, matching its own port declaration at `evidence.ts:433`. |
| A6 `type-design-analyzer-3` | `core/standalone-review-machine.ts:1044` | Replace the ad-hoc intersection cast with `in`-narrowing over the real union so the compiler keeps checking the field types. |
| A8 `architecture-tech-lead-1` | `handlers/helpers/complete-wave-gate.ts:65` | Delete the dead re-exports (zero production callers) and repoint the pinning tests at `core/wave-gate-machine`. Deleting the second import path removes the divergence the parity tests guard against. |
| A9 `architecture-tech-lead-2` | `pi/extension.ts:1318` | Extract the *pure* classification (`returnedAgentAt` + the three `missing*` derivations) into a pure module with unit tests; the shell keeps only I/O. Scoped to the pure slice — `finalizeReservedImplementations` genuinely needs the state manager. |
| A10 `architecture-tech-lead-3` | `subagent-stop/update-task-status.ts:367,834` | Extract one pure wave-gate reset/resolution function called by both the Claude-side and pi-mirror paths. |
| A11 `architecture-tech-lead-4` | `CONTEXT.md:207` | Add a Guarded Skill Machine entry / Flagged Ambiguities line disambiguating it from the Lifecycle Machine. |
| A12 `code-simplifier-1` | `helpers/mark-tests-passed.ts:62` | Derive `missing`/`missingNew` from the already-computed `withTests`/`newTestOk` arrays. |
| A13 `code-simplifier-2` | `linter/programmatic/config.ts:70` | Two helpers (`parseOptionalStringArray`, `parseOptionalPositiveInt`) replace five near-identical blocks. |
| A14 `code-simplifier-3` | `helpers/orchestration.ts:148` + 3 copies | One shared `argumentValue`/`hasFlag` module. **Deliberate tightening:** the shared form takes the union of the existing guards (reject missing, empty, and `--`-prefixed values), so `model-profiles`'s empty-string acceptance and `panel-run`'s missing `--`-guard both go away. Pinned by a new test. |
| A15 `code-simplifier-4` | `pi/write-grant.ts:172` | Make the `seen` Set actually deduplicate `scopeDirs` (both branches currently return `normalized`). |
| A16 `code-simplifier-5` | `orchestration-contract/publication.ts:566,675,920` | Extract the shared ok/value/error envelope check; each caller keeps its own failure constructor, field prefix, expected kind, and value parser. Exact messages preserved. |
| A17 `code-simplifier-6` | `helpers/populate-task-graph.ts:19` + 2 | Export one `ModelBindingDeps` production adapter from `validate-model-bindings.ts`; delete the three byte-identical copies. |
| A18 `code-simplifier-7` | `core/findings.ts:1194,1221` | Share the per-expected-agent "attribute genuinely-new findings" loop between `preserveAcceptedReviewRunFindings` and `finalizeReviewRun`. |
| A19 `code-simplifier-8` | `state-manager.ts:544` | Parameterize `taskBaselineError`'s duplicated baseline/file_list comparison on exact-vs-prefix length. |
| A20 `code-simplifier-9` | `machine/evidence.ts:64,98` | One binding-safety predicate behind `parseAgentId`/`parseAgentType`. |
| A21 `code-simplifier-10` | `helpers/model-profiles.ts:31` | One shared YAML-frontmatter field parser used by `frontmatter()` and `modelFrontmatter()`. (`engine/src/handlers/` has no boundary rule, so the import is allowed.) |
| A22 `code-simplifier-11` | `pi/transcript-adapter.ts:240,309` | Share the toolCall/toolResult pairing walk; each caller keeps only its own accumulation. |
| A23 `code-simplifier-12` | `engine/tests/handlers/helpers/set-phase.test.ts:8` | Replace the `Date.now()+Math.random()` temp-dir dance with `mkdtempSync`, as `mark-tests-passed.test.ts` already does. |

### Deferred (1)

**A7 `type-design-analyzer-4` — `engine/src/types.ts:348`** — encode the
`review_status` / `review_evidence_failures` biconditional in the type.

*Reason (evidence-based, not effort):* the suggested fix follows `SpecCheck`'s
`CapturedSpecCheck | EvidenceFailedSpecCheck` pattern, but `SpecCheck` is
already a standalone union type. `Task` is a flat `interface` (`types.ts:290`)
with ~50 fields; `field?: never` cross-field constraints only discriminate
across a *union*, so this fix requires converting `Task` itself into a
discriminated union. That changes the type of every `{ ...t, … }` task-
constructing spread across the engine, the handlers, and pi — a standalone type
redesign, not a remediation of this review's scope, and one that would need its
own review round. Meanwhile the invariant is not unguarded: it is proven at the
single load boundary (`evidenceFailureError`) through which every persisted task
passes, and `--fix` repairs a violation by clearing the review record (failing
closed). Deferring leaves a documented type-expressiveness gap, not a
correctness hole.

### Dismissed (0)

None.

## 4. One fix outside the finding set

`engine/src/linter/index.ts` + `engine/tests/linter/index.test.ts` — `lintFile`
now takes an optional `timeoutMs` (default unchanged: `DEFAULT_TIMEOUT_MS`, 50).

Not a review finding. It was forced by the validation gate: the
`"handles very large file"` case asserts a rule finds a violation in a
10,000-line fixture, but `lintFile` hard-coded the 50ms *hook* budget with no
way to override it, so the assertion also measured wall-clock time on a loaded
host. Reproduced **3/5 runs on a pristine `8faa352` checkout** with none of this
round's changes applied — pre-existing, not a regression, but it made "the suite
is green" unrepeatable, and the mandate here is that validation must pass.

The test's own comment (`// Use a generous timeout for large file`) shows the
author intended to pass a budget the API never accepted; the parameter is the
missing half of that intent. Production behavior is unchanged — every existing
caller gets the same 50ms. Now 5/5 green.

## 5. Validation — actual results

| Command | Result |
|---|---|
| `npm run typecheck` (incl. `--noUnusedLocals/--noUnusedParameters`) | clean |
| `npm run test:unit` | **182 files / 4689 tests passed**, 0 failed (was 180 / 4647) |
| `npm run test:smoke` | all passed (review-panel 19/19, standalone-review, orchestration façades 6/6, panel-mode, pi-resources) |
| `bun scripts/lint-project.ts` | **116** violations / 43 files, vs **117** / 44 on pristine `8faa352` |

Linter set diffed against the clean-tree baseline: **zero new violations**; the
A13 refactor cleared one (`config.ts [max-function-lines]`).

The two quote-skipping tests added for A3 were mutation-checked — removing the
quote-skipping branch from `branchBody` fails exactly those two and nothing
else, so they discriminate rather than merely pass. The rule source was
restored byte-identical afterwards (`git diff` empty).

## 6. Support paths

Registered in the remediation start input because they are outside the frozen
448-file reviewed scope:

- `.claude/plans/2026-08-18-pr-remediation-round2.md` (this plan)
- `engine/src/handlers/helpers/cli-args.ts` (A14)
- `engine/src/utils/frontmatter.ts` (A21)
- `pi/reserved-results.ts` (A9)
- `engine/tests/handlers/helpers/cli-args.test.ts` (A14)
- `engine/tests/pi-reserved-results.test.ts` (A9)
- `engine/src/linter/index.ts`, `engine/tests/linter/index.test.ts` (§4)
