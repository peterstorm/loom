# PR #99 remediation, round 3: G4 slice 2 (I6, I7)

- **Branch:** `feat/g4-slice-2-oracle` → `main` (PR #99)
- **Date:** 2026-10-17
- **Workflow:** `/loom:review-and-fix 99`, third round. Round 1: `0a493aa2`, plan
  `.claude/plans/2026-10-17-pr-remediation.md`. Round 2: `5589c8ee`, plan
  `.claude/plans/2026-10-17-pr-remediation-r2.md`.

## Scope

The same six-slice partition as rounds 1 and 2, each slice re-frozen at the round-2
head (`5589c8ee`). Planning artifacts under `.claude/plans` and `.claude/specs`
stay out of review scope.

| Slice | Review run | Policy run | Disposition digest | Criticals (surviving / refuted) | Advisories |
|---|---|---|---|---|---|
| s0 | `rf-20261017-pr99-r3-s0` | `rf-20261017-pr99-r3-s0-policy` | `d8416fc9c6f5f2be2e23dccf8e0459569f023859040a0121673dac66365a780e` | 0 / 0 | 17 |
| s1 | `rf-20261017-pr99-r3-s1` | `rf-20261017-pr99-r3-s1-policy` | `8afa5888a5164ff667f82db40e410e1348505b608b6d6e6dce8449b261d9db2f` | 0 / 0 | 13 |
| s2 | `rf-20261017-pr99-r3-s2` | `rf-20261017-pr99-r3-s2-policy` | `2706674e41cecfe01882600c1c48aa2974c43f836a425552d6ebfafe34675150` | 0 / 0 | 7 |
| s3 | `rf-20261017-pr99-r3-s3` | `rf-20261017-pr99-r3-s3-policy` | `886b372f62446cfe0227cc1dba2f44e32862f7333947078b7b3ab5bf447a9d56` | 0 / 0 | 5 |
| s4 | `rf-20261017-pr99-r3-s4` | `rf-20261017-pr99-r3-s4-policy` | `79b9c86289c8b9b2b6e793bf5e3ba1da73db59da1cad96bfa06b3ca308aafb65` | 0 / 0 | 8 |
| s5 | `rf-20261017-pr99-r3-s5` | `rf-20261017-pr99-r3-s5-policy` | `f77a0f2f684fc998e2956b04c15bb626d703b9563f8e6115858c0ce931b5d5dc` | 0 / 0 | 11 |

The runs root is `.claude/reviews/review-and-fix-runs`. All 38 reviewer requests
were admitted. There was one retry: the first attempt of s0's code-simplifier was
refused for read coverage, because it skipped the inv-* rule diffs. Its second
attempt was admitted.

## Criticals

No slice had a surviving or a refuted critical. Defect-family accounting is
`{"kind":"not-required"}`, so no Repair Group, sibling disposition, check ID or
Historical RED declaration applies.

## Advisory dispositions (61: 24 accepted, 34 deferred, 3 dismissed)

All six policy runs are `DECLARED` initial revisions. As the Skill requires, they
were **published before any edit**, which corrects round 2's deviation.

| Finding | Decision | Reason |
|---|---|---|
| s0:code-reviewer-1 | accepted | docs/deterministic-implementation.md I6 Retry paragraph is updated to the per-file baseline restore loop with the HEAD fallback. |
| s0:code-reviewer-2 | accepted | The I6 retry-repair JSDoc moves onto redThenGreenRemedy; baselineRestoreCommand keeps only its own doc. |
| s0:silent-failure-hunter-1 | accepted | Real hazard: the loop now runs from the repository root, verifies the source commit before touching any file, and aborts on any git error, so a bad start_sha deletes nothing; a real-git test pins it. |
| s0:silent-failure-hunter-2 | deferred | Pi's bash tool_result carries no exit code beyond details.exitCode/isError; an unknown-exit arm needs a Pi result contract change, tracked with the Pi result-shape family. |
| s0:pr-test-analyzer-1 | accepted | A table test pins every INV-2/INV-4/INV-6/INV-8 rule's pattern hits, owner excludes and Claude/Pi byte parity. |
| s0:type-design-analyzer-1 | accepted | affected-stop-check-types.ts re-exports FrozenTestFiles from its owner core/test-file-classification.ts instead of restating it. |
| s0:type-design-analyzer-2 | accepted | The command-refused sentence is written once and both note and off-reason tables read it. |
| s0:type-design-analyzer-3 | accepted | Same fix as code-reviewer-2: the repair JSDoc moves onto redThenGreenRemedy. |
| s0:type-design-analyzer-4 | deferred | Encoding the I6 era as a sum type in FrozenVerificationManifest is a manifest schema deepening (era sum type family, ADR-0024 follow-up). |
| s0:comment-analyzer-1 | accepted | Same fix as code-reviewer-2. |
| s0:comment-analyzer-2 | accepted | docs/operations.md describes the restore loop, the deletion of created files and the HEAD fallback. |
| s0:architecture-tech-lead-1 | deferred | Era sum type carrying its classification is the same manifest deepening as type-design-analyzer-4. |
| s0:architecture-tech-lead-2 | deferred | Moving redThenGreenDuty to a small duty module is an interface move (duty owner family), not a defect. |
| s0:architecture-tech-lead-3 | deferred | Collapsing the paired per-check counters into one keyed counter port is the stop-check ports deepening family. |
| s0:architecture-tech-lead-4 | deferred | Retiring the slice-1 plan entry points is the CT-1 plan-pair deepening; both have live callers today. |
| s0:code-simplifier-1 | accepted | Same fix as code-reviewer-2. |
| s0:code-simplifier-2 | deferred | StopChecksPlanRendering is exported and named in the CT-1 contract; dropping it goes with the CT-1 plan-pair deepening. |
| s1:silent-failure-hunter-1 | dismissed | The lookbehind is a documented, deliberate trade-off (findResidualPlaceholders JSDoc): no /loom template places a variable after an identifier character or a pipe, and ADT prose such as unproven{gap} must not block. |
| s1:type-design-analyzer-1 | deferred | Splitting TestReportSummary into counts-only and per-file variants is a union redesign across machine/core (TestReportSummary union family). |
| s1:type-design-analyzer-2 | dismissed | Same deliberate lookbehind trade-off as silent-failure-hunter-1. |
| s1:architecture-tech-lead-1 | deferred | Moving stop-check composition into core is the core-side composition deepening; behavior is covered through the shell ports today. |
| s1:architecture-tech-lead-2 | deferred | Sharing one live-epoch derivation between the plan view and dispatch is an epoch-ledger port deepening. |
| s1:architecture-tech-lead-3 | accepted | reconcileTaskFromStoredEvidence now requires both trailing parameters, so every caller states its graph's manifest (I6 era) explicitly. |
| s1:architecture-tech-lead-4 | deferred | Same era sum type family as s0 type-design-analyzer-4. |
| s1:architecture-tech-lead-5 | deferred | Copy-and-pin exists to break a core-machine-core cycle; dissolving it needs the leaf contract types move. |
| s1:architecture-tech-lead-6 | deferred | Renaming acceptance-stop-check.ts and relocating the caps is the stop-check ports and caps naming family. |
| s1:code-simplifier-1 | dismissed | describe(cause) is the codebase-wide one-line idiom (dismissed in prior rounds too); a shared helper would couple unrelated shells for no invariant. |
| s1:code-simplifier-2 | deferred | Typing the block decision as non-empty to delete the unreachable throw is part of the core-side composition deepening. |
| s1:code-simplifier-3 | deferred | Same naming family as architecture-tech-lead-6. |
| s1:code-simplifier-4 | deferred | The ternary also covers a pre-classification (null) freeze; collapsing it needs the era sum type to prove the arm, so it moves with that family. |
| s2:type-design-analyzer-1 | deferred | The overload pair is a pre-AD-8 compatibility shim scheduled for deletion with its unit suite (extract-evidence shims family). |
| s2:architecture-tech-lead-1 | deferred | Same extract-evidence shims family. |
| s2:architecture-tech-lead-2 | deferred | Splitting the mv/cp destination parser into its own module is the extract-evidence module split. |
| s2:architecture-tech-lead-3 | deferred | Pure report-directory classification needs readJunitDir's I/O lifted out; tracked as report-discovery pure classification. |
| s2:code-simplifier-1 | accepted | filesOf and isRecorded read TestReportSummary.files through its type, and the stale header is corrected. |
| s2:code-simplifier-2 | deferred | Same extract-evidence shims family. |
| s2:code-simplifier-3 | accepted | readJunitDir's dispatch on read.kind becomes exhaustive. |
| s3:code-simplifier-1 | deferred | Shared stop-check runner fixtures for the planner tests belong to the shared test-fixture family. |
| s3:code-simplifier-2 | deferred | Same shared test-fixture family (one recording-runner fake). |
| s3:code-simplifier-3 | deferred | Same shared test-fixture family (one authored-task and manifest-from-source fixture). |
| s3:code-simplifier-4 | accepted | The literal stays as an independent oracle, and a test now asserts it equals legacyDefaultVerificationManifest(). |
| s3:code-simplifier-5 | deferred | Same shared test-fixture family (one TestFileResult builder set). |
| s4:architecture-tech-lead-1 | deferred | One shared in-memory StopCheckShellPorts fake is the shared test-fixture family, paired with the stop-check ports deepening. |
| s4:architecture-tech-lead-2 | deferred | Splitting i6-settlement.matrix.test.ts is a test-file reorganisation with no defect; tracked with the shared test-fixture family. |
| s4:code-simplifier-1 | deferred | Same as architecture-tech-lead-1. |
| s4:code-simplifier-2 | accepted | The nested ternary becomes a named elapsedMs switch. |
| s4:code-simplifier-3 | accepted | The inner result builders are renamed runnerResult in stop-checks.test.ts and stop-checks-isolation.test.ts. |
| s4:code-simplifier-4 | accepted | stateFile builds graph(frozen) once. |
| s4:code-simplifier-5 | accepted | The per-transport loops become it.each over one TRANSPORTS list, and a LEDGER_KEY lookup replaces the ternary. |
| s4:code-simplifier-6 | deferred | The alias avoids a clash with the file's own local satisfiedProof; merging the two fixtures is the shared test-fixture family. |
| s5:pr-test-analyzer-1 | accepted | Tests pin both consume-time refusals: a malformed stored ledger is refused as malformed, and a MAC-valid but unparseable address is refused. |
| s5:comment-analyzer-1 | accepted | The no-grant explanation now covers both cases: no grant at all, and an active grant without a ledger address. |
| s5:comment-analyzer-2 | accepted | The duplicated sentence is dropped and the machines/README.md bullet is re-wrapped. |
| s5:architecture-tech-lead-1 | deferred | Same stop-check ports deepening family (one keyed counter port). |
| s5:architecture-tech-lead-2 | deferred | The linter rule and the behavior matrix are deliberately independent; deriving both from one owner list goes with the leaf contract types move. |
| s5:architecture-tech-lead-3 | deferred | A type-level era guard replacing the regex is the era sum type family. |
| s5:architecture-tech-lead-4 | deferred | Retaining the parsed address per slot is a Pi settlement deepening (child-epoch address family). |
| s5:code-simplifier-1 | deferred | Shared parse-or-throw fixtures are the shared test-fixture family. |
| s5:code-simplifier-2 | accepted | A local applyImplementation helper defaults ledger to EMPTY_LEDGER, and each test shows only its distinguishing inputs. |
| s5:code-simplifier-3 | accepted | Same fix as comment-analyzer-2. |
| s5:code-simplifier-4 | accepted | The call-start stamp comment is split into its consumer paragraph and its polarity rule paragraph. |

## Accepted fixes (as implemented)

- **The I6 retry restore could delete implementation files (hazard).** The round-2
  loop concluded "absent at baseline" from *any* `git cat-file -e` failure. A wrong
  or unknown `start_sha`, a cwd outside the repository, or a git error therefore
  ran `rm -f` on every listed file. `baselineRestoreCommand` now runs in a subshell
  from `git rev-parse --show-toplevel`, verifies `<source>^0` before the loop, and
  aborts on a failed restore. Real-git tests cover four cases: the happy path, a run
  from a subdirectory, a non-commit source (a missing sha and `HEAD~5`) that deletes
  nothing, and a directory outside any repository that deletes nothing. The command
  still mints no FileWrite. The brief text and both docs describe the loop and the
  HEAD fallback. The JSDoc for the retry repair now sits on `redThenGreenRemedy`.
- **`reconcileTaskFromStoredEvidence`** now requires both trailing parameters, so
  every caller states its graph's manifest (its I6 era) instead of defaulting into
  the legacy era.
- **CT-2 types file:** `FrozenTestFiles` is re-exported from its INV-2 owner, not
  restated, and the command-refused sentence is written once.
  *Flag:* the file's header says it changes only through a CT-2 amendment. Both
  edits are type-identical and text-identical, and the feature's Wave execution is
  complete, so no live Acceptance Contract freeze applies.
- **Lint-rule pins:** a table test runs INV-2/4/6/8 through the production loader and
  executor under both harness directories. It checks that each rule refuses its
  pattern outside the owner and spares the owners, test files and the sanctioned call.
- **Write grant:** tests cover the two consume-time refusals. A malformed stored
  ledger is refused as malformed. A MAC-valid but unparseable session id or agent
  type is refused as an invalid address.
- **Pi evidence recorder:** the `no-grant` explanation now also covers an active
  grant without a ledger address.
- **readJunitDir** switch is exhaustive (`never`).
- **Tests:** the ledger per-file test reads `TestReportSummary.files` through its
  type, and its stale header is fixed. The pre-feature manifest literal is pinned
  to `legacyDefaultVerificationManifest()`. In stop-checks: a named `elapsedMs`
  replaces a nested ternary, and the shadowing `observed` helpers become
  `runnerResult`. `graph(frozen)` is built once. The i6 matrix uses `it.each`
  over `TRANSPORTS`, with a `LEDGER_KEY` lookup. In subagent-result, the local
  wrapper defaults `ledger`, which drops 22 repeated lines.
- **Comments:** the duplicated sentence in `machines/README.md` is dropped, and the
  `pi/extension.ts` stamp comment is split into its two paragraphs.

## Deferred (one `deepen` session, grouped as in round 2)

- the I6 era sum type and one era/duty owner (with a type-level INV-6 guard);
- stop-check ports and caps (keyed counter port, naming of `acceptance-stop-check.ts`, the non-empty block arm, core-side composition);
- the epoch-ledger port shared by the plan view and dispatch, and the Pi child-epoch address;
- leaf contract types (copy-and-pin, the INV-4 owner list), the `TestReportSummary` union, and `canonicalFrozenManifest`;
- the CT-1 plan pair and the `StopChecksPlanRendering` alias;
- the extract-evidence shims and module split; pure report-dir classification;
- the Pi unknown-exit arm;
- test-fixture consolidation: stop-check runner and port fakes, authored tasks and manifests, `TestFileResult` builders, parse-or-throw helpers, and the i6 matrix split.

## Dismissed

- s1 silent-failure-hunter-1 and type-design-analyzer-2: the placeholder lookbehind is a documented, deliberate trade-off.
- s1 code-simplifier-1: the `describe(cause)` idiom is used across the codebase. It was also dismissed in round 2.

## Remediation registration

There is one schema-v2 remediation run, `rf-20261017-pr99-r3-remediation-1`, sourced on
`rf-20261017-pr99-r3-s0`, with `defectFamily: {"kind":"not-required"}`. Every
changed path outside s0's frozen scope is named in `supportPaths`, this plan included.

## Validation

- Engine typecheck: clean.
- `npm run verify` (root): exit 0. 539 test files ran: 13,363 tests passed and 1 was
  skipped. All six smokes passed.
