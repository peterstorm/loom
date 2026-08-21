# PR Remediation Plan — Round 12

**Date:** 2026-08-02
**Branch:** `feat/architecture-panel-mode-plan`
**Scope reviewed:** the adversarial-review-panel surface, `5fbcb64^..HEAD` (44 files)
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead
**Findings:** 3 critical, 19 advisory (deduplicated from 6 agents / 30 raw findings)

Two of the three criticals were independently reproduced by three or four agents each.

---

## Critical Fixes

### C1: `chooseSource` silently deletes every advisory when the block omits them
- **Source:** code-reviewer, pr-test-analyzer, comment-analyzer (all CRITICAL), silent-failure-hunter (advisory)
- **File:** `engine/src/core/review-output.ts:214`
- **Issue:** `claimed = Math.max(criticalCount, critical.length)` and `fromBlock.critical.length >= claimed`
  consider criticals only. A block that accounts for every critical but lists no advisories wins
  wholesale, `blockStatus` reports `"used"`, and every scraped `ADVISORY:` claim is dropped with no
  degradation note. This contradicts the guarantee stated in six agent prompts ("no finding is ever
  lost to it") and breaks `wave-gate.md` Step 4b, which requires every advisory to be triaged.
  Reachable because the same prompt scopes the mandatory block accounting to criticals only.
- **Fix:** require the block to cover advisories too before it wins. Generalize the `"superseded"`
  note from "under-reported criticals" to "under-reported findings".

### C2: `validate-task-graph --fix` silently deletes view-only claims and is non-idempotent
- **Source:** type-design-analyzer, architecture-tech-lead, silent-failure-hunter (all CRITICAL), code-reviewer (advisory)
- **File:** `engine/src/handlers/helpers/validate-task-graph.ts:175`
- **Issue:** `derived = t.findings !== undefined` is the "has migrated" predicate, but the repair
  itself writes `findings: []`. Pass 1 on a pre-identity task creates the discriminator; pass 2 reads
  it as authoritative and re-derives both views from the empty array. `complete-wave-gate` check 5
  counts `critical_findings`, so a blocking critical vanishes and the gate passes. Independently:
  any claim in the views without a structured counterpart is erased with no diagnostic. This is the
  repair `REPAIR_HINT` and `completenessMessage` both prescribe, in exactly the situation that
  triggers it.
- **Fix:** stop dropping. Mint identity for orphan view claims (`recovered-view` agent) so the repair
  restores lockstep instead of destroying it. Report recoveries on stderr. The result is idempotent
  by construction: after one pass the views hold exactly what `findings` holds, so pass 2 finds no
  orphans.

### C3: `store-review-findings --task <unknown>` reports success and stores nothing
- **Source:** silent-failure-hunter (CRITICAL, reproduced)
- **File:** `engine/src/handlers/helpers/store-review-findings.ts:105`
- **Issue:** `tasks.map(t => t.id === taskId ? ... : t)` is a total no-op for an unknown id. The
  handler prints "Stored findings for X: N critical" and exits 0. An operator-added critical never
  reaches the wave gate. Secondary: two separate `mgr.update` calls release the lock between the
  findings write and the `wave_gates.blocked` write.
- **Fix:** prove the task exists before writing, error with the known ids; fold both writes into one
  locked transform.

---

## Advisory Fixes

### A1: the lockstep invariant is documented as load-enforced and is not
- **Source:** architecture-tech-lead, type-design-analyzer, comment-analyzer
- **File:** `engine/src/core/findings.ts:385`, claim at `engine/src/types.ts:145`
- **Issue:** `findingsUnionError` validates element shape only; nothing compares `findings` against
  its two views. The array-richer-than-view direction is caught nowhere and bypasses the gate. This
  is the net that would have caught C2.
- **Fix:** add `findingsLockstepError` (multiset comparison) and call it from `taskUnionError`.

### A2: duplicate finding ids are neither rejected nor repaired
- **Source:** pr-test-analyzer, type-design-analyzer
- **File:** `engine/src/core/findings.ts:385`, `validate-task-graph.ts:175`
- **Issue:** one adjudication then deletes two findings and attaches the panel's reasoning to the
  wrong claim — verbatim the failure `nextOrdinal`'s docstring says the design forecloses. The
  minting path is guarded; the read path is not. `parseFindingBriefJson` catches it at brief time,
  which dead-ends the operator because `--fix` cannot repair it.
- **Fix:** reject duplicate ids at the load boundary; re-mint colliding ids in `--fix`.

### A3: a refutation naming an absent finding is silently discarded
- **Source:** pr-test-analyzer
- **File:** `engine/src/core/findings.ts:517`
- **Issue:** the `flatMap`'s empty branch drops the outcome while `serializeOutcomes` and the stderr
  line both report it as refuted; can promote `blocked → passed`.
- **Fix:** throw, matching `requireEntry`'s established no-silent-default precedent. Also throw on a
  non-surviving outcome with no refutations — the writer can currently produce a record its own
  reader rejects.

### A4: `review_status` derives from the reviewer's self-reported count
- **Source:** silent-failure-hunter
- **File:** `engine/src/core/findings.ts:436`
- **Issue:** `CRITICAL_COUNT: 0` plus real `CRITICAL:` lines records `passed` and logs "passed (0
  critical)". Pins the task at `passed`, which `applyFindingOutcomes`' promotion guard can never
  adjudicate.
- **Fix:** block if either source says so; report the true count in the log.

### A5: `mergeFindings` manufactures the drift `--fix` then erases
- **Source:** silent-failure-hunter
- **File:** `engine/src/core/findings.ts:439`
- **Fix:** migrate a legacy task's view-only claims into `findings` before appending, sharing C2's
  recovery primitive.

### A6: `validate-agent-skill` fails OPEN on unreadable frontmatter
- **Source:** silent-failure-hunter
- **File:** `engine/src/handlers/pre-tool-use/validate-agent-skill.ts:77`
- **Issue:** `catch { return [] }` makes "cannot read" indistinguishable from "declares no skills" on
  a `FAIL_CLOSED_ROUTES` gate. CRLF files and flow-style `skills: [a]` also miss.
- **Fix:** discriminated result; block on unreadable; handle CRLF and flow style.

### A7: `--threshold` accepts values below the strict-majority floor
- **Source:** silent-failure-hunter
- **File:** `engine/src/handlers/helpers/review-panel.ts:367`
- **Fix:** reject below `defaultRefutationThreshold(lensCount)`. Raising it is safe; lowering it
  inverts the documented "ties favour keeping the finding" rule.

### A8: brief completeness is summed wave-wide, so one task's surplus masks another's orphans
- **Source:** silent-failure-hunter
- **File:** `engine/src/handlers/helpers/review-panel.ts:144`
- **Fix:** compare per task and name the offending task ids.

### A9: `briefCompletenessErrors` is pure policy living in the imperative shell
- **Source:** architecture-tech-lead
- **File:** `engine/src/handlers/helpers/review-panel.ts:144`
- **Fix:** move to `core/review-panel.ts` beside `buildFindingBrief`, whose postcondition it is.
  Folded together with A8.

### A10: `prepareWriteTargets` treats every `lstat` error as ENOENT
- **Source:** silent-failure-hunter
- **File:** `engine/src/handlers/helpers/panel-run.ts:173`
- **Issue:** EACCES and ELOOP read as "absent, safe to write", defeating the symlink check the
  function exists to perform.
- **Fix:** gate on `code === "ENOENT"`; error otherwise.

### A11: `RunManifestEntry.id` is a bare string, forcing casts in both consumers
- **Source:** type-design-analyzer
- **File:** `engine/src/core/panel-kernel.ts:92`
- **Fix:** thread an `Id extends string` parameter through the manifest spec so `as PanelLens` /
  `as WaveFindingId` become compiler-checked facts.

### A12–A17: documentation drift
- **Source:** comment-analyzer, type-design-analyzer
- `agents/{code-reviewer,comment-analyzer,pr-test-analyzer,silent-failure-hunter,type-design-analyzer}.md`
  + `commands/review-pr.md`: the block contract must name both severities, and must say the engine
  compares counts, not claim text.
- `engine/src/types.ts:147`: "exactly four writers" omits `sanitizeDecomposedTask` — five.
- `engine/src/core/findings.ts:23`: "owns BOTH writers" contradicts `types.ts`, which enumerates two
  more in handlers.
- `engine/src/core/findings.ts:73`: `collapseWhitespace` is not a no-op — it collapses internal runs.
- `commands/wave-gate.md:214`, `README.md:277`: the `security` lens signal matches claim text too.
- `engine/src/handlers/helpers/validate-task-graph.ts:160`: docstring rewritten for C2's behaviour.

### A18–A19: test gaps
- **Source:** pr-test-analyzer
- No `tests/core/panel-kernel.test.ts`: `requireEntry`'s throw, `parseVerdictEnvelope`'s non-object
  entry, `parseRunManifest`'s non-object item are uncovered by any in-process test.
- `tests/handlers/review-findings-parity.test.ts:87` asserts `f(x) === f(x)` — proves determinism,
  not parity.
- `blockStatusNote`'s `"superseded"` arm and `refutationsUnionError`'s non-array branch uncovered.
- `wave-gate.md:268`'s threshold prose ("2 of 3, 3 of 5, 2 of 2") is not bound to
  `defaultRefutationThreshold` by any test, the one gap in an otherwise systematic drift-guard suite.

---

## Deferred

### Extract `parseExactOrderedSet` into the kernel
- **Source:** architecture-tech-lead (A1, 76% confidence)
- **Reason:** the three sites the extraction would unify do not share a rule. `parseCriteriaSet` is
  order-insensitive. `parseRunManifest`'s id block and `parseReviewManifest`'s lens block differ in
  their per-element parser (membership test vs. `parseReviewLens`) and in their message vocabulary
  (the id block has a per-missing-item message the lens block deliberately lacks). A shared function
  taking six message templates and an element parser is less readable than the ~15 lines it replaces.
- **Recommendation:** revisit if a third panel arrives; two instances is not yet a pattern.

---

## Validation Commands

```bash
cd engine && bunx tsc --noEmit
cd engine && bunx vitest run
bash scripts/smoke-panel-mode.sh && bash scripts/smoke-review-panel.sh
```

---

## Implementation record

All 3 criticals and all 19 advisories applied; one item deferred with reason (above).

**Validation:** typecheck clean; 2020 tests pass across 98 files (was 1958/97); both
smoke suites pass (10/10 and 18/18).

**Each critical re-verified against the reproduction the reviewing agent gave:**

| | Before | After |
|---|---|---|
| C1 | `blockStatus: used`, 3 advisories deleted | `blockStatus: superseded`, 3 advisories kept |
| C2 | `--fix` pass 2 → `critical_findings: []` | idempotent; claim survives both passes |
| C3 | `exit 0`, "Stored findings for T2", nothing written | `exit 1`, "No task 'T2' … known ids: T1" |

### Deviations from the plan

**The load-boundary lockstep check (A1) subsumed part of A8.** With
`findingsLockstepError` proving `findings` and its views agree, the per-task shortfall
branch of `briefCompletenessErrors` is no longer reachable from a loaded state file —
a drifted graph is now rejected one step earlier, with a better diagnostic. The guard
was still made per-task and moved to the core, where it is now directly unit-tested
(A9), and it remains live for the one drift the load boundary cannot see: a
pre-identity task, whose `findings` is absent rather than wrong. The CLI test that
covered the old wave-wide path was retargeted at the load-boundary rejection.

**A6 needed more than a polarity flip.** `parseSkillsFromFrontmatter` returned `[]`
for four distinct conditions. It now returns a closed union
(`none | skills | unreadable`), and the CRLF and flow-style (`skills: [a, b]`) parses
that were silent misses are handled — each was previously indistinguishable from
"declares no skills", which the handler reads as "allow".

**A17 surfaced a real doc gap, not just a missing test.** Binding the runbook prose to
`defaultRefutationThreshold` revealed that `--threshold` was never documented at all,
so nothing told an orchestrator the majority was a floor. `wave-gate.md` now says so.

**A19's tautology could not be fixed the way the reviewer suggested.** Executing Pi's
interception in-process needs the Pi runtime (the logic lives inside
`export default function (pi: ExtensionAPI)`), so `expect(pi).toEqual(claudeCode)` was
replaced with an output-contract test pinning the exact task shape both harnesses must
write, plus the evidence-failure branch. The structural greps stay as the drift guard,
with their limit now stated in the file's header rather than implied.

### Invariants added

- `findingsLockstepError` — `findings` and its two `string[]` views must agree as
  multisets, proven at every load. Named in `types.ts` as the enforcement point, which
  it previously was not.
- Finding ids must be unique within a task, proven at load and repaired by re-minting.
- `applyFindingOutcomes` throws rather than skipping an outcome it cannot match, and
  refuses to write a refutation record its own reader would reject.
- `--fix` conserves claims: every repair path either keeps a claim or gives it
  identity, and the transformation is idempotent.
- `--threshold` may only raise the refutation bar, never lower it.
