# PR Remediation Plan — adversarial review panel

**Date:** 2026-08-02
**Branch:** `feat/architecture-panel-mode-plan`
**Scope:** `e03d391..HEAD` (43 files, +5909/-322) — the adversarial-review-panel work only.
The earlier panel-mode commits already went through ten remediation rounds.
**Findings:** 9 critical, 19 advisory (deduplicated from 6 reviewers)

Reviewers: `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`,
`type-design-analyzer`, `comment-analyzer`, `architecture-tech-lead`.

Three critical findings were reported independently by three reviewers each
(C1, C2, C3), which is what promoted them past "plausible".

---

## Critical Fixes

### C1: Finding ids are reused after a refutation
- **Source:** code-reviewer, silent-failure-hunter (both reproduced end-to-end)
- **File:** `engine/src/core/findings.ts:144`
- **Issue:** `nextOrdinal` derives the next id from `task.findings.length`, but
  `applyFindingOutcomes` *removes* refuted findings from that array. A re-review
  after a refutation remints an ordinal `refuted_findings` still holds. The
  duplicate id then makes `applyFindingOutcomes`' Set-based filter delete BOTH
  entries — including an untouched advisory nobody adjudicated — and
  `removed.find(...)` records the wrong claim against the panel's reasoning.
- **Fix:** Mint from the highest ordinal ever issued across
  `findings ∪ refuted_findings`, parsed back out of the id rather than counted.

### C2: A short `findings` block silently discards scraped criticals
- **Source:** code-reviewer, silent-failure-hunter, pr-test-analyzer, comment-analyzer
- **File:** `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:87,180`
- **Issue:** When the fenced block parses it *wholly replaces* the scraped
  `CRITICAL:` lines while `criticalCount` still comes from the markers.
  `reconcileFindings` only fires when `critical.length === 0`, so a
  valid-but-short block loses findings in silence and the gate still reads green
  on the survivors.
- **Fix:** The block wins only when it accounts for every critical the reviewer's
  own `CRITICAL_COUNT` and marker lines claim; otherwise the marker lines win
  (real claim text, no locations). `reconcileFindings` backstops any remaining
  shortfall against `CRITICAL_COUNT`, not just total loss.

### C3: An empty brief succeeds and the panel reports a clean run
- **Source:** silent-failure-hunter, pr-test-analyzer, architecture-tech-lead
- **File:** `engine/src/handlers/helpers/review-panel.ts:127`
- **Issue:** `buildFindingBrief` reads `task.findings`; the Step 3.5 skip guard
  counts `critical_findings`. A wrong `--wave`, a pre-identity task graph, or a
  `fixFull`-pruned graph produces a zero-finding brief that passes every stage
  and prints `0 finding(s) survived, 0 refuted` — indistinguishable from a real
  unanimous-upheld panel.
- **Fix:** `brief` fails closed on a wave with no tasks, on a wave with no
  criticals (the runbook says skip), and on a brief that carries fewer findings
  than the `critical_findings` view the gate counts.

### C4: `fixFull` manufactures the un-refutable critical its comment claims to prevent
- **Source:** pr-test-analyzer, silent-failure-hunter
- **File:** `engine/src/handlers/helpers/validate-task-graph.ts:173`
- **Issue:** Re-parses `findings` through `parseStoredFindings` (which drops
  malformed entries) while passing `critical_findings` through verbatim. The
  orphaned claim can never enter a brief, so it can never be refuted — the task
  is permanently blocked on a finding no panel can reach.
- **Fix:** Re-derive both views from the repaired `findings` whenever `findings`
  is present, so the repair restores lockstep instead of breaking it.

### C5: `Task.findings` is asserted, never parsed, at the load boundary
- **Source:** type-design-analyzer, code-reviewer (both reproduced a TypeError)
- **File:** `engine/src/state-manager.ts:137`
- **Issue:** `parseTaskGraph` proves every other union-typed field before its
  blessed cast, then asserts `findings?: readonly Finding[]` from unvalidated
  JSON. A finding missing its `file` key throws
  `Cannot read properties of undefined` out of `sanitizeProse` — an unhandled
  TypeError from the wave gate, in a module whose discipline is "never trust the
  step that just ran".
- **Fix:** Validate `findings` / `refuted_findings` in `taskUnionError`, failing
  loudly at load like every sibling field. `validate-task-graph --fix` is the
  documented repair path (C4 makes it a correct one).

### C6: The brief's severity policy is not enforced by its own re-parser
- **Source:** type-design-analyzer (reproduced)
- **File:** `engine/src/core/review-panel.ts:288`
- **Issue:** `parseFindingBriefJson` validates `brief.severity` and each entry's
  `severity` but never cross-checks them, so a brief declaring `critical` parses
  `ok` carrying advisories. `VERIFIED_SEVERITY` is a policy invariant the
  re-parse exists to enforce, and a refuted advisory gets stripped from
  `advisory_findings`.
- **Fix:** Cross-check every entry's severity against the brief's.

### C7: `--lenses N` is documented but breaks the very next step
- **Source:** comment-analyzer (reproduced by execution)
- **File:** `commands/wave-gate.md:204`, `engine/src/handlers/helpers/review-panel.ts:178`
- **Issue:** `--lenses` is consumed by all four manifest-scoped operations, which
  each re-derive the lens set, but only the `manifest` snippet carries it.
  `lenses`/`verdict`/`tally` then fail with `manifest.lenses must contain exactly
  3 lenses` — blaming the manifest when the caller under-specified.
- **Fix:** Read the lens count from the manifest being parsed. The derivation
  (and therefore the tamper check) is unchanged; the flag becomes `manifest`-only.

### C8: README table rows orphaned by the new section
- **Source:** comment-analyzer
- **File:** `README.md:416`
- **Issue:** The `### Review panel agent` section was inserted mid-table;
  `code-simplifier` and `spec-check-invoker` now trail a prose paragraph with no
  header and drop out of the documented roster.
- **Fix:** Restore the two rows to their table.

### C9: The findings-block contract tells reviewers the opposite of what runs
- **Source:** comment-analyzer
- **File:** `commands/review-pr.md:165` + the same paragraph in all five reviewer
  agent definitions
- **Issue:** "the block adds location and structure, it does not replace the
  marker lines" — it replaced them entirely.
- **Fix:** State the post-C2 rule: the block must account for every critical the
  markers claim, or the markers win.

---

## Advisory Fixes

| # | Finding | File |
|---|---|---|
| A1 | `updateTaskFindings` rewrites `critical_findings` without touching `findings`, breaking the derived-view invariant `types.ts` declares | `handlers/helpers/store-review-findings.ts:43` |
| A2 | Skip-guard jq `add` yields `null`, not `0`, for an empty wave | `commands/wave-gate.md:149` |
| A3 | `removeOnce` no-ops silently on a missing claim | `core/review-panel.ts:683` |
| A4 | A rejected findings block falls back to the scraper with no diagnostic | `core/findings.ts:190` |
| A5 | Claude Code discards a reviewer's whole output with no log where Pi warns | `subagent-stop/store-reviewer-findings.ts:292` |
| A6 | `?? 0` / `?.` encode "missing verdict = score 0 / abstain" behind coverage guards | `core/panel-contract.ts:486`, `core/review-panel.ts:627` |
| A7 | `refutedBy` / `reasoning` are positionally-aligned parallel arrays | `core/findings.ts:239`, `core/review-panel.ts:553` |
| A8 | Wave-scoped and task-local finding ids are both bare `string`; `briefFindingFilename` accepts either | `core/review-panel.ts:177` |
| A9 | `ReviewLens` widened to `string` at every consumer past the manifest | `core/review-panel.ts:522,581` |
| A10 | `blocked → passed` decided from the derived view, not the authoritative `kept` | `core/review-panel.ts:724` |
| A11 | `RunLayout` is pure data stranded in the shell; core hardcodes `"interview.md"` / `"candidates"` and a core test imports through `node:fs` | `handlers/helpers/panel-run.ts:24` |
| A12 | ~230 lines of pure parse/reconcile/merge stranded in the SubagentStop handler, split from their sibling `applyFindingOutcomes` in core | `subagent-stop/store-reviewer-findings.ts:38` |
| A13 | Per-verdict coverage re-check and the verdict-read loop duplicated across both panels | `core/review-panel.ts:605`, `handlers/helpers/review-panel.ts:286` |
| A14 | `parsePanelManifest` and `parseReviewManifest` are the same parser twice, with already-diverged coverage rules | `core/panel-contract.ts:232` |
| A15 | The review panel writes brief/finding/manifest artifacts before any symlink check on the write targets | `handlers/helpers/review-panel.ts:143` |
| A16 | Test gaps: no property tests on the headline lockstep/tally invariants; forged-state test omits the two new fields; sanitize→refute composition untested | `tests/core/review-panel.test.ts` |
| A17 | Template test hardcodes the verdict list instead of deriving from `REFUTATION_VERDICTS` | `tests/review-panel-templates.test.ts:66` |
| A18 | Comment/doc drift: `parseFindingFile` "single-segment path"; `types.ts` derived-view writers; `config.ts` "arity"; `REVIEW_LENSES_DEFAULT` "signal-selected"; wave-gate "by name"; plan §A1 id derivation; README "six-step"; "the ONE legitimate demotion" | various |
| A19 | Harness parity asserted by grepping `pi/extension.ts` source text | `tests/handlers/review-findings-parity.test.ts:47` |

---

## Order

1. **C5, C4, C1** — the state-boundary and identity fixes everything else rests on
2. **C2, C9, A4, A5** — the reviewer-output parse path
3. **C3, C6, C7, A2, A15** — the panel run boundary
4. **A1, A3, A6, A7, A9, A10** — invariants into types
5. **A11, A12, A13, A14** — the architecture moves
6. **A16, A17, A19** — tests
7. **C8, A18** — docs

## Validation

```bash
cd engine && bun run typecheck && bun test   # clean, 1958 pass / 0 fail
scripts/smoke-panel-mode.sh                  # 10/10
scripts/smoke-review-panel.sh                # 18/18
```

## Status: all 9 critical and all 19 advisory findings applied

Nothing deferred.

### Notable design decisions taken during remediation

**C2 — which source wins.** Three candidate rules were on the table. "Block
always wins" is what shipped and loses claims. "Markers always win" throws away
the locations, and breaks a reviewer that emits only the block. The rule
implemented is: *the block wins only when it accounts for at least as many
criticals as both `CRITICAL_COUNT` and the scraped `CRITICAL:` lines.* No claim
can be lost to it, only locations, and `reconcileFindings` backstops whatever
shortfall remains. The outcome is reported to the operator through a new
`FindingsBlockStatus` (`absent` / `used` / `rejected` / `superseded`), which also
closes A4 — a silent degradation now prints why.

**C5 — reject at load, repair with `--fix`.** `parseStoredFindings` DROPS
malformed entries; that is right for a repair path and wrong for a read path,
where it would silently lose a critical on every load. The load boundary now
rejects, naming `validate-task-graph --fix` in the diagnostic, and C4 makes that
repair a correct one (it re-derives the views instead of orphaning claims). A
test pins the two against each other: what the boundary rejects is exactly what
the repair fixes, so a graph can never be both unloadable and unrepairable.

**A12 — where the pure logic went.** The parse → reconcile → merge pipeline moved
to `core/review-output.ts`; `mergeFindings` and `applyFindingOutcomes` — the two
writers of the lockstep invariant — moved together into `core/findings.ts`.
Putting them in one module needed `AdjudicatedFinding`, a narrow structural
interface `FindingOutcome` satisfies, because `review-panel` imports `findings`
and the reverse import would be a cycle. A compile-time assertion in
`review-panel.ts` proves the structural match rather than leaving it a
coincidence. `store-reviewer-findings.ts` is now 75 lines of shell.

**A14/A11 — how far the kernel extraction went.** `parseRunManifest` now holds
the manifest rules both panels enforce, and the architecture panel gained the
per-item "is missing X" diagnostic only review had. `RunLayout` moved into the
kernel with a phantom `Panel` tag, so `ARCHITECTURE_LAYOUT` no longer typechecks
where a review layout belongs, and `core/panel-contract.ts`'s hardcoded
`"interview.md"` / `"candidates"` literals are gone. The core test suite no
longer imports through a `node:fs` module.

**A3 — resolved at the source, not patched.** `removeOnce`'s silent no-op needed
no guard once C4 and C5 removed the only two paths that could desynchronize the
views from `findings`. Its comment now states the invariant that makes a miss
impossible rather than defending against one.

**A6 — `requireEntry` throws.** A missing verdict entry after the coverage check
is a broken invariant, not a degraded input, and the plausible defaults it
replaces (`?? 0` for a score, abstain for a vote) are exactly the ones that
silently change which architecture wins or whether a finding survives. `cli.ts`'s
top-level catch turns it into a fail-closed exit with the invariant named.
