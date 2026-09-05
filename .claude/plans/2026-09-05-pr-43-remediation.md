# PR #43 Remediation — Requirement Coverage Projection

**Branch:** `feat/structural-spec-check` (worktree `/home/peterstorm/dev/claude-plugins/loom-structural-spec-check`, head `8a9c07f`)
**PR:** <https://github.com/peterstorm/loom/pull/43> — *feat(spec-check): structural Requirement Coverage Projection (#11 phase 3)*
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260905T114355Z-14128`
**Result:** 24 surviving criticals (all upheld), 0 refuted, 44 advisories.
**Panel:** 3 lenses — `reproduction`, `intent`, `security`. Every critical upheld; the one security refutation (`comment-analyzer-6`) lost 2–1.

## Exact frozen scope (22 paths)

CONTEXT.md, commands/spec-check.md, engine/src/core/parse-spec.ts, engine/src/core/requirement-coverage.ts, engine/src/core/wave-review-authority.ts, engine/src/handlers/helpers/populate-task-graph.ts, engine/src/handlers/helpers/programs/wave-gate.ts, engine/src/handlers/subagent-stop/store-spec-check-findings.ts, engine/src/linter/programmatic/no-cross-boundary-imports.ts, engine/src/orchestration/spec-index-observation.ts, engine/src/orchestration/wave-spec-check-documents.ts, engine/src/parsers/index.ts, engine/src/types.ts, engine/tests/core/parse-spec.property.test.ts, engine/tests/core/parse-spec.test.ts, engine/tests/core/requirement-coverage.property.test.ts, engine/tests/core/requirement-coverage.test.ts, engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts, engine/tests/handlers/helpers/wave-spec-check-scope.test.ts, engine/tests/handlers/populate-task-graph.test.ts, engine/tests/spec-template-contract.test.ts, pi/subagent-result.ts

---

## The 24 criticals deduplicate into 9 defects

The reviewers converged hard: five independent reviewers found the same Step-5 hole, four found the same drifted-row contradiction, three found the same missing Requirement text. Every fix below is mandatory.

### D1 — The projection does not carry Requirement text
*code-reviewer-1, comment-analyzer-1, architecture-tech-lead-3*

`renderRequirementCoverage` emits `taskId | claim | severity | claimVerdictMessage`, and every branch of `claimVerdictMessage` interpolates `entry.id` only. `SpecEntry.content` reaches the rendered text for exclusions and the glossary and nothing else — yet `commands/spec-check.md:112` tells the Agent "the projection carries it; you do not need to re-find it in the spec", and Step 2 forbids grepping the spec for identifiers. The one class of row a model actually decides is decided without the Requirement's text.

**Fix:** carry `entry.content` into the rendered row. The data is already in hand at the render seam.

### D2 — Unclaimed Acceptance Scenarios are never rendered; Step 5's registered path is a no-op
*code-reviewer-2, silent-failure-hunter-3, comment-analyzer-2, architecture-tech-lead-4, code-simplifier-2*

`unclaimed` is `index.frs.filter(...)`, typed `readonly SpecEntryId<"FR">[]`. No section of the render enumerates Acceptance Scenarios. So "each `AS-NNN` the projection lists that has no row of its own" is empty **by construction**, and the registered path checks nothing — while `main`'s Step 5 grepped `Given … When … Then` and assessed each. The registered path is now weaker than the standalone one.

**Fix:** add `unclaimedScenarios: readonly SpecEntryId<"AS">[]` from the same `claimedAnywhere` join over `index.scenarios`, render it as its own section, and point Step 5 at it.

### D3 — `parseWaveSpecCheckScope` requiring `modifiedFiles` breaks every pre-upgrade packet
*code-reviewer-3*

`exactObject` demands an exact key-set match, so a `specCheckScope` entry published by the previous engine (5 keys) decodes as `corrupt` → `waveBlocked`. The same module already maintains dual-shape decoding for exactly this reason twice over (`specCheckDocuments`, `workspaceHeadSha`).

**Fix:** accept both key sets, defaulting `modifiedFiles` to `[]` when absent.

### D4 — Nothing enforces the settled verdicts; the gate trusts the Agent's self-reported count
*silent-failure-hunter-1, architecture-tech-lead-1*

`projectRequirementCoverage` decides four verdict classes and `claimSeverity` stamps them CRITICAL. The rows are encoded into packet bytes and **never read back**. `reconcileSpecCheck` validates the Agent's transcript only against itself. An Agent that omits a settled row and emits `SPEC_CHECK_CRITICAL_COUNT: 0` opens the Wave Gate. The packet's "they are not yours to overturn" is instructions, not a gate — and `claimSeverity`'s own JSDoc claims the opposite ("an Agent cannot soften a structural refutation by describing it differently").

**Fix:** carry the settled CRITICAL count as engine authority and floor the reconciled count at it; a report below the floor fails evidence capture rather than passing.

### D5 — A malformed stored hash is reported as "no hash was recorded"
*silent-failure-hunter-2, type-design-analyzer-2*

`parsedAnchorHashes` drops a value `parseSpecContentHash` rejects; `driftOf` then yields `unverifiable`, whose rendered sentence is literally false for a Task that did record one — and severity drops from MEDIUM to CANDIDATE. `spec_anchor_hashes` lives in hand-editable protected state and is unvalidated on load, so this converts a tamper signal into a benign, legacy-looking message.

**Fix:** a fourth `DriftFact` variant for a recorded-but-unreadable hash, graded CRITICAL, with its own rendered text.

### D6 — Drifted rows are labelled settled but still need behavioural assessment
*type-design-analyzer-1, comment-analyzer-5, architecture-tech-lead-2, code-simplifier-1*

`claimSeverity` grades a `candidate-pass` with drifted text as MEDIUM; the rendered header says CRITICAL and MEDIUM rows are settled and "Assess only `CANDIDATE` rows"; `commands/spec-check.md:106` says to assess that exact row. Two authoritative texts contradict each other about the one Requirement whose spec text moved after the claim.

**Fix:** split settlement from severity. Settlement is derived from the verdict kind and rendered as its own column; the command defers to the packet instead of restating the rule.

### D7 — The UNAVAILABLE render drops exclusions and glossary while Steps 6/7 forbid grepping
*silent-failure-hunter-4, comment-analyzer-3, comment-analyzer-4*

Steps 6 and 7 state unconditionally that the projection carries the glossary and the exclusion list, and forbid re-extracting them. Neither exists on the standalone path (no packet) or in the UNAVAILABLE branch. Terminology and scope-creep checks go dark exactly when the specification is least trustworthy — and unlike Steps 2 and 5, neither step has a fallback.

**Fix:** give Steps 6 and 7 the same explicit standalone/UNAVAILABLE fallback Steps 2 and 5 already carry.

### D8 — The `batchEpoch` exclusion comment states something false
*comment-analyzer-6 (upheld 2–1)*

The comment claims "every input the projection reads … is already an epoch input". `spec_anchor_hashes` is absent from the epoch payload, and `unclaimed` depends on `spec_anchors` of tasks in every Wave while `batchEpoch.tasks` is the current-Wave roster.

**Fix:** state the actual argument — the packet digest covers the rendered projection, so epoch coverage of projection inputs is not required — instead of asserting a completeness the payload lacks.

### D9 — Three untested guards, and an unescaped render
*pr-test-analyzer-1, -2, -3 (plus advisory code-reviewer-7)*

The test analyzer mutation-tested the diff and found **ten mutations that leave the whole suite green**. The three critical ones: a claim string containing a pipe or newline can forge extra rows in a table the packet declares non-overturnable authority (and `spec_anchors` come from the untrusted decompose payload, validated only as non-empty strings); the `specIndexPath` guard has no test; the malformed-hash drop has no test.

**Fix:** escape table cells at the render seam, and add the missing tests — including every one of the ten mutation-surviving cases.

---

## Advisory dispositions (44)

**Accepted — subsumed by a critical fix, no separate work:** code-reviewer-4 and comment-analyzer-9 (→D5); code-reviewer-5 and type-design-analyzer-7 (→D8); silent-failure-hunter-8 (→D3); comment-analyzer-11 (→D6); code-reviewer-7 (→D9).

**Accepted — fixed in this remediation:**
- `pr-test-analyzer-4…-11` — every mutation-surviving test gap: `hashArb` cannot reach `stable`; the `stable` message unasserted; `waveSpecCheckScope.modifiedFiles` never non-empty; the exclusion/glossary render sections deletable; the in-lock `spec_file` guard untested; `unreadable` indistinguishable from the other reasons; `modifiedFiles` validation untested; the "every FR claimed" branch unasserted.
- `type-design-analyzer-3` / `code-simplifier-5` — drop `| null` from `CoverageTask.anchorHashes`.
- `type-design-analyzer-4` / `code-simplifier-4` — drop the unread `hash` from `DriftFact.stable`.
- `type-design-analyzer-6` / `architecture-tech-lead-5` / `code-simplifier-3` — one owner for `WaveSpecCheckObservation`.
- `type-design-analyzer-5` / `comment-analyzer-7` — carry the spec digest in the `indexed` variant and compare digests, making the "one read" claim true instead of asserted.
- `type-design-analyzer-8` — keep the `SpecContentHash` brand to the persistence edge.
- `code-reviewer-6` / `pr-test-analyzer-10` — align the decoder's `modifiedFiles` validation with what the state schema accepts.
- `comment-analyzer-8` — "planned by nobody" ignores Contributions; reword.
- `comment-analyzer-10` — "all three" against four settled branches.
- `silent-failure-hunter-7` — an all-unclaimed Wave renders with no severity.
- `code-simplifier-6` — the `observation` parameter shadowed twice inside its own function.
- `code-simplifier-7` — ten assertions doing inference's job.
- `code-simplifier-9` — the parse→availability mapping duplicated across both observers.
- `code-simplifier-10`, `-11`, `-12` — the CONTEXT binding test's ceremony, the vacuous severity property, the two identical populate tests.
- `code-simplifier-13` / `architecture-tech-lead-10` — hoist the registered/standalone branch instead of re-opening it in five steps.
- `architecture-tech-lead-8` — **the contract test binding `commands/spec-check.md` to the renderer**, on the model of `spec-template-contract.test.ts`. Highest-value single item: it would have refuted D1, D2 and D6 at authoring time.
- `architecture-tech-lead-9` — write down the rule the `parsers/`→`core/` move established.

**Deferred — with reason:**
- `architecture-tech-lead-6` (two parallel Task→row mappers) and `architecture-tech-lead-7` (`prepareWaveReviewBatch` is now the packet-seam god function). Both are interface changes across the batch seam — `deepen` territory, named as such by the reviewer. Deferring keeps this remediation reviewable; they belong with the `waveSpecCheckSections` extraction.
- `silent-failure-hunter-5` (persist the decompose-time degradation reason on the graph). Real operator gap, but the fix is a new persisted TaskGraph field, and a schema addition wants its own design pass rather than riding a remediation.
- `silent-failure-hunter-6` (a `claimed-before-defined` drift variant). D5 already adds one drift variant for a reachable, demonstrated case; a second for a scenario nobody reproduced is speculative.

**Dismissed — with reason:**
- `code-simplifier-8` (`claimSeverity`/`claimVerdictMessage`/`ClaimSeverity` exported with no production caller outside the module). D4 gives all three a real production consumer in the enforcement path, so the export surface stops being speculative. The advisory was correct when written and is resolved by a critical fix rather than by narrowing the surface.

---

## Refuted findings audit

**None — all 24 criticals were upheld.** One partial dissent is worth recording: on `comment-analyzer-6` the `security` lens voted `refuted`, arguing `waveGateAuthorityDigest` is a SHA-256 over the complete TaskGraph and `batchEpoch` includes `registration.authorityDigest`, so `spec_anchor_hashes` and other-Wave `spec_anchors` are epoch inputs *transitively*. `reproduction` and `intent` both upheld, noting the resume path recomputes against a refreshed graph while carrying the persisted registration digest — so the transitive coverage is as-of-registration, not current. The finding survives 2–1, and D8's fix states the real argument, which satisfies both readings.

## Validation

```
cd engine
bunx tsc --noEmit && npm run typecheck:unused
npx vitest run --testTimeout=15000 --maxWorkers=4
env -u PI_CODING_AGENT bash ../scripts/smoke-panel-mode.sh
env -u PI_CODING_AGENT bash ../scripts/smoke-review-panel.sh
env -u PI_CODING_AGENT bash ../scripts/smoke-standalone-review.sh
env -u PI_CODING_AGENT bun ../scripts/smoke-orchestration-facades.ts
env -u PI_CODING_AGENT bash ../scripts/smoke-pi-resources.sh
bash ../artifacts/tests/test-validate-task-graph.sh
```

Plus the full-tier lint over every changed file, `git diff --check`, and a re-run of the ten mutations the test analyzer found surviving — each must now fail a test.
