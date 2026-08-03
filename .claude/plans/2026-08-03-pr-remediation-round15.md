# PR Remediation Plan — Round 15

**Date:** 2026-08-03
**Branch:** feat/architecture-panel-mode-plan
**Baseline:** `bunx tsc --noEmit` clean · 2236/2236 vitest green · both smoke scripts pass
**Findings:** 10 critical, 20 advisory (after dedup across 6 review agents)

Reviewers: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
comment-analyzer, architecture-agent.

Two criticals were reported independently by two agents each (C1/C2 by code-reviewer +
architecture-agent; C3 by code-reviewer + type-design-analyzer) and both were reproduced
directly before planning.

---

## Critical Fixes

### C1: Pi extension imports `isReviewAgent` from a module that does not export it
- **Source:** code-reviewer, architecture-agent
- **File:** `pi/extension.ts:29`
- **Issue:** The branch moved `isReviewAgent` to `engine/src/config.ts:285` (deliberately — a
  docblock there explains that keeping it in `core/review-output` would falsify that module's
  purity claim). `pi/extension.ts` was pointed at `core/review-output`, which exports no such
  name. Under ESM this is a **link-time** `SyntaxError`, not a lazy `undefined`, so the whole
  extension module fails to evaluate and **every loom hook under Pi is dead** — phase order,
  wave gates, template substitution, direct-edit blocking, review capture. Verified:
  `TS2305: Module '"../engine/src/core/review-output"' has no exported member 'isReviewAgent'`.
- **Fix:** Import `isReviewAgent` from `../engine/src/config`.

### C2: `pi/` is outside every mechanical check, which is what let C1 land
- **Source:** architecture-agent
- **File:** `engine/tsconfig.json:12`
- **Issue:** `"include": ["src","tests"]` excludes `pi/` (700+ lines). No test imports it, and
  there is no CI. The Pi half of a two-harness system has zero verification.
- **Fix:** The `@earendil-works` peer deps are not installed, so a plain tsconfig widening cannot
  typecheck `pi/` cleanly. Add instead a harness-free vitest test that statically resolves
  **every** `../engine/...` named import in `pi/extension.ts` and `pi/loom-bridge.ts` against the
  real module exports. Catches exactly this drift class with no Pi runtime.

### C3: `deduplicateFindingIds` can mint a *new* collision — `--fix` leaves the graph unloadable
- **Source:** code-reviewer, type-design-analyzer
- **File:** `engine/src/core/findings.ts:707`
- **Issue:** The re-minted id is never added to `taken`, and `nextOrdinal(kept, …)` only sees
  findings processed so far, so a re-mint can land on an id a *later, unprocessed* finding
  already holds. Reproduced: `["x-1","x-1","x-2"]` → `["x-1","x-2","x-2"]`, and
  `findingsUnionError` still rejects it with *"repair with: helper validate-task-graph --fix"* —
  the repair the operator was just told to run. Every loom handler fails until repaired, and the
  named repair hands back another unloadable graph.
- **Fix:** Record every emitted id in `taken` and advance past ids already taken.
  Add a property test for the postcondition and a `fixFull` fixed-point assertion.

### C4: the re-tally guard misses the case where the second run refutes a *different* finding
- **Source:** pr-test-analyzer (verified independently)
- **File:** `engine/src/core/review-panel.ts:826`
- **Issue:** `replayedOutcomes` filters on `!outcome.survives && alreadyRefuted.has(id)`, so it
  fires only when the *same* finding is refuted twice. Tally 1 refutes F1 (F2 upheld); the
  operator rewrites `verdicts/` and re-runs; now F1 is upheld and F2 refuted. Nothing is flagged.
  The tally proceeds against a **stale brief**, refutes F2, and if F2 was the last live critical
  `applyFindingOutcomes` promotes `blocked → passed`. The emitted outcome JSON reports F1 as
  *surviving* while the graph holds it refuted. Exit 0, nothing on stderr.
- **Fix:** A fresh brief is built from `task.findings`, which excludes refuted findings, and
  ordinals never rewind — so **any** overlap between brief ids and refuted ids means the tally
  was already applied. Drop the `!survives` condition; fire on any already-adjudicated id.

### C5: README describes the pre-`ae421c0` panel design and omits the mandatory aggregate step
- **Source:** comment-analyzer
- **File:** `README.md:189`
- **Issue:** *"Finalize — architecture-agent aggregates by total score with deterministic
  tie-breaks"*. Commit `ae421c0` moved that into `helper panel-contract aggregate`;
  `commands/loom.md` Step 4.5 makes it a mandatory no-agent step and
  `phase-arch-finalize.md:37` says the ranking *"is authoritative — do not recompute it"*. The
  README four-step list has no entry for Step 4.5, so a reader following it hand-ranks.
- **Fix:** Rewrite the walkthrough as five steps with the engine-authored aggregate.

### C6: the sole Claude Code findings-ingestion handler has no behavioral test
- **Source:** pr-test-analyzer
- **File:** `engine/src/handlers/subagent-stop/store-reviewer-findings.ts`
- **Issue:** Nothing imports or spawns it; the only reference greps its source text. Six branches
  survive semantic mutation with the full suite green — including deleting
  `resolveAgentTranscriptPath`, which **reverts commit `0710b76`** ("survive the Task → Agent
  rename and stop failing silently"). A harness sending no `agent_transcript_path` loses every
  reviewer's findings and the gate reads a clean review that never happened.
- **Fix:** New `engine/tests/handlers/subagent-stop/store-reviewer-findings.test.ts` driving the
  handler end to end against a tmp state file and planted transcripts.

### C7: the smoke scripts' rejection assertions cannot tell a real rejection from any other failure
- **Source:** pr-test-analyzer
- **File:** `scripts/smoke-panel-mode.sh:493,523,535`
- **Issue:** Exit-code-only. Replacing the provocation with an unrelated `rm "$MANIFEST"` still
  prints `✓ missing verdict REJECTED` and `FAIL: 0`. Contradicts the script's own stated design
  (*"stderr is captured (NOT discarded) so a caller can assert the block MESSAGE"*).
- **Fix:** Assert the discriminating diagnostic string, as the sibling at `:482` already does.

### C8: nothing joins the tally to the gate decision it exists to change
- **Source:** pr-test-analyzer
- **File:** `engine/tests/handlers/complete-wave-gate.test.ts`
- **Issue:** Zero `refuted_findings` scenarios. The feature's entire claim — "majority-refuted
  criticals die; survivors block the gate" — is never asserted as one fact.
- **Fix:** Composition test: apply outcomes, then evaluate the wave gate.

### C9: the whole review-panel CLI suite runs against a single-task wave
- **Source:** pr-test-analyzer
- **File:** `engine/tests/handlers/helpers/review-panel.test.ts:15`
- **Issue:** The `WaveFindingId` brand exists so two tasks can each hold a `code-reviewer-1`, and
  that is never driven through brief → manifest → verdict → tally. Nor is the gate-deciding case:
  task A fully refuted (→ `passed`) while task B's criticals survive, so the wave stays blocked.
- **Fix:** Two-task fixture plus the per-task routing and mixed-outcome assertions.

### C10: neither smoke script is run by anything
- **Source:** pr-test-analyzer
- **File:** `engine/package.json:9`
- **Issue:** No `.github/` exists; `"test": "vitest run"` does not invoke `test:smoke`. 878 lines
  of harness gate nothing, while `runbook-contract.test.ts:20` claims in prose that the chain is
  *"proven … by the two smoke scripts."*
- **Fix:** Both scripts run in 1.3s combined. Fold them into `npm test`.

---

## Advisory Fixes

### A1: `brief` fails **open** on a graph with no `current_wave`
`engine/src/handlers/helpers/review-panel.ts:147` — the stale-wave proof is skipped entirely when
`current_wave` is absent, contradicting the adjacent comment. Fail closed, and extract the rule to
`core/review-panel.ts` beside the three sibling rules the branch already moved there.

### A2: `brief` leaves stale per-finding artifacts behind
`engine/src/handlers/helpers/review-panel.ts:166` — a re-brief after a refutation leaves orphan
`findings/finding-*.json`, and the next `manifest` fails with *"the panel that produced them was
larger than the manifest declares"*, which describes the opposite of what happened. Clear
`LAYOUT.itemDir` on brief.

### A3: `validateFull` is evaluated and discarded on the `--fix` path
`engine/src/handlers/helpers/validate-task-graph.ts:466` — it writes `new_tests_required=false`
warnings to stderr as a side effect, so every `--fix` prints them twice. Move it into the
non-fix branch.

### A4: `judgeTestRun` conflates "harness gave no exit code" with "the exit is not this test's"
`engine/src/machine/test-report.ts:130` — `attributeExit` returns `null` for four *other* reasons
(backgrounded `&`, a later segment owning the exit, …). `mvn test &` plus a partially-written
surefire directory mints **`trusted-pass`** on a suite still running, and
`applyUntrustedStopResolution` then refuses to let any later resolution correct it. Distinguish
"no exit code available" from "exit belongs elsewhere" and only trust the former.

### A5: `fixTaskFindings` deletes view-only sentinel/empty claims with no note
`engine/src/handlers/helpers/validate-task-graph.ts:297` — the docblock promises "every path
CONSERVES claims, or SAYS that it could not". `makeDraftFinding` returns `null` for a sentinel
(`"none"`) or empty claim, and `dropped` is computed only from `t.findings`, so it stays 0.
`checkCriticalFindings` does not filter sentinels, so the task blocks the gate before `--fix` and
passes after, silently. Count and report them.

### A6: `aggregateVerdicts` is unwrapped where its sibling is wrapped
`engine/src/handlers/helpers/panel-contract.ts:148` — reaches the same throwing `requireEntry`
that `tallyRefutations` does, and `panel-run.ts:272` states the rule ("errors are returned, never
thrown"). Wrap it.

### A7: empty stdin to `store-review-findings` reads as "the operator dismissed everything"
`engine/src/handlers/helpers/store-review-findings.ts:150` — moves every finding to
`refuted_findings` under `manual-override`, writes `critical_findings: []`, sets
`review_status: "passed"`, and logs `0 critical, 0 advisory`, indistinguishable from success.
Guard the empty-input case.

### A8: a block entry whose severity disagrees with its marker line is recorded twice
`engine/src/core/review-output.ts:318` — the carry-over pool is keyed by the *block draft's*
severity, so it never matches the marker pool. One defect becomes two records at two severities;
the advisory copy can be dismissed while the critical copy blocks. Match carry-over by claim, not
by (claim, severity).

### A9: platform `join` builds paths a `posix.join` validator compares for exact equality
`engine/src/core/review-panel.ts:29` — `panel-kernel.ts:25-31` spells out why this must be posix
("a separator that varies with `process.platform` makes 'the same path' a machine-dependent
question inside a module that declares itself pure"). The kernel got the fix; its sibling
serializer did not.

### A10: `RefutedFinding.refutations` documents an invariant a type already expresses
`engine/src/types.ts:193` — "Never empty" in a comment, while `NonEmptyRefutations` exists, is
proven on write (`tallyRefutations` destructures `[head, ...tail]`) and on read
(`parseStoredRefutation`), and is used by every in-flight shape. Move it to `types.ts` and use it.

### A11: `blockStatus` + `carriedOver` should be one discriminated union
`engine/src/core/review-output.ts:92` — `carriedOver` is documented "Non-zero only for `partial`"
but `chooseSource`'s `superseded` branch sets it and `blockStatusNote` prints it.
`{ blockStatus: "absent", carriedOver: 5 }` is representable.

### A12: the load boundary proves every `Task` union field and neither `wave_gates` nor `spec_check`
`engine/src/state-manager.ts:189` — the "single blessed cast" asserts both without proof.
`wave_gates["1"] = { reviews_complete: "no" }` loads clean and `validate-task-execution`'s
`!gate.reviews_complete` reads it as truthy — the previous-wave review gate silently stops
blocking. `parseSpecCheckVerdict` exists and the load path never calls it.

### A13: prose and comment drift (11 sites)
- `agents/{code-reviewer,comment-analyzer,pr-test-analyzer,silent-failure-hunter,type-design-analyzer}.md`
  — "a short block is discarded … but the locations are [lost]" contradicts `chooseSource`'s
  `superseded` branch, which recovers unnamed entries **with** file/line.
  `commands/review-pr.md` was corrected on this branch; these five kept the old wording.
- `agents/code-simplifier.md:143` — same class, softer.
- `docs/migration-claude-code-to-pi.md:1056` — "21 agent definitions" omits the four this branch adds.
- `docs/migration-claude-code-to-pi.md:1456` — "All 11 helper handlers"; `KNOWN_HANDLERS.helper` routes 15.
- `commands/loom.md:272,289,606,707` + `commands/wave-gate.md:245` — still name the spawn tool `Task`
  after this branch's Task→Agent rename.
- `engine/src/core/findings.ts:33` — "Two further lockstep writers live in handlers" omits
  `sanitizeDecomposedTask` while the same header cites "all five writers".
- `engine/src/core/review-output.ts:10` — module header generalizes past `chooseSource`: the
  advisory bar deliberately ignores `advisoryCount`.
- `README.md:395` — "Review agents (parallel per task at wave gate)" lists `code-simplifier` and
  `spec-check-invoker`, neither spawned per task.
- `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:9` — "Every early return logs" is
  false for the `!isReviewAgent` return.

### A14: three false-passing assertions in `smoke-review-panel.sh`
`:200` grep on a possibly-absent `brief.json` exits 2 and takes the success branch; `:241` greps
`"is missing finding"`, also a substring of the *manifest* diagnostic; `:237` claims a verifier can
neither invent nor skip a finding but only tests *skip*.

### A15: unreachable-in-tests core rules
`panel-kernel.ts:221,223` (manifest filename/path uniqueness — both deletable with the suite
green), `panel-kernel.ts:294` (`selectLenses`' documented minimum-panel behaviour),
`panel-kernel.ts:315` (`sanitizeProse` with no injection-shaped input),
`panel-contract.ts:462` (`compareRankings` never shown to be a total order),
`utils/agent-transcript-path.ts:76` (the `SLUG_MAX` prefix-scan branch, both arms).

### A16: the replay guard reads the graph outside the lock
`engine/src/handlers/helpers/review-panel.ts:381` — two concurrent tallies both pass it. Converges
safely via the throw in `applyFindingOutcomes`, but surfaces as the wrong diagnostic — the exact
thing `replayedOutcomes` exists to prevent.

### A17: three `review-output.ts` branches survive mutation
`:232` (next-heading trim), `:284` (`scraped.critical.length` in `claimedCritical`), `:481`
(`Math.max` in `reviewResolutionLog`), `:317` (advisory-side carry-over from a losing block).

### A18: `panel-run.ts` has no test file
All 11 exports reached only via `spawnSync`. Most consequential untested branch: `:127` — the
parent-directory symlink escape, the only containment check a per-file symlink test cannot catch.

### A19: a literal NUL byte hides a 447-line test file from `grep -r`
`engine/tests/core/findings-round14.test.ts:258` — GNU grep classifies the file as binary and
skips it, which will make future reviewers under-score the coverage it actually provides.

### A20: `tallyRefutations` properties are fixed at 3 lenses × 2 findings
`engine/tests/core/review-panel.test.ts:676` — no generation over panel size paired with
`defaultRefutationThreshold(N)` (the shrunken-panel interaction the comments describe at length),
and no permutation invariance over the verdicts array, which the architecture side does have.

---

## Found during remediation (not reported by any reviewer)

### The derived view had the right COUNT and the wrong ORDER
`engine/src/core/findings.ts` — `applyFindingOutcomes` built the two `string[]`
views with `removeOnce(oldView, removedClaims)`. `removeOnce` deletes the FIRST
occurrence of a claim while `kept` deletes the one at the refuted INDEX, so two
findings wording a claim identically — which the multiset comparison exists
precisely because reviewers do — left the view in a different order than the
array it summarizes. Findings `[!, B, !, B]` with the SECOND `B` refuted gave
array `[!, B, !]` and view `[!, !, B]`.

`findingsLockstepError` compares as a multiset, so the load boundary accepted it
and nothing failed — but `--fix` re-derives the views from `findings`, so the
next repair rewrote the state file to no purpose, and any reader pairing the two
by position reads one finding's claim against another's identity.

Surfaced by the repo's own lockstep property at roughly 1 run in 3000; the
default 100 runs almost never reach it, and its 6-character random claims
collide too rarely. **Confirmed pre-existing** by reproducing it against a clean
checkout. Fixed by deriving the view from `kept` and appending only the orphans
`removeOnce` was really there to conserve, then pinned with a three-claim
alphabet that makes duplicates the common case rather than the rare one.

---

## Deferred

Each of these is real; each is a redesign rather than a fix, and none of them is
a hole a wave gate can fall through today.

### `WaveGate` as an ADT (type-design-analyzer, architecture-agent)
Four independent booleans, one of them tri-state, ≈24 states of which most are
illegal — and `applyGateDecision` really does produce
`{impl_complete: false, tests_passed: true, reviews_complete: true}`. The ADT is
the right shape and `newWaveGate()` already funnels construction.

**Why deferred:** `wave_gates` is PERSISTED state. Changing its shape needs a
migration for task graphs that exist on disk mid-run, which is a larger and
riskier change than anything else in this round. **The exploitable part is
closed instead**: A12 proves every gate field at the load boundary, so the
drifted `{reviews_complete: "no"}` that silently disabled the previous-wave
review block is now a hard rejection.

### Branding `Finding.id` and `BriefFinding.claim` (type-design-analyzer)
"`attributeFindings` is the only constructor of `Finding`" is a comment, while
`CandidateFilename` and `WaveFindingId` — two less consequential ids in the same
codebase — carry real phantom brands. Same for `sanitizeProse` → a
`SanitizedProse` brand.

**Why deferred:** `Finding` is threaded through ~10 modules, every test fixture,
and the persisted state shape; the brand has to be minted at each parse boundary
and re-minted after every repair. Worth doing as its own change, not folded into
a remediation round.

### An engine-authored architecture manifest (architecture-agent)
`handlers/helpers/panel-contract.ts` already derives the exact expected candidate
set before it validates the manifest, so the orchestrator-authored manifest is
avoidable — and avoiding it would delete the prose copy of the lens-selection
algorithm in `commands/loom.md` Step 2 and its re-spawn-with-diagnostics retry
loop.

**Why deferred:** this rewrites a runbook phase and the templates bound to it by
`runbook-contract.test.ts`. It is a design change to `/loom --panel`, and it
belongs in a change that can be reviewed as one.

### Folding the manifest key names into `RunLayout` (architecture-agent)
`RunManifestSpec`'s six naming fields are declared in `panel-contract.ts` and
`review-panel.ts`, separately from the `ARCHITECTURE_LAYOUT` / `REVIEW_LAYOUT`
they must agree with — recreating one level up the hardcode-vs-constant split
`RunLayout` was extracted to end. A cohesion improvement with no defect behind
it.

### `viewsOf(task)` replacing the two `string[]` views (type-design-analyzer)
The endgame for the lockstep invariant: make it unrepresentable rather than
load-checked. `types.ts` already anticipates it. It touches all five writers and
~10 read sites and is the natural sequel to the view-order fix above.

### A purity lint rule for `engine/src/core/**` (architecture-agent)
Five of fourteen modules in `core/` do fs I/O and import `config` (which
`execSync`es at module load), while five new siblings assert purity in a
docblock, with nothing distinguishing them. `lint-rules/` ships eleven rules and
none is a layering rule.

**Why deferred:** the rule is easy; the honest version needs an allowlist for the
five legacy modules, and agreeing that allowlist is a design conversation about
what `core/` means.

---

## Out of scope: a pre-existing flake in the gate this round wired up

`engine/tests/linter/index.test.ts:443` ("handles very large file") fails
intermittently — observed once in roughly eight full-suite runs, never when run
alone. `lintFile` enforces a **50 ms** deadline (`src/linter/index.ts:35`) and
fails closed to `kind: "error"`; under parallel load a 10,000-line file exceeds
it, which is the linter behaving correctly and the test asserting a timing
assumption.

`src/linter/` and `tests/linter/` are **not in this branch's diff** — this
predates the panel work and is untouched by this round. It is called out because
C10 just made `npm test` the gate that runs it, so the flake now costs a red
gate rather than nothing. Fixing it means either raising the deadline (a
production behaviour change) or making the test deterministic; both are
decisions for the linter's owner, not this remediation.

---

## Validation (as run)

```
$ bunx tsc --noEmit                    # clean
$ npm test                             # vitest 2358 passed (112 files)
                                       # smoke-panel-mode.sh   PASS: 22  FAIL: 0
                                       # smoke-review-panel.sh PASS: 19  FAIL: 0
```

Every fix above was additionally **mutation-verified**: the defect was
re-introduced into a backup-restored working tree and the suite confirmed RED,
for all ten of the load-bearing changes (Pi import, dedup re-mint, view order,
replay guard, stale-wave guard, claim identity on both arbitration branches,
`wave_gates` parsing, the transcript-path resolver, the unknown-task guard, and
the empty-stdin override guard). Two first-pass mutations were too weak — a
partial revert that left the other half of the fix in place — and were
strengthened until they bit.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit
cd engine && npx vitest run
bash scripts/smoke-panel-mode.sh && bash scripts/smoke-review-panel.sh
```
