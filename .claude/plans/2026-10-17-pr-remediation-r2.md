# PR #99 remediation, round 2 — G4 slice 2 (I6, I7)

- **Branch:** `feat/g4-slice-2-oracle` → `main` (PR #99)
- **Date:** 2026-10-17
- **Workflow:** `/loom:review-and-fix 99`, second round, after round 1 (`0a493aa2`,
  plan `.claude/plans/2026-10-17-pr-remediation.md`)

## Scope

The same six-slice partition as round 1 (the whole PR is over the 240,000-unit
read-coverage budget), each slice re-frozen at the round-1 head. Slice s4 also takes
the two test-side files round 1 created (`engine/tests/fixtures/type-equality.ts`,
`engine/tests/handlers/helpers/claude-live-attempt-evidence.test.ts`). Planning
artifacts under `.claude/plans` and `.claude/specs` stay out of review scope, as in round 1.

| Slice | Review run | Policy run | Disposition digest | Criticals (surviving / refuted) | Advisories |
|---|---|---|---|---|---|
| s0 | `rf-20261017-pr99-r2-s0` | `rf-20261017-pr99-r2-s0-policy` | `8a7eaa952742cb43ba522e40c718e815bd2d8a92bb88c1821265e27cc8f924d5` | 0 / 0 | 16 |
| s1 | `rf-20261017-pr99-r2-s1` | `rf-20261017-pr99-r2-s1-policy` | `cb96dc16539309b1dc6398c5c66a607706e5b7c4011398755fa12c45a60ab07d` | 0 / 0 | 12 |
| s2 | `rf-20261017-pr99-r2-s2` | `rf-20261017-pr99-r2-s2-policy` | `90f28ff02457700b4bcd160173bdb234a43b922cce37fffd041fd993018e4b49` | 0 / 0 | 8 |
| s3 | `rf-20261017-pr99-r2-s3` | `rf-20261017-pr99-r2-s3-policy` | `7f44485f13e68d8c1786d15df34a40ba8cab468db94b9ee3e8ceb9f69ed578bd` | 0 / 0 | 6 |
| s4 | `rf-20261017-pr99-r2-s4` | `rf-20261017-pr99-r2-s4-policy` | `0e43c397cbcc31d657772643f3b6584d8c5b983d55ae7f1378b151222d65db66` | 0 / 0 | 5 |
| s5 | `rf-20261017-pr99-r2-s5` | `rf-20261017-pr99-r2-s5-policy` | `ec38d5ba40e2492793a76315ae191210f039f1d5f2a36768403099b481e0fcd6` | 0 / 0 | 12 |

Runs root: `.claude/reviews/review-and-fix-runs`. 38 reviewer requests, all admitted.
One retry: s5's type-design-analyzer attempt 1 was refused for read coverage (two
files' diffs unread); attempt 2 was admitted.

## Criticals

None surviving and none refuted in any slice. Defect-family accounting:
`{"kind":"not-required"}`. No Repair Group, sibling disposition, check ID or
Historical RED declaration applies.

## Advisory dispositions (59: 21 accepted, 35 deferred, 3 dismissed)

All `DECLARED`, each policy run an initial revision. **Deviation:** the Skill
publishes advisory decisions before editing; this round the accepted fixes were
implemented first and the policy runs published after, before validation and
remediation. The decisions recorded are the ones the edits implement.

| Finding | Decision | Reason |
|---|---|---|
| s0:code-reviewer-1 | accepted | Verified against real git: `git restore --source X -- a b` exits 1 and restores nothing when a listed file did not exist at X. The remedy is now one shell-quoted loop that restores each file the baseline has and deletes each one it lacks; a real-git test proves it and that it mints no FileWrite. |
| s0:code-reviewer-2 | accepted | ADR-0027's normalized-call bullet now lists exited / exit-unknown / interrupted, matching BashToolOutcome. |
| s0:silent-failure-hunter-1 | deferred | Naming parse-rejected in-repository paths needs a new ChangedFiles arm, a CT-2 contract change; the check fails open and is not evidence. Deepen candidate with the changed-files contract. |
| s0:type-design-analyzer-1 | deferred | FrozenStopCheckManifestFields has consumers (tests read testFiles/affectedRunner through it); moving FrozenTestFiles to one owner is the leaf-contract-types deepening deferred in round 1. |
| s0:type-design-analyzer-2 | deferred | Splitting no-changed-files into two arms changes the CT-2 AffectedOffReason contract and its renderers; deepen candidate. |
| s0:type-design-analyzer-3 | deferred | Deriving StopChecksBlockParts from the decision changes the stopCheckBlockDecision return type; deepen candidate (stop-check ports and decision family). |
| s0:type-design-analyzer-4 | deferred | The I6 era sum type is ADR-0025's recorded follow-up, deferred in round 1. |
| s0:comment-analyzer-1 | accepted | The harness-tool-call header now says only the Claude adapter degrades to exit-unknown; Pi reads isError as exit 1 or 0 and an unrecognised result as exit 0. ADR-0027 says the same. |
| s0:architecture-tech-lead-1 | accepted | One exported isCollectionErrorTestcase in structured-test-report.ts (owner of ReportTestcase) now serves the affected judge, the acceptance gate and the per-file projection. |
| s0:architecture-tech-lead-2 | deferred | A Record<StopCheckName, counter port> changes the CT-2 StopChecksPorts interface and every adapter and fake; the stop-check ports deepening deferred in round 1. |
| s0:architecture-tech-lead-3 | deferred | One owner for era and duty is the INV-6 era sum type deepening deferred in round 1 (ADR-0025 follow-up). |
| s0:code-simplifier-1 | accepted | Real wrongness: an inherited key such as 'constructor' resolved to a prototype function and normalized returned undefined. toolOf now reads own keys only; a regression pin in the INV-4 matrix fails without the fix and passes with it. |
| s0:code-simplifier-2 | deferred | Folding CAP_NOTE/UNREADABLE_NOTE narrows the exported StopCheckBlockCaps type, which the reviewer itself calls deepen territory. |
| s0:code-simplifier-3 | accepted | judgeAffectedRun now filters failed testcases then maps them; same order and results. |
| s0:code-simplifier-4 | accepted | affectedOffDetail is extracted, so affectedLines reads as heading plus one line group per view kind. |
| s0:code-simplifier-5 | accepted | redThenGreenDuty's testFiles read is documented as INV-6's sanctioned consumer: the frozen Proof has already decided the duty, and the read only fetches the classification value. |
| s1:silent-failure-hunter-1 | deferred | The plan helper cannot tell a Pi run from a Claude run, and Pi epochs are not readable from a helper process; naming that gap needs a harness-aware LiveAttemptEvidence arm. Deepen with the Pi epoch address work. |
| s1:type-design-analyzer-1 | deferred | Making the manifest parameter required changes an exported signature and six call sites outside this PR; the sole production caller already passes it. Deepen with the era owner. |
| s1:type-design-analyzer-2 | deferred | The restated per-file types and the optional files field are the leaf-contract-types and summary sum-type deepenings deferred in round 1. |
| s1:type-design-analyzer-3 | deferred | Making ProofObligationInput.redThenGreen required is part of the era sum type deepening (ADR-0025 follow-up). |
| s1:architecture-tech-lead-1 | deferred | A counts-only versus per-file summary union, with legacy bytes moved to the ledger codec, is the summary sum-type deepening deferred in round 1. |
| s1:architecture-tech-lead-2 | deferred | A single import-free leaf module for the restated contracts is the leaf-contract-types deepening deferred in round 1. |
| s1:architecture-tech-lead-3 | deferred | Moving arm resolution and settle combination into the core is a module-boundary move; deepen candidate with the stop-check ports. |
| s1:architecture-tech-lead-4 | deferred | A list-sidecars operation beside the sidecar module is a new seam; deepen candidate. |
| s1:architecture-tech-lead-5 | deferred | One phase-aware I6 duty entry point is the era-owner deepening deferred in round 1. |
| s1:code-simplifier-1 | dismissed | The cause-to-message idiom appears inline in 122 engine source files; consolidating three of them is an arbitrary partial move, consistent with round 1's dismissal of the per-module cause idiom. |
| s1:code-simplifier-2 | deferred | Removing the unreachable branch requires stopCheckBlockDecision to return a non-empty block arm, an exported type change; the reviewer itself routes it to deepen. |
| s1:code-simplifier-3 | accepted | One frozen NO_BLOCKS_ISSUED exported from acceptance-stop-check.ts now serves the counter read, the Pi report-only ports and the stop shell. |
| s2:silent-failure-hunter-1 | accepted | extractShellWriteTargets now documents the under-minting direction: other file-creating commands and wrapped heads mint nothing, the logged-facts-only limit machines/README.md records. Widening the head list is deferred with the extract-evidence module work. |
| s2:pr-test-analyzer-1 | accepted | Three findReport tests now pin the all-or-nothing dir rule: a malformed sibling voids the run, failsafe-summary.xml is skipped and the valid reports merge, and a refused report in one module voids the others. |
| s2:type-design-analyzer-1 | deferred | Deleting BashOutcome with the four-argument overload is the extract-evidence shims deepening deferred in round 1. |
| s2:architecture-tech-lead-1 | deferred | Same compat-layer deletion: the extract-evidence shims deepening deferred in round 1. |
| s2:architecture-tech-lead-2 | deferred | A shell-write-targets module is the extract-evidence module split deferred in round 1. |
| s2:architecture-tech-lead-3 | deferred | Bundling graph-level parse context changes the exported taskUnionError signature; deepen with the era owner. |
| s2:architecture-tech-lead-4 | accepted | The machine barrel now exports EvidenceTarget, HarnessToolCall and RecordToolEvidenceFn, the types recordToolEvidence's interface names. |
| s2:code-simplifier-1 | deferred | Same compat-layer deletion: the extract-evidence shims deepening deferred in round 1. |
| s3:architecture-tech-lead-1 | deferred | A shared population fixture is the test-fixture consolidation deferred in round 1. |
| s3:code-simplifier-1 | deferred | The shared era-row fixture belongs to the same test-fixture consolidation. |
| s3:code-simplifier-2 | accepted | The stale T7/T9 sentence is replaced by where the derivation sites and rows (e)-(f) are actually pinned. |
| s3:code-simplifier-3 | accepted | The duplicate trailing-slash row is deleted; every row still runs against both ROOT and ROOT/. |
| s3:code-simplifier-4 | deferred | Shared runner constants belong to the test-fixture consolidation. |
| s3:code-simplifier-5 | accepted | The local report alias is removed; AFFECTED_REPORT is used directly. |
| s4:architecture-tech-lead-1 | deferred | A shared live-stop-attempt fixture is the test-fixture consolidation deferred in round 1. |
| s4:architecture-tech-lead-2 | deferred | Comparing parsed TaskGraphs after a pure normalizer is a test seam change; it fails loudly today, not wrongly. Deferred with the fixture consolidation. |
| s4:code-simplifier-1 | deferred | Same test-fixture consolidation family. |
| s4:code-simplifier-2 | accepted | i6Section and expectInfrastructureBlocked helpers now own the I6 section marker and the infrastructure-blocked assertions; assertion strength is unchanged. |
| s4:code-simplifier-3 | accepted | frozenTestFiles now returns early for the no-file case and shares a testFilesOf helper; no IIFE, same messages. |
| s5:silent-failure-hunter-1 | deferred | A per-epoch loss marker is the recorder-failure marker deepening deferred in round 1. |
| s5:pr-test-analyzer-1 | accepted | issuedGrantTokens is exported and pinned directly (slot-keyed, empty with no owner, session or grant). The full dispatch-to-settlement end-to-end needs a Pi implementation-dispatch harness that does not exist; it is deferred with the Pi grant work. |
| s5:type-design-analyzer-1 | dismissed | The caller does not hold a branded AgentType: subagent-stop passes stripNamespace(result.agent), a raw string, so the parse inside piImplementationLedger is the real boundary parse. |
| s5:comment-analyzer-1 | accepted | machines/README.md now says the phase gate cannot deny a shell write, so it is only ever logged; the transitional 'now' wording is removed. |
| s5:architecture-tech-lead-1 | deferred | Folding piImplementationLedger next to piChildEvidence is the Pi grant union / epoch address deepening deferred in round 1. |
| s5:architecture-tech-lead-2 | deferred | Splitting evidence-recorder's three concerns is the same Pi epoch address deepening. |
| s5:architecture-tech-lead-3 | deferred | Structural INV enforcement is the INV enforcement owner deepening deferred in round 1. |
| s5:code-simplifier-1 | accepted | piResultsField reads details.results once into a results/unusable ADT; the dispatcher derives rawResults and the diagnostic from it. |
| s5:code-simplifier-2 | dismissed | The matrix scan covers engine/src and pi as a test-time oracle independent of the linter run; keeping both is deliberate defence in depth for INV-4, as round 1 settled. |
| s5:code-simplifier-3 | deferred | A shared EMPTY_LEDGER fixture belongs to the test-fixture consolidation. |
| s5:code-simplifier-4 | deferred | Shared parse-or-throw helpers belong to the test-fixture consolidation. |
| s5:code-simplifier-5 | accepted | The loop uses Object.keys. |

## Accepted fixes (as implemented)

- **I6 retry remedy was not runnable for a created file.** `git restore --source X -- a b`
  exits 1 and restores nothing when one pathspec did not exist at X. The remedy is
  now `baselineRestoreCommand(source, files)`: one shell-quoted loop that restores
  each file `X` has and deletes each one it lacks. A real-git test proves the
  restore, the delete (a path with a space) and that the command mints no FileWrite.
- **Inherited tool names.** `claudeToolCall`/`piToolCall` resolved `constructor`,
  `toString` and similar to prototype members, so `normalized` returned `undefined`
  in breach of the adapters' total contract. `toolOf` reads own keys only; an INV-4
  matrix pin fails without the fix and passes with it.
- **One collection-error rule.** `isCollectionErrorTestcase` in
  `structured-test-report.ts` serves the affected judge, the acceptance gate and the
  per-file projection.
- **Report discovery** gains three tests for the all-or-nothing JUnit dir rule.
- **Pi:** `details.results` is read once into a `PiResultsField` ADT;
  `issuedGrantTokens` is exported and pinned directly.
- **Smaller moves:** `judgeAffectedRun` filter/map, `affectedOffDetail`, one
  `NO_BLOCKS_ISSUED`, barrel exports for `recordToolEvidence`'s types.
- **Comments and docs corrected to the code:** the harness-tool-call header and
  ADR-0027 (Pi exit reading, `exit-unknown` in the outcome union),
  `machines/README.md` (veto wording, stale "now"), the under-minting limit of
  `extractShellWriteTargets`, the INV-6 note on `redThenGreenDuty`, the era matrix header.
- **Test tidy-ups:** `i6Section` and `expectInfrastructureBlocked`, the
  `frozenTestFiles` early return, a duplicate attribution row and an alias removed,
  `Object.keys`.

## Deferred (one `deepen` session, grouped)

- the I6 era sum type and one era/duty owner;
- leaf contract types and the counts-only/per-file summary union;
- stop-check ports (per-check counter record, decision-derived block parts,
  core-side arm resolution, non-empty block arm, cap-note typing);
- the CT-2 changed-files and off-reason contract arms;
- the Pi epoch address and grant module split, with the dispatch-to-settlement e2e
  test that needs a Pi implementation-dispatch harness;
- the extract-evidence shims and module split;
- the recorder-failure marker;
- the INV enforcement owner;
- test-fixture consolidation (population, runners, live-stop attempts, empty
  ledger, parse helpers).

## Dismissed

- s1 code-simplifier-1: a codebase-wide idiom (122 files).
- s5 type-design-analyzer-1: factually wrong; the caller holds a raw string.
- s5 code-simplifier-2: deliberate INV-4 defence in depth.

## Remediation registration

One schema-v2 remediation run sourced on `rf-20261017-pr99-r2-s0`, with
`defectFamily: {"kind":"not-required"}`. Every changed path outside s0's frozen
scope is named in `supportPaths`, this plan included.

## Validation

- Engine typecheck: clean.
- `npm run verify` (root): exit 0; 539 test files, 13,353 tests passed, 1 skipped;
  all six smokes passed.
