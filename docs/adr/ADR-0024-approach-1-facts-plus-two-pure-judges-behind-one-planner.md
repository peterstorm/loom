# ADR-0024: Approach 1: facts plus two pure judges behind one planner

## Status
Accepted

## Context
G4 slice 2 puts the test oracle inside the implementation loop. It adds two checks. **I6** is a fail-closed proof obligation: a Task that owes new tests must show its own test files failing, then an implementation write, then the same files passing. **I7** is a fail-open affected-test check: at SubagentStop it runs the frozen affected runner over the files the Task changed. Before this slice, a TestRun ledger fact carried only whole-run counts. That was not enough to tell which of a Task's test files went red or green. Pi also had no evidence ledger, so neither check could see anything on Pi.

Two spec requirements constrain where these judgments can live. FR-012 says the I6 judgment must be a pure, deterministic function of the ordered ledger facts and the frozen Task data, computed at read time. A stored verdict would violate the facts-only doctrine, because a derived judgment could drift from the facts it was derived from. FR-027 says the shared stop-check planner (`stop-check-planner.ts`, introduced in slice 1 for the acceptance check) must stay the single pure, total decision point for both stop checks, and that both the live hook and `helper stop-check-plan` must consume it. Both checks also run inside the one 300 s SubagentStop budget. They also share the per-repository runner lock, the report-reading and digest machinery, and exact settlement on both harnesses.

The design question was how to add per-file facts, one completion-time judgment and one stop-time check without storing derived state or splitting the stop-check decision across modules.

## Options Considered

1. **Facts plus two pure judges behind one planner (chosen)**
   - Pros:
     - TestRun facts gain per-file results, and every judgment is recomputed from them at read time. That satisfies FR-012.
     - I7 extends the existing planner, so one pure function decides both checks and the helper renders exactly what the hook will run. That satisfies FR-027 and SC-002.
     - It reuses existing pieces: `testcaseAcceptanceFile` (generalized into `attributeReportedFile`), the `acceptanceRunnerCheck` command builder, the runner lock, and exact settlement.
     - Lock, budget, counters and message composition stay in one shell, not in dispatch.
   - Cons:
     - The planner's signature widens. It takes `ChangedFiles` as an explicit input, and an additive wrapper (`planStopCheck`) had to stay alive for one Wave so the live hook kept compiling. It has since been removed: `planStopChecks` is the only planner.
     - I6 must be re-judged on every read. Paths with no ledger, such as `reconcileTaskFromStoredEvidence`, need an explicit carry-forward rule.
     - The report summary shape grows. Every producer, Claude and Pi alike, must reconcile per-file counts against the summary.

2. **Persist the I6 judgment on the Task at stop**
   - Pros:
     - The judgment is computed once, so completion reads a field and needs no ledger replay.
     - Reconcile paths without a ledger get the verdict for free.
   - Cons:
     - It stores a derived judgment, which violates FR-012 and the facts-only doctrine. A stored verdict can disagree with the facts it summarizes, and nothing re-derives it.
     - It adds TaskGraph wire schema, parsing and migration for a value the facts already determine.
     - It moves the decision point to stop time, while FR-011 requires I6 to be decided at completion.

3. **A sibling I7 planner and stop shell next to the acceptance ones**
   - Pros:
     - It leaves the slice 1 acceptance planner and shell untouched.
     - Each check can be developed and tested in isolation.
   - Cons:
     - It violates FR-027. There would be two decision points, and the helper and the hook could disagree about what runs.
     - Lock acquisition, the shared 300 s budget and the combined block message would all have to move into `dispatch.ts`. Dispatch would then hold sequencing logic, and two lock acquisitions would let a third stop interleave report writes.
     - Changed-file derivation and off-reason rendering would be duplicated across the two planners.

## Decision
**TestRun facts gain per-file results. I6 is a pure judgment over the ordered epoch facts, read at completion time. I7 is planned by the existing single planner, extended for it, and one stop shell runs both checks.**

Facts:
- `TestReportSummary` gains `files: TestReportFiles`. Its two arms are `unrecorded` and `recorded` with `TestFileResult[]`, and each result is `{file, executed, failed, skipped, collectionError}` keyed by the report's own identity. `executed` counts declared testcases, so `skipped` says how many of them never ran. One smart constructor, `reconcileFileResults`, gates this shape in the parsers, in `mergeSummaries` and in the ledger read-back (INV-8; `engine/src/core/structured-test-report.ts`, `engine/src/machine/test-report.ts`, `engine/src/machine/evidence.ts`). A malformed or unreconciled `files` voids the whole report, so the run is untrusted.
- Both harnesses mint facts through one rule. `extractEvidence` takes a normalized `HarnessToolCall` (`engine/src/core/harness-tool-call.ts`). `recordToolEvidence` in `engine/src/machine/tool-evidence-recorder.ts` is its only caller and the only ledger appender (INV-4). The Claude adapter is `handlers/post-tool-use/record-evidence.ts`, and the Pi adapter is `pi/evidence-recorder.ts`, which records into the parent's ledger under the child's epoch.
- A reported file is mapped to a declared `file_list` entry by one neutral pure module, `engine/src/core/report-file-attribution.ts` (`attributeReportedFile`, INV-5). Test and implementation files are split by one classifier, `engine/src/core/test-file-classification.ts` (INV-2).

I6 judge (completion time):
- `judgeRedThenGreen` in `engine/src/core/red-then-green.ts` takes the epoch's ordered events, the Task classification, the repository root and the untrusted-evidence flag. It returns a `RedThenGreenObservation` (types in `engine/src/core/red-then-green-types.ts`). Only qualifying runs count: a non-null exit, a non-null report, and recorded per-file results. Gaps are reported in a fixed precedence order.
- I6 enters proof as one `red-then-green` obligation, one `red-then-green-unproven` failure variant and one evidence variant (`engine/src/core/proof-obligations.ts`, `engine/src/core/implementation-completion.ts`). Whether a Task owes it is decided only by `redThenGreenEra(graph.verification_manifest)` (INV-6), which keys on the presence of the frozen `testFiles` classification.
- Settlement on both harnesses passes the epoch's events as a `LedgerObservation` in `ExactImplementationTransportFacts` (`engine/src/handlers/helpers/exact-implementation-settlement.ts`, `pi/subagent-settlement.ts`). An unreadable ledger is an infrastructure failure, not a semantic one. Reconcile without a ledger carries forward a prior satisfied result, and otherwise observes `ledger-unavailable`. The judgment itself is never persisted.

I7 (stop time):
- `planStopChecks(graph, taskId, changed: ChangedFiles)` in `engine/src/core/acceptance-contract/stop-check-planner.ts` is the single total pure plan (INV-1). It returns the unchanged acceptance arm next to an `AffectedPlan` that is either `on` with files, command and report path, or `off` with exactly one reason: `no-runner`, `no-changed-files` or `command-refused`.
- `ChangedFiles` is derived only by `changedFilesAtStop` in `engine/src/core/changed-files.ts` (INV-7). Each shell supplies only the epoch events and an `exists` predicate: `dispatch.ts`, `pi/subagent-stop.ts`, and `helper stop-check-plan` through `liveAttemptEvidence`.
- `runStopChecks` in `engine/src/handlers/subagent-stop/stop-checks.ts` plans once, takes the existing runner lock once, and runs acceptance and then affected. It launches the affected runner only when the remaining budget (300 s minus a 30 s settlement reserve) covers its `timeoutMs`. It renders one combined block message.
- Per-check block counters follow the pure `stopCheckBlockDecision` in `engine/src/core/affected-stop-check.ts`, with a separate counter per check. The affected cap is typed to `AFFECTED_STOP_CHECK_MAX_BLOCKS = 3`; the acceptance cap is the caller-supplied `ACCEPTANCE_STOP_CHECK_MAX_BLOCKS` (also 3 today). Verdicts come from the pure `judgeAffectedRun`.
- The outcome type carries only `skip | passed | block | note`. Affected-check data never reaches proof, receipts or gate evidence (INV-3, FR-026).

## Consequences

**Positive:**
- No derived judgment is stored. I6 is always recomputed from the facts, so it cannot drift from them, and the TaskGraph wire schema gains no verdict field.
- Exactly one place decides what runs at stop. The helper's plan view (`acceptance-contract/stop-check-plan.ts`) and the live hook cannot disagree.
- Lock, budget and counters live in one shell. The two runners never interleave report writes, and the 300 s hook budget holds by arithmetic.
- Pi gains real ledger facts minted by the same rule as Claude Code, so I6 and I7 also work on Pi. A matrix test pins that both harnesses mint identical facts.
- Existing machinery is reused rather than forked: attribution, the runner-command builder, the runner lock and exact settlement.
- TaskGraphs frozen before this feature keep their obligations, receipts and digests unchanged, because era detection keys on the frozen `testFiles` presence and the legacy default manifest is preserved byte for byte.

**Negative:**
- Completion re-judges I6 by replaying the epoch's ledger every time. A missing or unreadable ledger has to be handled explicitly, as an infrastructure failure or by carrying forward a prior result in reconcile. A satisfied I6 result therefore depends on the ledger's availability at read time.
- The planner and the report summary are now wider, shared contracts. Any later stop check must also be added to `planStopChecks` and `runStopChecks`, which concentrates change in those two modules.
- I6 depends on the ordering of past ledger facts, so a retry that does not first restore the implementation files can never observe red. This is mitigated by the brief's up-front I6 section and its retry remedy, not by the judge.
- Per-file reconciliation is strict. A report whose per-file counts do not reconcile voids the whole report and makes the run untrusted, even when the whole-run counts alone would have been usable.
- Rollout needed care while the engine runs live from the checkout. The additive `planStopCheck` wrapper had to stay until the shell switched (it is now removed), and every edit to a hook-imported file had to land as one commit.
