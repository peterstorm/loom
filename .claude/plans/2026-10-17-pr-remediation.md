# PR #99 remediation — G4 slice 2 (I6 red-then-green, I7 affected tests)

- **Branch:** `feat/g4-slice-2-oracle` → `main` (PR #99)
- **Date:** 2026-10-17
- **Workflow:** `/loom:review-and-fix 99` (canonical Skill, schema-v2 remediation)

## Scope

The full PR diff froze at 1,146,597 UTF-16 units, over the 240,000-unit read-coverage
budget: the `rf-20261017-pr99` start was refused before any program registered (its
directory holds only `authority.json`; no events, no slots, no review). The scope
was partitioned into six explicit `--files` Standalone Review Runs (kind `all`),
together covering every changed path of the PR:

| Slice | Review run | Policy run | Disposition digest | Criticals (surviving / refuted) | Advisories |
|---|---|---|---|---|---|
| s0 | `rf-20261017-pr99-s0` | `rf-20261017-pr99-s0-policy` | `a6d9ee4624f30994d826b15e1a291905781ef5c76306f6d42ad9a2a0e70cb1e8` | 0 / 0 | 22 |
| s1 | `rf-20261017-pr99-s1` | `rf-20261017-pr99-s1-policy` | `a5b3e03b131d1c33904446320a856cf03f2d383f643931eb505ddc0ba39456da` | 0 / 0 | 15 |
| s2 | `rf-20261017-pr99-s2` | `rf-20261017-pr99-s2-policy` | `e6d0baeca140722e659f89307de1d76ad6680985120033ef64e22aeaed1cd623` | 0 / 0 | 7 |
| s3 | `rf-20261017-pr99-s3` | `rf-20261017-pr99-s3-policy` | `c41b781d99c71910d4937a574ff3d83e9845561a7813fa729a4aac2413add40f` | 0 / 0 | 5 |
| s4 | `rf-20261017-pr99-s4` | `rf-20261017-pr99-s4-policy` | `c9e60cfebb87618567f27a37fb546ccb25ff22f72d8e9e41e8e9c8260935239d` | 0 / 0 | 10 |
| s5 | `rf-20261017-pr99-s5` | `rf-20261017-pr99-s5-policy` | `447f9eadd6b39e7f46850b24882b7d5760b3340ec2680f9136fed4453e6aea31` | 0 / 0 | 9 |

Runs root: `.claude/reviews/review-and-fix-runs`. Each policy run publishes one
`DECLARED` initial revision (`previous: null`).

## Criticals

- **Surviving:** none in any slice. Defect-family accounting: `{"kind":"not-required"}`.
- **Refuted:** none in any slice (no Refutation Panel was routed).
- No Declared Repair Group, sibling disposition, selected check ID or Historical RED
  declaration applies.

## Advisory dispositions (68: 33 accepted, 31 deferred, 4 dismissed)

All `DECLARED`, published before any edit in the policy runs above.

| Finding | Decision | Reason |
|---|---|---|
| s0:code-reviewer-1 | accepted | Verified: OUTCOME_TEXT renders 'failed to collect'; operations.md is corrected to the rendered strings. |
| s0:pr-test-analyzer-1 | accepted | Same doc drift as code-reviewer-1; one operations.md correction covers it. |
| s0:comment-analyzer-1 | accepted | Same doc drift as code-reviewer-1; one operations.md correction covers it. |
| s0:architecture-tech-lead-5 | accepted | Same doc drift as code-reviewer-1; also aligns the AFFECTED_BLOCK_HEADING doc comment. |
| s0:code-reviewer-2 | accepted | planStopCheck no longer exists; the AcceptancePlan comment and ADR-0024 are reworded to planStopChecks. |
| s0:comment-analyzer-2 | accepted | Same stale planStopCheck reference as code-reviewer-2. |
| s0:code-reviewer-3 | deferred | A regex cannot see aliased reads; the permanent fix is the explicit era sum type recorded as ADR-0025's follow-up, which makes INV-6 a type rule. |
| s0:architecture-tech-lead-2 | deferred | Same as code-reviewer-3: the era sum type (ADR-0025 follow-up) replaces regex enforcement. |
| s0:silent-failure-hunter-1 | accepted | A missing start_sha now falls back to a runnable HEAD restore with an explicit note instead of an unrunnable placeholder. |
| s0:type-design-analyzer-1 | deferred | The twin declaration exists to break a core-machine import cycle; removing it needs a dependency-free leaf types module, an interface move for a deepen session. |
| s0:type-design-analyzer-2 | deferred | A parser-minted refined AffectedRunner changes the CT-2 contract surface consumed by the planner and both shells; deepen candidate. |
| s0:type-design-analyzer-3 | deferred | Already recorded in PR #99 follow-ups as a deepen candidate: derive StopChecksBlockParts from the block decision. |
| s0:type-design-analyzer-4 | deferred | The explicit era sum type is ADR-0025's recorded follow-up; it touches every freeze path and the frozen manifest wire. |
| s0:comment-analyzer-3 | accepted | Verified: the export is DEFAULT_TEST_FILE_SUFFIXES and the consumer is the implementation brief; both rule copies are corrected. |
| s0:comment-analyzer-4 | accepted | Verified: unknown file-tool shapes count as success; the module header and ADR-0027 are reworded. |
| s0:architecture-tech-lead-1 | deferred | Moving redThenGreenDuty into proof-obligations.ts drags Task and verification-policy dependencies into the proof core and risks an import cycle; deepen session. |
| s0:architecture-tech-lead-3 | dismissed | testcaseAcceptanceFile is an exported acceptance-contract barrel API with its own tests (acceptance-contract.test.ts); deleting it changes the public barrel for no behavior gain. |
| s0:architecture-tech-lead-4 | deferred | Hoisting both checks' caps and text tables into one core module moves the acceptance constants out of the shell; part of the stop-check ports deepening. |
| s0:code-simplifier-1 | accepted | acceptancePlan is private and its manifest argument is always graph.verification_manifest; the parameter is dropped. |
| s0:code-simplifier-2 | accepted | The proof:red-then-green-unproven: prefix gets one exported owner used by both the minting and matching sites. |
| s0:code-simplifier-3 | deferred | StopChecksPlanRendering is a CT-2 contract-surface name; removing it is an interface decision, as the reviewer notes. |
| s0:code-simplifier-4 | accepted | changed-files.ts adopts the kernel freeze idiom used by its sibling I7 modules. |
| s1:code-reviewer-1 | accepted | red-then-green.ts reuses repositoryRelative from report-file-attribution.ts instead of its own copy. |
| s1:silent-failure-hunter-1 | deferred | The narrowed residual-placeholder detector is a deliberate, tested trade-off against ADT notation in briefs; a context-aware scanner is the real fix and needs its own design. |
| s1:silent-failure-hunter-2 | accepted | The read-only plan view now says when attempt evidence could not be inspected instead of reading as no live attempt. |
| s1:pr-test-analyzer-1 | accepted | Tests are added for the production live-attempt evidence edge branches. |
| s1:type-design-analyzer-1 | accepted | Real I6 soundness gap: per-file results gain a skipped count and the green step requires at least one testcase that actually ran in every Task test file. |
| s1:type-design-analyzer-2 | deferred | Making redThenGreen required touches 147 call sites and is subsumed by the era sum type (ADR-0025 follow-up). |
| s1:architecture-tech-lead-1 | deferred | Extracting a pure settle into the core reshapes the stop-check shell seam; deepen session with the per-check counter port. |
| s1:architecture-tech-lead-2 | deferred | Collapsing the six parallel counter ports into one per-check port changes StopCheckShellPorts for every caller; deepen session. |
| s1:architecture-tech-lead-3 | deferred | Same root as s0 type-design-analyzer-1: a dependency-free leaf contract module; deepen session. |
| s1:architecture-tech-lead-4 | deferred | Consolidating attempt-epoch resolution behind the sidecar module is a seam move; the duplicated path relativizer part is fixed under s1 code-reviewer-1. |
| s1:architecture-tech-lead-5 | deferred | Same as s0 type-design-analyzer-4: explicit era tag on the frozen graph is ADR-0025's follow-up. |
| s1:code-simplifier-1 | accepted | Same duplicate as s1 code-reviewer-1; one fix. |
| s1:code-simplifier-2 | accepted | The validateFull doc comment is moved back onto validateFull. |
| s1:code-simplifier-3 | dismissed | The codebase idiom keeps a module-private bounded cause renderer per shell module; a shared export would be the only one of its kind. |
| s1:code-simplifier-4 | accepted | The no-runner case is narrowed away so the unreachable arm is deleted. |
| s2:type-design-analyzer-1 | deferred | The compatibility overload is scheduled for deletion once the 33 legacy extractEvidence test calls migrate to HarnessToolCall; separate distill pass. |
| s2:architecture-tech-lead-1 | deferred | Extracting shell write-target lexing into its own module is a module move; deepen candidate, noting the mv-into-directory under-cover limit. |
| s2:architecture-tech-lead-2 | deferred | Same as s2 type-design-analyzer-1: delete the shims after migrating the legacy unit suite. |
| s2:architecture-tech-lead-3 | accepted | readJunitDir returns a named reports, none or void result that one pure merge consumes. |
| s2:code-simplifier-1 | accepted | Covered by the same readJunitDir rewrite: a plain switch replaces the side-effect match. |
| s2:code-simplifier-2 | dismissed | FR-034 and AS-041 are distinct traceability rows of the frozen acceptance contract; merging them would drop a requirement anchor. |
| s2:code-simplifier-3 | dismissed | FR-035 is its own frozen requirement anchor separate from AS-037 and AS-040; the overlap is deliberate traceability. |
| s3:architecture-tech-lead-1 | accepted | The INV-5 matrix gains judge and renderer columns and its stale header is corrected. |
| s3:architecture-tech-lead-2 | deferred | Relocating the parity matrix and sharing one recording ports fake belongs to the test-fixture consolidation pass across the frozen suites. |
| s3:architecture-tech-lead-3 | accepted | The acceptance test uses the production settlement facts type directly. |
| s3:code-simplifier-1 | deferred | Shared newTests-policy fixture is part of the test-fixture consolidation pass across the frozen acceptance suites. |
| s3:code-simplifier-2 | deferred | Shared runner literals and recording ports belong to the test-fixture consolidation pass. |
| s4:code-reviewer-1 | accepted | The split import region in verification-manifest-affected.test.ts is consolidated. |
| s4:type-design-analyzer-1 | accepted | Same import-region fix as s4 code-reviewer-1. |
| s4:architecture-tech-lead-1 | deferred | One shared StopCheckShellPorts fake and attempt-project builder is the test-fixture consolidation pass; the port itself is slated for the stop-check deepening. |
| s4:architecture-tech-lead-2 | deferred | Same as s0 type-design-analyzer-1: leaf contract module removes the twins and their pins. |
| s4:code-simplifier-1 | deferred | Part of the test-fixture consolidation pass. |
| s4:code-simplifier-2 | accepted | Same import-region fix as s4 code-reviewer-1. |
| s4:code-simplifier-3 | accepted | The AS-019 table row builds its own base so the label-string dispatch and the dead identity tamper disappear. |
| s4:code-simplifier-4 | accepted | The nested ternary in manifest() is replaced by a flat mapping. |
| s4:code-simplifier-5 | accepted | One i6ResultOfTask derivation serves both call sites. |
| s4:code-simplifier-6 | accepted | One shared type-equality helper replaces the two spellings. |
| s5:silent-failure-hunter-1 | deferred | A durable recorder-failed ledger fact needs a new evidence kind across wire, recorder and read-back; separate design. |
| s5:type-design-analyzer-1 | deferred | Splitting ActiveChildWriteGrantScope into ledger and no-ledger arms changes the Pi grant interface; deepen with the epoch-address consolidation. |
| s5:comment-analyzer-1 | accepted | Verified: the adapter prefers an integer details.exitCode; the README sentence is corrected. |
| s5:architecture-tech-lead-1 | deferred | Carrying the issued ledger address per slot replaces the grantTokens plumbing; deepen candidate already listed in PR #99 follow-ups. |
| s5:architecture-tech-lead-2 | deferred | Choosing one enforcement owner for INV-2/4/6/8 (rule versus test) is a policy decision across all four invariants. |
| s5:architecture-tech-lead-3 | deferred | Re-homing the stop-check ports beside runStopChecks is part of the stop-check shell deepening. |
| s5:code-simplifier-1 | accepted | grantTokens is built by a named pure helper. |
| s5:code-simplifier-2 | accepted | The duplicate machine import is merged. |
| s5:code-simplifier-3 | deferred | Shared Pi evidence fixture identities belong to the test-fixture consolidation pass. |

## Accepted advisory fixes (as implemented)

- **I6 soundness — skipped testcases (FR-006).** `TestFileResult` gains `skipped`
  (`failed + skipped <= executed`); the Vitest and JUnit projections count it,
  `mergeFileResults` sums it, and `isGreen` requires `sum(executed - skipped) >= 1`,
  so an all-skipped file is never the green step. The pre-`skipped` 4-key shape is
  refused, never defaulted. Docs: ADR-0024, `docs/deterministic-implementation.md`.
- **One attribution owner.** `repositoryRelative` is exported from
  `report-file-attribution.ts`; `red-then-green.ts` drops its duplicate. The INV-5
  matrix gains `judgeRedThenGreen` and `renderAffectedBlock` columns and loses the
  stale "when they land (T7, T8)" header.
- **One failure-kind owner.** `redThenGreenFailureKind` / `isRedThenGreenFailureKind`
  in `red-then-green.ts`; `implementation-completion.ts` and `implementation-brief.ts`
  consume them.
- **Brief remedy without a start commit** names `HEAD` as the stand-in, with a note.
- **Live-attempt evidence is never silently empty.** `LiveAttemptEvidence` gains an
  `uninspectable` arm when a sidecar cannot be read and none names the Task; the plan
  view appends a note that its changed files may be incomplete. New port tests:
  `engine/tests/handlers/helpers/claude-live-attempt-evidence.test.ts`.
- **Shell narrowing.** `stop-checks.ts` extracts `affectedFault()` and deletes an
  unreachable arm; `report-discovery.ts` uses a `DirReports` sum type and a pure fold.
- **Smaller seams.** `acceptancePlan(graph, task)` reads the frozen manifest itself;
  `changed-files.ts` uses the kernel `freeze`; `pi/subagent-stop.ts` extracts the
  pure `issuedGrantTokens(owner, parentSessions)`.
- **Comments, docs and rules corrected to the code:** `harness-tool-call.ts` header,
  `affected-stop-check-types.ts`, `validate-task-graph.ts` (`validateFull` doc
  placement), `docs/operations.md` ("— failed or — failed to collect"), ADR-0024
  (`planStopCheck` removed), ADR-0027 (adapter wording), `machines/README.md` (Pi
  exit), INV-2 rule description in both `.claude` and `.pi` copies (parity held).
- **Test tidy-ups:** `i6ResultOfTask` extracted; the acceptance suite uses the
  production `ExactImplementationTransportFacts`; merged duplicate imports; the
  AS-019 rows build their own base (no label dispatch); a nested ternary flattened;
  one shared `Equal` type helper in `engine/tests/fixtures/type-equality.ts`.

## Deferred (deepen candidates, recorded for a follow-up session)

The I6-era sum type; leaf contract types; stop-check ports; the Pi grant union and
epoch address; test-fixture consolidation; the INV enforcement owner; a
recorder-failure marker; the template scanner; extract-evidence shims and module.
Each changes an interface, so each is a `deepen` session, not a distill move.

## Dismissed

s0 tech-lead-3 (barrel API), s1 simplifier-3 (per-module cause idiom), s2
simplifier-2 and -3 (FR/AS traceability rows) — reasons in the table above.

## Remediation registration

One schema-v2 remediation run sourced on `rf-20261017-pr99-s0`, with
`defectFamily: {"kind":"not-required"}`. Every changed path outside s0's frozen
scope is named in `supportPaths` (s1–s5 scope paths, the two new test-side files and
this plan), because the registered input is immutable.

## Validation

- `npm --prefix engine run typecheck` — exit 0.
- `npm run verify` (root: prerequisites → engine typecheck → full Vitest suite →
  all six smokes) — exit 0; 539 test files, 13,351 tests passed, 1 skipped.
