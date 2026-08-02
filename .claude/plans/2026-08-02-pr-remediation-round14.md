# PR Remediation Plan — Round 14

**Date:** 2026-08-02
**Branch:** feat/architecture-panel-mode-plan
**Scope:** `git diff main...HEAD` — 80 files, +15155/-782
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent
**Findings:** 5 critical, 37 advisory (after dedup across six agents)

---

## Critical Fixes

### C1: `mergeFindings` silently demotes `evidence_capture_failed` to `passed`
- **Source:** silent-failure-hunter
- **File:** `engine/src/core/findings.ts:643,671`
- **Issue:** The concurrency rule ("a reviewer finishing second must not erase the
  first one's block") is implemented only for `blocked`. A task at
  `evidence_capture_failed` is demoted to `passed` by any later reviewer emitting
  `CRITICAL_COUNT: 0`, and the new `review_error: undefined` line erases the last
  trace. `/wave-gate` spawns all reviewers in one message, so the gate outcome for
  identical transcripts is nondeterministic, and `checkReviews` advances the wave.
- **Fix:** The failure is per-AGENT but the status is per-TASK — that mismatch is
  the actual defect. Add `Task.review_evidence_failures?: readonly string[]`
  (the agents whose transcript could not be parsed).
  `applyReviewResolution` adds the agent; `mergeFindings` removes it and only
  leaves `evidence_capture_failed` once the set is empty. Status is derived from
  the MERGED finding set, not the incoming one, so clearing the last evidence
  failure cannot demote a task another reviewer blocked.
  Make it structural: the load boundary enforces
  `review_status === "evidence_capture_failed"` ⟺ non-empty
  `review_evidence_failures`, and `--fix` repairs a violation by clearing the
  review record (unreviewed also blocks the gate — fail closed).

### C2: Load boundary never proves `critical_findings` / `advisory_findings` are string arrays
- **Source:** pr-test-analyzer
- **File:** `engine/src/state-manager.ts:113`, `engine/src/core/findings.ts:493`
- **Issue:** `taskUnionError` proves `findings` and `refuted_findings` but not the
  two derived views, which `types.ts` declares `readonly string[]`. Worse,
  `findingsLockstepError` filters non-strings out BEFORE the multiset comparison,
  so a malformed view reports as in lockstep. `checkCriticalFindings` then throws
  `f.trim is not a function` out of the wave-gate helper — the exact failure the
  load boundary exists to prevent.
- **Fix:** Add `findingsViewError` to `core/findings.ts`; call it from
  `findingsLockstepError` before comparing (so both entry points are covered by
  one rule) and drop the masking filter.

### C3: `updateTaskFindings` rewinds finding ids
- **Source:** type-design-analyzer
- **File:** `engine/src/handlers/helpers/store-review-findings.ts:93`
- **Issue:** `nextOrdinal` is seeded from `keptAdvisory` (the surviving subset)
  rather than the full pre-override set. A second override re-mints a
  `manual-override-N` id an in-flight refutation brief still names;
  `applyFindingOutcomes` then deletes a different live critical, promotes
  `blocked → passed`, and files the panel's reasoning against the wrong claim.
  `mergeFindings` gets this right; `nextOrdinal`'s own doc names the rule.
- **Fix:** Seed from `existing`.

### C4: Tie-break beyond the first criterion, and the criteria order itself, are unpinned
- **Source:** pr-test-analyzer
- **File:** `engine/src/core/panel-contract.ts:418`, `engine/src/handlers/helpers/panel-contract.ts:148`
- **Issue:** `compareRankings` is documented as "works for any K" and asserted at
  K=1: the mutant `index < Math.min(1, a.scores.length)` survives all 2057 tests.
  Reversing the handler's criteria array also survives, and changes which
  architecture ships on a total tie — at exit 0, with an identical artifact.
- **Fix:** Property test over ≥3 criteria plus a handler-level total-tie test
  pinning the winner against the derived criteria order.

### C5: `code-simplifier` is a review sub-agent with no Machine Summary contract
- **Source:** comment-analyzer
- **File:** `agents/code-simplifier.md`, `engine/src/core/review-output.ts:211`
- **Issue:** `code-simplifier` is in `REVIEW_SUB_AGENTS` and spawned as reviewer #7
  by `commands/review-pr.md`, but its agent file has no `CRITICAL_COUNT` contract.
  `isReviewAgent("code-simplifier")` is true, so its transcript routes through
  `resolveReviewFindings`, finds no count, and marks the task
  `evidence_capture_failed`. The comment at review-output.ts:211 asserts the
  opposite ("Every reviewer agent file now requires the block").
- **Fix:** Give the agent the same Machine Summary contract as its siblings, and
  add a test binding `REVIEW_SUB_AGENTS` to the agent files that declare it — so
  the comment's claim becomes enforced rather than asserted.

---

## Advisory Fixes

### Error handling / correctness
- **A1** `chooseSource`'s `superseded` branch discards the block's parsed drafts
  entirely (`review-output.ts:250`), so `CRITICAL_COUNT` + block + no marker lines
  deletes every real claim. Union the block's unnamed drafts into the scraped set.
- **A3** `parseLegacyFindings` never consults `hasFindingsBlock`/`chooseSource`, so
  a block under a non-`##` Machine Summary heading is discarded and reported
  `absent` (`review-output.ts:322`). Route the legacy path through `chooseSource`.
- **A4** `ADVISORY_COUNT` is required by every reviewer contract and parsed by
  nothing (`review-output.ts:169`). Parse it and give advisories the same
  shortfall reconciliation criticals have.
- **A5** `coverageErrors` skips a criterion absent from `byCriterion`
  (`panel-kernel.ts:463`) — a hole in the net that exists to be redundant.
- **A7** A finding id shared between `findings` and `refuted_findings` loads clean
  and `--fix` cannot repair it, permanently blocking the tally's replay guard.
  Add the cross-array check at the load boundary and seed
  `deduplicateFindingIds`' seen-set with the refuted ids.
- **A8** No surplus-candidate guard for the architecture panel — a winner can be
  declared from 2 of 5 candidates on disk at exit 0.
- **A9** `--fix` mints a duplicate critical when a view claim's internal
  whitespace differs from the finding's. Normalize view claims in
  `recoverViewOnlyClaims`.
- **A12** `aggregateVerdicts` validates no score domain standalone; `NaN` sorts to
  rank 1 with `total_score: null`.
- **A13** `validateFull` runs no findings/lockstep/duplicate-id checks, so the
  operator's validator reports `{ok:true}` on a graph the load boundary refuses.
- **A32** `review-panel brief --wave N` never compares `N` to `state.current_wave`;
  `wave-gate.md` asks the operator to check it with `jq`.
- **A35** `requireEntry` throws from the core and neither `aggregateVerdicts` nor
  `tallyRefutations` is wrapped at its handler call site.

### Type design
- **A14** `parseBriefFindingEntry` / `parseFindingBriefJson` hardcode the severity
  literals instead of the derived `parseFindingSeverity`.
- **A15** `AgentRole` permits `role: "panel"` with a non-architecture phase; narrow
  to a union and delete `derivePanelPhase`.
- **A16** `PANEL_DESIGNERS_MIN` / `PANEL_LENS_COUNT` restate
  `BASELINE_LENSES.length` / `PANEL_LENSES.length` as literals, unlike the review
  panel's derived `REVIEW_LENSES_MIN`.
- **A17** `clampPanelDesigners` has no runtime caller — a specification wearing a
  function's clothes. Delete it; `selectLenses`' range check is the enforcement.
- **A18** Architecture candidate ids stay bare `string` while review ids are
  branded, so lens names and candidate filenames are interchangeable.
- **A19** `Task` is inconsistently immutable (`depends_on`, `TaskGraph.tasks`,
  `SpecCheck.critical_findings`).
- **A30** `JudgeVerdict` is a rename wrapper `aggregateVerdicts` un-renames.
- **A33** `types.ts` ↔ `core/findings.ts` type-only cycle: the schema root is no
  longer the bottom of the module graph.
- **A34** `buildFindingBrief` / `briefCompletenessErrors` take the whole `Task`
  aggregate to read five fields.

### Architecture
- **A26** `core/review-output.ts` declares itself pure and spawns `git rev-parse`
  at import via `config.ts`. Move `isReviewAgent` to `config`.
- **A27** Three pure policy rules (panel-size conflict, threshold floor, replay
  detection) live in the review-panel shell, reachable only via subprocess tests.
- **A28** `parseReviewManifest` hand-rolls the four ordered-set rules
  `parseRunManifest` already implements. Extract `exactOrderedSetErrors`.
- **A31** `operationBrief` re-derives the wave filter `buildFindingBrief` applied,
  so `briefCompletenessErrors`' postcondition proves nothing if the two drift.
- **A36** `parseRunManifest` / `serializeReviewManifest` use platform `node:path`,
  making manifest field equality separator-sensitive. Use `path.posix`.
- **A6** `validate-agent-skill`'s "enforcement SKIPPED" notice goes to stderr on an
  exit-0 hook, where Claude Code does not surface it outside `--debug`.

### Comments / docs
- **A2note** `partial`'s degradation note does not say how many claims were
  carried over, hiding the duplicate count the design deliberately accepts.
- **A20** `commands/loom.md:629` names `.claude/panel-runs/`, a path that exists
  nowhere; the runbook uses `.claude/specs/{date_slug}/panel-runs`.
- **A21** `README.md:279` + `commands/wave-gate.md:217` document the
  `test-coverage` lens signal as path-only; `reviewSignals` matches the claim too.
- **A22** `findings.ts:20` calls `attributeFindings` the only constructor of
  `Finding`; `parseStoredFinding` also builds one from disk.
- **A23** `review-panel.ts:59` says signal-selected lenses come first, inverting
  `selectLenses`' baseline-then-signalled precedence.
- **CR2/CR3** `commands/review-pr.md:166,174` still describe the pre-reconciliation
  arbitration ("sole source", "renames replace silently").
- **A29note** `core/review-panel.ts:497` argues orchestrator-authored manifests are
  unsafe; for the architecture panel the item set is engine-derived and exactly
  enforced, so the comment overstates the asymmetry.

### Tests
- **A10** brownfield → `codebase-conventionist` lens signal is unpinned.
- **A11** `--designers` range/format rejection is unreachable from any test.
- **A24** `runbook-contract.test.ts` binds only `loom.md` and `wave-gate.md`;
  `README.md`/`CONTEXT.md` duplicate the lens tables with nothing reading them.
  `operationOrder`'s `[a-z]+` capture cannot express hyphenated operations, and
  the flag check is a substring match (`--lens` satisfied by `--lenses`).
- **A25** No test binds the finalize template's "engine-computed ranking" prose.
- **serializeRankings** `rank: index + 1` asserted only for entry 0.
- **negative score** `panel-contract.ts:311`'s `score >= 0` lower bound unpinned.

---

## Found while remediating (not in any agent's report)

- **C3 residual — an override through an EMPTY set still rewound the id.** The
  property test written for C3 shrank to `[["!"], [], ["\""]]`: seeding
  `nextOrdinal` from `existing` fixes the two-override case, but an override that
  empties `findings` leaves no record of the ordinals it issued, so the next one
  restarts at 1. Fixed properly — `updateTaskFindings` now files what it replaces
  into `refuted_findings` under the `manual-override` lens. That conserves the
  dismissal (the rule `applyFindingOutcomes` already follows) and makes the
  high-water mark unrewindable, since `nextOrdinal` counts refuted findings.
- **`--fix` reported the INPUT's errors as "remaining".** `validate-task-graph
  --fix` re-used the pre-repair validation result, so it told the operator the
  repair had failed on exactly the runs where it succeeded — and named issues
  they would then hunt for in a file that no longer had them. Latent before this
  round; my `validateFull` change made it fire on every findings repair. Now
  re-validates the repaired graph.
- **`validateFull` and the loader disagreed about the decompose payload.**
  Running the load-boundary findings rules unconditionally rejected the forged
  execution state `sanitizeDecomposedTask` exists to strip. Scoped via
  `ValidationScope`: `state-file` gets every rule, `decompose-payload` does not.
- **The `current_wave` guard subsumed a runbook diagnostic.** A typo'd `--wave`
  now reports "is not the graph's current wave (N)" instead of "no tasks in wave
  N"; both reject, and the new message is the actionable one. The completeness
  path keeps its own test.

## Accepted with rationale (no code change)

- **A2 (duplicate carry-over in `partial`)** — capping the carry-over at
  `claimedCritical - fromBlock.critical.length` re-opens the destruction path the
  by-value reconciliation was added to close: a block that names N different
  claims would again delete N real ones. The module comment already weighs this
  and chooses "never lost, may duplicate" (fail-closed). Addressed by making the
  duplication visible in the operator note rather than by changing arbitration.
- **A37 (`buildFindingBrief`'s `severity` parameter)** — not dead configurability:
  `parseFindingBriefJson` accepts an advisory brief from disk, so
  `briefCompletenessErrors` must follow `brief.severity` regardless of who called
  `buildFindingBrief`. The parameter is the seam `VERIFIED_SEVERITY`'s own
  "revisit once the false-positive rate is measured" note anticipates.
- **A29 (engine-authored architecture manifest)** — the orchestrator cannot omit or
  invent a candidate: `parsePanelManifest` validates the manifest against
  `expectedLenses`, which is derived in-engine from the validated digest, with
  exact length/membership/order/uniqueness rules. A8 closes the one remaining hole
  (surplus files on disk). Moving authorship would change the runbook and four
  templates for no additional safety.

---

## Validation

```bash
cd engine && bun x tsc --noEmit    # clean
cd engine && bun test              # 2236 pass, 0 fail (was 2094 before this round)
./scripts/smoke-panel-mode.sh      # PASS 22 / FAIL 0
./scripts/smoke-review-panel.sh    # PASS 18 / FAIL 0
```

`--fix` idempotence re-verified by hand against a graph carrying all three new
rejections at once (whitespace-drifted view claim, live/refuted id collision,
unnamed evidence failure): rejected → repaired → accepted → second `--fix` is a
byte-identical no-op.

## Deferred

Nothing. Every finding was fixed or is recorded above under "Accepted with
rationale" with the reason it should not be changed.

## Note on this round's environment

A second Claude session was editing the same working tree during Phase 3. It ran
`git stash` + `git reset` at 22:03:42 for a baseline check, which swept this
round's in-flight edits into `stash@{0}`; they were recovered intact and the
other session's work landed separately as `0710b76`. No changes were lost, and
nothing from that commit is included here.
