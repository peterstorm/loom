# Plan Alignment Report

**Spec:** /home/peterstorm/dev/claude-plugins/loom/.claude/specs/2026-10-16-g4-slice-2-oracle/spec.md
**Plan:** /home/peterstorm/dev/claude-plugins/loom/.claude/plans/2026-10-16-g4-slice-2-oracle.md
**Date:** 2026-10-16

## Summary

4 gaps found. The three earlier ownership gaps (INV-6, INV-7, INV-8) are fixed. The gaps below are new: one executable-models gap on lifecycles, one on the pipeline, one invariant-ownership gap, and one under-specified requirement.

## Gaps

- **MODEL-1** — The plan has no `## Lifecycles` section, but it describes a per-agent block counter lifecycle in prose (AD-10). A counter increments only when its check contributes failures to a block, it reaches the cap of 3 and then fails open, and it clears when the stop proceeds. The Pi write grant also has states (issued, consumed, rejected, absent), and each state decides whether the child records anything (AD-8, AS-039). Both are stateful, with transitions an implementer must get right. They should be declared as lifecycles with their states and transitions.
- **MODEL-2** — The Data Flow section lays out ordered pipelines: tool call, then `HarnessToolCall`, then `extractEvidence`, then `recordToolEvidence`, then ledger; and ledger, then `LedgerObservation`, then `judgeRedThenGreen`, then proof. The plan has no `## Pipeline` section and no explicit decline. Please add a `## Pipeline` section, or state that it is declined and why.
- **OWN-1** — INV-2 (one test-file classifier) lists four sibling entry points, but it omits `engine/src/handlers/helpers/exact-implementation-settlement.ts`. The Data Flow section calls `classifyTaskFiles(file_list, frozen testFiles)` ahead of `judgeRedThenGreen`, and the judge's signature takes a ready `TestFileClassification`. So the settlement shell is the site that classifies and is where the rule is applied. `verification-manifest.ts` also applies the default suffix list when it freezes `testFiles`. Both sites should be listed, or the plan should say that `red-then-green.ts` classifies. The two plan statements disagree today.
- **GAP-1** — FR-005 and AS-017 need a post-feature TaskGraph to owe I6 even when the operator's manifest is schema-1 or lacks the new keys. AD-4 derives the era only from the presence of `testFiles` on `graph.verification_manifest`, and `redThenGreenEra` accepts `undefined`. The plan does not say whether population always freezes a manifest, with the engine-default `testFiles`, when the repository has no manifest file at all. If it does not, such a graph is `not-owed` and FR-005 is silently unmet. The plan needs to state this case, or reject it explicitly.

## Supporting Documents Checked

- `.claude/specs/2026-10-16-g4-slice-2-oracle/brainstorm.md` — 5 discoveries checked, none contradicted. The five are: TestRun facts hold only `{command, exit, report}`; `planStopCheck` is the single planner; runners are limited to 120 s and the hook budget to 300 s; the manifest schema must change additively; the soundness limit must be documented. The plan honors each of them (AD-2, AD-9, AD-10, AD-4, T11). The brainstorm's Pi-has-no-ledger gap is honored by AD-8.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| FR-001..FR-004 | Per-file TestRun results, read-back, legacy facts | Covered (AD-2, T4, INV-8) |
| FR-005 | I6 owed only by non-claimant `newTests: required` Tasks in post-feature graphs | Gap (GAP-1) |
| FR-006..FR-010, FR-012 | I6 judgment, trust, named gaps, claimants, purity | Covered (AD-5, AD-6, T7) |
| FR-011 | I6 decided at completion only | Covered (AD-6) |
| FR-013, FR-014 | Test-file classification and its frozen pattern | Covered (AD-12, AD-4); see OWN-1 |
| FR-015..FR-017 | `affectedRunner` manifest entry, freeze, additive schema | Covered (AD-4, T5) |
| FR-018..FR-026 | I7 stop check: changed files, block, fail-open, counters, lock, budget, isolation | Covered (AD-9, AD-10, INV-3, INV-7); see MODEL-1 |
| FR-027..FR-029 | Single planner, plan view, helper stays read-only | Covered (AD-9, AD-11) |
| FR-030 | Docs | Covered (T11) |
| FR-031..FR-035 | Pi ledger capture, shared minting rule, mv/cp | Covered (AD-8, T6, INV-4); see MODEL-1, MODEL-2 |
| NFR-001, NFR-002 | Pure core, same facts on both harnesses | Covered |
| AS-001..AS-004 | Per-file results | Covered (T4) |
| AS-005..AS-014 | I6 scenarios | Covered (T7, T9) |
| AS-015..AS-019 | Manifest, classification | Covered (T5), except that AS-017 depends on GAP-1 |
| AS-020..AS-031 | I7 scenarios | Covered (T10) |
| AS-032..AS-034 | Plan view | Covered (T8, T10) |
| AS-035 | Docs and soundness limit | Covered (T11) |
| AS-036..AS-041 | Pi recorder scenarios | Covered (T6, T9, T10) |
| SC-001..SC-007 | Success criteria | Covered by the matrix tests and property tests |
| US1..US8 | User stories | Covered |
| OOS-001..OOS-011 | Out of scope | Not flagged |

## Resolution (architecture loop-back 2, 2026-10-16)

- **MODEL-1:** Neither one is a lifecycle; both are bounded mechanics, and AD-10 and AD-8 now say so.
  - **Block counter (AD-10):** a 0–3 integer per agent and per check. Its whole transition rule is the pure `stopCheckBlockDecision` in `engine/src/core/affected-stop-check.ts` (T8), pinned transition by transition in `engine/tests/core/affected-stop-check.test.ts`.
  - **Write grant (AD-8):** pre-existing states owned by `pi/write-grant.ts` and `pi/child-write-grant.ts`, which this feature does not change. The recorder's only decision is the pure `piEvidenceTarget` in `pi/evidence-recorder.ts` (T6), with one case per grant state in `engine/tests/pi/evidence-recorder.test.ts`.
- **MODEL-2:** The Data Flow section now declines the fugue Pipeline bridge explicitly. The flows are function composition inside one hook process, not a multi-stage pipeline, and Loom does not use fugue.
- **OWN-1:** INV-2's siblings now include `exact-implementation-settlement.ts`, the one place that calls `classifyTaskFiles` before the judge, and `verification-manifest.ts`, which applies the default suffixes at freeze. `red-then-green.ts` was removed from the list (it receives a ready classification, AD-5), and so was the plan view. The Statement now says where the split happens. The INV-2 rule is unchanged, since every sibling complies by importing `DEFAULT_TEST_FILE_SUFFIXES`.
- **GAP-1:** Checked in the code: population always freezes a manifest, because `populate-task-graph.ts` maps ENOENT to `defaultVerificationManifest()`. AD-4 now states that every post-feature freeze carries `testFiles`, including an operator manifest without the key, a schema-1 manifest and no manifest file, which freeze the engine-default suffixes. T5 owns that change.
  - To protect old graphs' suite receipts, T5 adds `legacyDefaultVerificationManifest()` with today's digest, used for the read-time fallbacks.
  - INV-6's era matrix has rows (a)–(f), covering all four post-feature freeze cases and the two pre-feature shapes. FR-005 and AS-017 are met.
