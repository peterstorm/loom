# PR #252 remediation plan — refactor/trim-complexity

- **Branch:** `refactor/trim-complexity` (worktree `loom-trim`), reviewed head `0f04ef45`.
- **Scope:** the whole PR diff against `origin/main`. It is 2,676,140 units, far over the 240,000-unit standalone budget, so it was partitioned into 11 explicit `--files` review runs, `run.pr252-s01` … `run.pr252-s11`, under `.claude/reviews/review-and-fix-runs/`.
- **Review result (engine inspection):** every slice has 0 critical findings emitted, 0 surviving, 0 refuted. There are 135 advisories in total. Per slice: s01 22, s02 11, s03 14, s04 15, s05 10, s06 7, s07 10, s08 13, s09 9, s10 11, s11 13.

## Surviving criticals

None. Every remediation run uses `defectFamily: {"kind":"not-required"}`, so there are no Declared Repair Groups, no selected checks and no Historical RED declarations.

## Refuted-finding audit

None. No reviewer emitted a critical, so the Refutation Panel had nothing to adjudicate.

## Advisory dispositions (DECLARED)

Each slice's complete ordered inventory, with every origin taken from `inspect --lineage`, is published by its own disposition run:

| Source review | Policy run | Disposition digest (prefix) |
| --- | --- | --- |
| run.pr252-s01 | run.pr252-disp-s01 | 5a075b20d21d |
| run.pr252-s02 | run.pr252-disp-s02 | 9742f008daa3 |
| run.pr252-s03 | run.pr252-disp-s03 | 951b846be57b |
| run.pr252-s04 | run.pr252-disp-s04 | e008a80d2366 |
| run.pr252-s05 | run.pr252-disp-s05 | 560e84ff4340 |
| run.pr252-s06 | run.pr252-disp-s06 | 8d5611e9a128 |
| run.pr252-s07 | run.pr252-disp-s07 | 32ddfbdd7f29 |
| run.pr252-s08 | run.pr252-disp-s08 | 4227128f0885 |
| run.pr252-s09 | run.pr252-disp-s09 | bdd81a89810b |
| run.pr252-s10 | run.pr252-disp-s10 | 2b8cd33aef1a |
| run.pr252-s11 | run.pr252-disp-s11 | 82ca56bf821f |

The per-finding decision and reason are in each policy run's `artifacts/disposition.json`. Summary:

- **Deferred (8).** Each one is a seam change or a new harness that belongs in its own PR:
  - s04 `type-design-analyzer-2` and `architecture-tech-lead-2`: TestReport projection and entry points. They follow the s10 verdict fix.
  - s05 `architecture-tech-lead-2`: split state-file-wire.ts.
  - s06 `type-design-analyzer-2`: a capability-guarded updateAndReturn.
  - s06 `architecture-tech-lead-2`: an AST rule for the no-executing-task guess.
  - s09 `type-design-analyzer-1` and `architecture-tech-lead-2`: a populate-equivalent fixture.
  - s11 `architecture-tech-lead-1`: move Pi attempt retirement into core.
- **Dismissed (8).**
  - s01 `architecture-tech-lead-5`: the live and transcript Pi readers have distinct, documented contracts.
  - Seven raw-literal manifest migrations: s06 atl-1, s07 atl-3 and cs-3, s09 atl-1 and cs-3, s10 atl-2 and cs-4. ADR-0098 makes `verification_manifest` a required wire field, and raw State File literals that pin the load contract state it explicitly.
- **Accepted:** all the rest (119).

## Accepted fixes, by work group

1. **Docs (s01).**
   - docs/verification.md: `unresolved_repository_paths` is refused at load, and a result without attempt authority settles nothing.
   - docs/feature-guard-map.md: four smoke suites.
   - ADR-0004, ADR-0037 and ADR-0052 get amendment notes, with matching README rows.
2. **Core seams (s01 and s02).**
   - The affected-check note text gets one source.
   - Write-target keys become a tuple with one presence predicate. The probe and wrap simplifications and the doc comments go with this change.
   - Add a findings `firstRepeated` helper.
   - TaskByteScopeOutcome gets a parser.
   - There is one core `ParseResult`, with a non-empty error. The panel-program journal uses it, and the operations come from an as-const array.
   - There is one red-then-green rule.
   - Narrow `FindingBrief.severity`.
   - Delete `cumulativeModifiedPaths`.
   - Type `ITEM_LAYOUT` (s06).
3. **Shell and security (s03).**
   - Restore the coverage unit cap in mergeCritic and add a refusal test.
   - Add an assignUnits refusal test.
   - The redirect classes become an exhaustive Record.
   - One shared unquoted walker replaces the duplicated afterRedirect bookkeeping.
   - Read the typed redirect kind, and lex each segment once.
   - archived() and asDeferred() go through the schema.
   - Add a branded CommitId.
   - TaskIdentity becomes an Extract, and parseIssuedTaskIdentity is collapsed.
   - Rename `lists`, and derive the stack-signal schema.
   - Test the validate-agent-model malformed marker (s04).
   - Fix the security test comments (s11).
4. **Wave Gate and manifest (s04, s06, s07).**
   - `verification_manifest` is required on the parsed TaskGraph, and the `legacy-unavailable` arm is deleted.
   - Test the lockedWaveGateCompletion refusal arms.
   - The ensure-suite no-manifest case is tested, and the single-valued discriminator goes.
   - Abandonment reason value object.
   - IssuingRun collapses to the run.
   - The task-revalidation ternary.
   - update-task-status refuses authority-unavailable with no attempt, and the settle function is renamed.
   - Pin the refusal reason in wave-completion-readiness.
5. **State File wire (s05 and s11).**
   - Parse-only Task and TaskGraph assembly.
   - readStoredTaskFindings returns a union, evaluated once.
   - Pi transcripts are refused loudly in parseFilesModified.
   - Remove the subagent start and stop wrappers.
   - Test the LEGACY_TASK_FIELDS refusals.
   - Remove the alias and the duplicate pending arm.
   - Merge the duplicate import, and add the abandon test helper.
6. **Test fixtures (s06 to s10).**
   - Remove the duplicate assertions.
   - Brand constructors, an exception-safe armed fixture, and a shared block-text constant.
   - Pin the carriedOver arms and the stdin `complete` route.
   - Fix the lifecycle check-7 wiring test.
   - Typed fixtures: reviewedTarget, runsRootIn, the manifest stamping helper and dead fixture removal.
   - The alias, comment and layout fixes.
   - Port the stop-time regression cases.
   - Shared armed-attempt constants, a registerWaveGate helper and the realpath no-op.
   - Shared identity fixture and stubEnv.
7. **Test report and Pi (s10 and s11).**
   - The TestRun summary is minted under the executed-count rule, so an all-skipped report is no longer a trusted pass. The `it.fails` pins flip to `it`.
   - Shared report test helpers.
   - A message-level Pi evidence entry point.
   - A Pi test for new-test collection failure.
   - An authority-less completion now raises a processing error.
   - Pi authority tests.
   - The retire helpers take only the authority, with narrowed exact args.
   - piIssuingRunBinding returns the opened run.
   - The malformed observation drops its log.

## Disposition correction

`run.pr252-disp-s01-r2` publishes a correction of `run.pr252-disp-s01`, with revision `correction` and previous digest `5a075b20…`. The new disposition digest is `1f2e32b00e1f0439934ffc1e01eaa1d466f71417a61e2f14b87221963f3a6fa9`.

s01 `code-simplifier-5` (inline `slotsOf`) changes from accepted to **dismissed**. Inlining it breaks `stopCheckBlockDecision`'s inference: `C` collapses to `StopCheckPayloads` and fails with TS2322. The finding itself allowed keeping the alias. All 21 other entries are unchanged.

## Accepted fixes implemented in a different shape

Each of these addresses the finding's claim with a different shape than the one-line plan. The decision stays accepted.

- **s04 `type-design-analyzer-3`, `architecture-tech-lead-1`, `code-simplifier-3`.**
  - The plan was to make `verification_manifest` required on `TaskGraph`. That would be wrong: every phase before execute legitimately has no manifest (ADR-0098).
  - Instead, a parsed `ManifestedTaskGraph` (`core/manifested-task-graph.ts`) is proven once at each Wave Gate, readiness and status seam. The `legacy-unavailable` readiness arm, its gate-fail arm, the status early return, and the manifest-undefined guards are deleted.
  - Status JSON before execute now reports `unavailable` with `MANIFEST_ABSENT_REFUSAL`.
- **s04 `pr-test-analyzer-1`.** The suite helper's no-manifest branch can no longer be represented, so it is deleted, and the refusal is tested at the seam.
- **s04 `silent-failure-hunter-1`.** `authority-unavailable` with nothing executing is an error for a malformed, unreadable or invalid-identity sidecar. A *missing* sidecar stays a named passthrough, because dispatch sends `missing-sidecar` for every ordinary non-implementation stop.
- **s02 `architecture-tech-lead-1` and `code-simplifier-2`.** One named rule, `redThenGreenRule(era, policy)`, is shared by derivation and owing, with an equality property. `ProofObligationInput` is unchanged, because it is parsed wire input.
- **s03 `architecture-tech-lead-3`.** `from` has left `redirectsOf`'s public signature, and the reconciliation now lives in `shell-redirects`. The restart at the normalizer's word end is kept, because a single reading would lose real evidence targets (`$'a\'b' > out`). A test covers this.
- **s03 `type-design-analyzer-5`.** There is one spelling, derived the other way: bound arm = `{kind:"bound"} & TaskIdentity`. `Extract` would have added `kind` to the exported identity.
- **s04 `architecture-tech-lead-3`.** `IssuingRun` is deleted, and `resolveIssuingRun` returns the run. Pi still needs the session binding, so `resolveIssuingSessionBinding` is exported beside it.
- **s05 `pr-test-analyzer-1`.** The existing `it.each` already covered every legacy field. It is strengthened so the same graph loads once the field is removed.
- **s06 `type-design-analyzer-1`.** `RunLayout` lost its phantom tag in this PR, so `ITEM_LAYOUT` is typed `RunLayout` and its unchecked `panel` field is dropped.
- **s10 `silent-failure-hunter-2`.** On Pi the failure surfaces as `Pi new-test observation unavailable: diff-since: …`; the CLI-only message never reaches it. The test asserts the Pi message, the release and the infrastructure-blocked history.
- **s10 `silent-failure-hunter-1`.** An all-skipped report is now `trusted-fail` ("nothing ran") through `executedTestCount`. The stored `total` keeps its meaning for INV-8 reconciliation. This is recorded in ADR-0100.

## Behaviour changes surfaced by the fixes

- A stored Task or TaskGraph key outside the parsed field table is refused at load (s05). As a result:
  - a refused `store-test-evidence` call no longer rewrites the State File;
  - `legacyTestsPassedNote` is deleted.
- A summary-only JUnit report counts executed tests as its total (s10).
- A completed Pi implementation result without attempt authority is a processing error (s11).

## Integration

The seven group branches, `fix/pr252-g1` to `fix/pr252-g7`, were merged in `fix/pr252-int`. The merge conflicts and how each was resolved:

- **Guard-map derived counts:** restamped from the tree.
- **`update-task-status.test.ts`:** g4's Pi-session test is kept alongside g3's idle-session helper.
- **`state-manager.test.ts`:** g4's `abandon` helper now parses through g3's `waveGateAbandonmentFixture`.
- **`check-lifecycle-artifacts.test.ts`:** g5's wiring test is narrowed with `manifestedGraphFixture`.
- **`engine-internals.md`:** both sentences are kept.
- **g4's Pi refusal:** it called the old settle name, renamed to `settleTranscriptUnavailable`.

## Implementation and validation

Each group is implemented in its own worktree on `refactor/trim-complexity`. The changes are then folded into `loom-trim` uncommitted, and the whole tree is validated with:

- `cd engine && bun run typecheck`
- `bun run lint`
- `bunx vitest run`, the full engine suite
- the guard-map facts restamp

## Registered remediation

There is one remediation run per source slice, `run.pr252-fix-sNN`, each with `defectFamily: {"kind":"not-required"}`.

- Each run's dirty set is that slice's in-scope files plus `supportPaths`: this plan and any path the fixes for that slice touch outside the slice's frozen scope.
- Runs execute in slice order. After each one, the installed index is committed.
- A slice with no remaining dirty path is reported as such and gets no remediation run.

### Partition of the integrated diff

The integrated diff is `0f04ef45..fix/pr252-int`: 168 paths, plus this plan.

- A changed path belongs to the slice whose frozen `--files` scope holds it.
- A path in no scope is a `supportPath` of the slice whose advisory drove it:
  - new or deleted files, by the finding that created or removed them;
  - otherwise, the first slice its implementer group carried.

Each slice's subset is applied to the tree before its run. The engine then audits, stages and installs exactly that subset. Because the fixes cross slices (for example the `LineParseResult` rename, or `ManifestedTaskGraph` at its call sites), an intermediate slice commit need not compile on its own. Only the final tip equals the validated integration tree, and that tip is what was typechecked, linted and fully tested.

### Validation of the integrated tree (`fix/pr252-int`, `engine/`)

- `bun run typecheck`: clean.
- `bun run lint`: 2009 files, no violations.
- `env -u PI_CODING_AGENT bunx vitest run`: 834 files, 21466 tests passed, 2 skipped.
- `env -u PI_CODING_AGENT npm run test:smoke`: 23/23 passed.
- `tests/docs`, including the derived-count facts test: green after the restamp.
