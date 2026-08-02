# PR Remediation Plan — Round 13

**Date:** 2026-08-02
**Branch:** feat/architecture-panel-mode-plan
**Scope:** `git diff main...HEAD` — 77 files, +13,606/-341
**Baseline:** typecheck clean, 2036 tests pass (99 files)
**Findings:** 4 critical, 20 advisory (1 dismissed on verification)

Reviewed by: code-reviewer (0/0), silent-failure-hunter (2/2),
pr-test-analyzer (1/3), type-design-analyzer (0/6), comment-analyzer (1/6),
architecture-tech-lead (1/3). Deduplicated across agents.

---

## Critical Fixes

### C1: `chooseSource` arbitrates on cardinality, silently destroying marker claims
- **Source:** pr-test-analyzer + architecture-tech-lead (independently reproduced)
- **File:** `engine/src/core/review-output.ts:221`
- **Issue:** The block-vs-markers decision compares only `length`. A findings
  block that duplicates one claim, or names claims the `CRITICAL:`/`ADVISORY:`
  lines never made, satisfies `accountsForAll`, wins with `blockStatus: "used"`
  (so `blockStatusNote` prints nothing), and the distinct marker claims are
  deleted. `reconcileFindings` does not fire because the count matches, and
  `findingsLockstepError` passes because the views are derived from the
  substituted set. The lost critical never reaches `findings`, the wave gate,
  or the refutation panel — the one path on this branch that destroys rather
  than degrades a finding.
- **Fix:** Keep cardinality arbitration (strict claim containment would reject
  every reworded block and permanently cost file/line), but conserve the
  difference. Compute the multiset difference with `removeOnce`, append the
  unaccounted marker claims as location-less drafts, and add a `"partial"`
  `FindingsBlockStatus` so the substitution reaches the operator. Nothing lost,
  nothing false added.
- **Test:** replace the cardinality-only property at
  `tests/core/review-output.test.ts:602` (whose generator builds block claims as
  a prefix subset of the marker claims, making it structurally unable to detect
  this) with one that generates block claims from a disjoint alphabet and
  asserts multiset containment of every marker claim.

### C2: the review panel's size is recovered from the mutable manifest
- **Source:** silent-failure-hunter (verified end-to-end against the real CLI)
- **File:** `engine/src/handlers/helpers/review-panel.ts:263`
- **Issue:** `manifest` is the one manifest-scoped operation that skips the
  existing-file read, so re-running it without `--lenses` overwrites a recorded
  5-lens panel with the 3-lens default. `readVerdicts` then iterates only
  `lenses.length`, silently ignoring `verdict-4.json`/`verdict-5.json`, and the
  threshold drops from 3 to 2 — refuting a finding the full panel upheld and
  promoting `blocked → passed` at exit 0 with no diagnostic. The comment above
  it claims a truncated manifest is rejected by lens-set re-derivation; that is
  false, because `selectReviewLenses` returns nested prefixes.
- **Fix:** (a) `manifest` reads any existing manifest.json too, tolerating only
  ENOENT; (b) `--lenses` disagreeing with an already-recorded count is a hard
  error — the panel size is fixed for the life of the run; (c) `readVerdicts`
  rejects verdict files numbered beyond the criteria count, since a surplus
  verdict is positive evidence the panel that ran was larger. Correct the false
  comment and the same claim in `commands/wave-gate.md:222`.

### C3: `validate-task-graph --fix` silently deletes a critical claim
- **Source:** silent-failure-hunter (verified against the real CLI)
- **File:** `engine/src/handlers/helpers/validate-task-graph.ts:201`
- **Issue:** `parseStoredFindings` drops malformed entries; `recoverViewOnlyClaims`
  restores their claims only when the `string[]` view also holds them. When it
  does not, the claim is gone and `FindingsRepair` has no channel to say so —
  contradicting `fixTaskFindings`' own "every path CONSERVES claims" docstring.
  The load boundary names this repair in its diagnostic, so the one command the
  engine tells the operator to run is the one that deletes the blocker;
  `complete-wave-gate` check 5 then counts zero criticals.
- **Fix:** salvage before dropping. Add `salvageMalformedFindings` to
  `core/findings.ts`: a malformed entry that still carries a usable severity and
  claim is re-minted under `RECOVERED_AGENT` rather than lost. Extend
  `FindingsRepair` with `salvaged`, `dropped`, and `droppedRefutations`, and emit
  a note per drop in `fixFull` — the treatment `recovered` and `reminted`
  already get. Make the docstring's invariant true rather than conditional.

### C4: `commands/loom.md` omits the refutation panel from the wave-gate agent list
- **Source:** comment-analyzer
- **File:** `commands/loom.md:479-482`
- **Issue:** This branch made the refutation panel a MUST-level wave-gate step
  (`commands/wave-gate.md:418`) and added `review-verifier-agent` to
  `engine/src/config.ts:267`. `loom.md`'s enumeration of "the agents the
  wave-gate spawns" was not updated; the words *refutation*, *verifier*, and
  *Step 3.5* appear nowhere in the file. An orchestrator trusting the list
  spawns spec-check plus five reviewers, sees them complete, and advances — the
  branch's headline feature silently never runs. Prose here is executable
  contract.
- **Fix:** add the panel as item 3 with its conditional trigger and agent name.

---

## Advisory Fixes

| # | File:line | Issue | Fix |
|---|---|---|---|
| A1 | `validate-agent-skill.ts:158` | `resolveAgentPath` → null returns `allow` with no stderr note — the fail-open polarity this PR reversed one line below, now widened to the new panel agents | Warn to stderr before allowing; blocking would break installs with agents outside the four searched paths |
| A2 | `store-reviewer-findings.ts:66` | `tasks.map` over an unverified task id is a total no-op while line 71 logs "review: blocked (N critical)" | Resolve the task first; `warn` and return when absent — the guard `store-review-findings.ts:115` added in this same diff |
| A3 | `review-panel.ts:377` | A second `tally` throws out of `mgr.update` blaming a task-graph mutation instead of the repeated tally | Pre-check for already-adjudicated findings with an honest diagnostic; wrap the update so an invariant throw becomes a contract error |
| A4 | `core/review-panel.ts:122` | `touchesTests` consults only `file` while `touchesSensitiveBoundary` consults file *and* claim, so the `test-coverage` lens can never be signal-selected on scraper-sourced findings (file always null) | Make `TEST_PATH` anchorless and apply it to both, symmetric with `SENSITIVE_PATH` |
| A5 | `core/findings.ts:495` | `AdjudicatedFinding` makes `survives: false` with empty `refutations` representable; enforced by a runtime throw | Discriminated union with a non-empty tuple; `tallyRefutations` proves it at construction, `applyFindingOutcomes`' second throw disappears |
| A6 | `types.ts:157` | The derived views are mutable `string[]` while the authoritative `findings` is `readonly` — exactly backwards | `readonly string[]` |
| A7 | `core/panel-contract.ts:380` | `CandidateRanking.scores` is aligned to the criteria order by comment only, and `serializeRankings` re-zips from a separate parameter | Pair list `{criterion, score}[]` |
| A8 | `core/panel-kernel.ts:313` | `parseVerdictEnvelope` tests id membership instead of resolving it, so `RefutationVerdict.findingId` widens a proven `WaveFindingId` back to `string` | Parameterize on `Id`, resolve like `parseRunManifest`, pass the resolved id to `parseEntry` |
| A9 | `types.ts:133` | `review_error` is not tied to `ReviewStatus` and is never cleared, so `passed` beside a stale evidence-capture error is reachable | Clear it in every writer that moves the status off `evidence_capture_failed` |
| A10 | `config.ts:55` | `PHASE_AGENT_MAP` is `Readonly<Record<string, Phase>>` over a prototype-carrying object — `detectPhase("constructor")` returns a `Function` typed as `Phase` | Null-prototype object; honest `Phase \| undefined` value type |
| A11 | `commands/loom.md:625` | The closed two-class helper taxonomy omits `panel-contract` (5 invocations this document directs) and `review-panel` (5 in wave-gate.md, one of which writes state) | Add both to the out-of-scope class, calling out `review-panel tally`'s state write |
| A12 | `core/review-output.ts:198` | Comment claims in present tense that the reviewer prompt scopes block accounting to criticals; all five reviewer agents now require the opposite | Rewrite (folded into C1) |
| A13 | `core/findings.ts:521` | `recoverViewOnlyClaims` "shared by [two callers]" — `updateTaskFindings` is a third | Correct the count |
| A14 | `store-review-findings.ts:73` | "all four writers" contradicts `types.ts:145` ("exactly five") | Correct the count |
| A15 | `README.md:797` | `/references/` enumeration gained `panel-lenses.md` but not `review-lenses.md`, added in the same branch and loaded at runtime | Add it |
| A16 | `CONTEXT.md` | None of the branch's new domain vocabulary registered; "Lens" now names two disjoint enums — the collision class its Flagged Ambiguities section exists for | Add the terms and the ambiguity |
| A17 | `core/review-panel.ts:399` | `briefCompletenessErrors` counts `critical_findings` unconditionally while `buildFindingBrief` is severity-parameterized and the diagnostic interpolates `brief.severity` | Derive the view from `brief.severity` |
| A18 | `core/panel-contract.ts:202` + `core/review-panel.ts:131` | `selectPanelLenses` / `selectReviewLenses` are the same ten-line algorithm verbatim — the setup whose prior instance (`parseRunManifest`) the kernel docstring records as having already diverged | Extract `selectLenses` into `panel-kernel.ts` |
| A19 | `helpers/panel-contract.ts:30` + `helpers/review-panel.ts:131` | Duplicated two-tier containment loop; the architecture copy keys its tier on `path === manifest.interviewFile` value equality, safe only by a guarantee held two modules away | Hoist `runArtifactErrors` into `panel-run.ts` taking the two tiers as separate arguments |

### Dismissed on verification

- **`core/review-panel.ts:532` uniqueness check is dead** (pr-test-analyzer).
  Not dead. When a duplicate lens coexists with an unknown one, the unknown is
  skipped and `lenses.length !== expectedLenses.length`, which short-circuits
  the positional check at 533 — leaving the uniqueness check as the only signal.
  Verified by reading the parse loop. No change.

---

## Validation Commands

```bash
cd engine && bun run typecheck
cd engine && bunx vitest run
bash scripts/smoke-panel-mode.sh && bash scripts/smoke-review-panel.sh
```

---

## Outcome

All 4 critical and all 19 advisory fixes applied. Nothing deferred.

| Check | Before | After |
|---|---|---|
| `bunx tsc --noEmit` | clean | clean |
| `bunx vitest run` | 2036 pass / 99 files | **2057 pass / 99 files** (+21) |
| `smoke-panel-mode.sh` | 22/22 | 22/22 |
| `smoke-review-panel.sh` | 18/18 | 18/18 |

### Tests added (21)

- **C1** — 4 examples (disjoint-claim block, duplicated-claim block, multiset
  duplicate, operator note) + 1 rewritten property. The old property generated
  block claims as a prefix subset of the marker claims and asserted only
  lengths; the new one draws them from a disjoint alphabet and asserts multiset
  containment by value, plus "nothing invented".
- **C2** — 4 CLI tests: `manifest` re-run does not shrink a recorded panel,
  conflicting `--lenses` is refused, restating the size is idempotent, and a
  surplus `verdict-4.json` fails the tally.
- **C3** — 4 `fixFull` tests: salvage of a view-less malformed critical, no
  double-mint when the view also holds it, drops named in the notes, and
  idempotency after salvage.
- **A1/A2/A3/A4/A5/A17** — one test each, plus a second parity test binding both
  harnesses to the task-existence guard.

### Deviations from the plan

- **A1** was fixed as a loud `allow` (stderr note) rather than a `block`.
  `VALIDATED_AGENTS` includes agents users legitimately define outside the four
  searched paths, so blocking every unresolvable spawn would break working
  installs to enforce a rule the engine cannot read. The silence was the defect;
  the permissiveness is deliberate and now stated in the output.
- **A2** also required the same guard in `pi/extension.ts`. Fixing only the
  Claude Code hook would have reintroduced the harness drift
  `review-findings-parity.test.ts` exists to prevent, so the guard and its parity
  test cover both shells.
- **A4** additionally needed `TEST_PATH`'s leading `/` anchor widened to a
  boundary class. Removing only the trailing `$` anchors left `tests/foo.ts`
  unmatched inside a sentence, which is the common scraped-claim shape.
- **C1** required updating the five reviewer agent files: their closing
  paragraph documented the old silent-substitution behaviour as a caveat authors
  had to work around.
