# ADR-0037: Outcome classification reads only the structured report

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, FR-013 and FR-016; plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-7; interview Q3d).

## Context
G5b's Wave Gate mutation-tests the owner module of every owed Invariant. It first runs the Invariant's
matrix test against the unmutated workspace (the baseline), then once per planned mutant, each time
through the operator's frozen `affectedRunner` in an isolated git worktree. The gate is only as honest as
the reading of each run. One run can end in many ways. The process can fail to spawn, time out, or exit
with any code or signal. The report can be missing, unreadable, malformed, or in a format with no
per-testcase file attribution. The report can also name no testcase of the matrix test at all, fail only
at collection or import, or pass while the process still exits non-zero.

Several forces shaped the reading:

- **A crash is not a kill.** Mutation testing measures whether the matrix test *detects* a defect. A mutant
  that makes the runner crash, fail to import, or never collect the matrix test has proved nothing about
  the test's assertions. Counting it as killed inflates the score exactly where the gate is weakest.
- **Fail closed (FR-016, interview Q3d).** Every outcome the gate cannot read with confidence must block
  with a named diagnostic, and must never count as a kill. A silent pass on infrastructure noise would
  turn the gate into theatre.
- **Reuse the existing report rules.** The engine already parses structured test reports
  (`engine/src/core/structured-test-report.ts`). It already attributes reported file identities to
  declared paths (`engine/src/core/report-file-attribution.ts`) and recognizes collection-error testcases
  for the I6 red-then-green evidence. A second copy of these rules would drift from the first.
- **Purity.** Classification must be a pure function of the observation, so every outcome can be tested
  as a table row without a runner (plan Testing Strategy: "every AD-7 table row").

## Options Considered

1. **Exit-code classification** (exit non-zero means killed, exit 0 means survived)
   - Pros: trivial to implement; works with any runner, with no report format required.
   - Cons: a crash, an import error, a missing test file, an out-of-memory kill, or a runner
     misconfiguration all look like a kill, so the gate over-credits weak tests. A non-zero exit from an
     unrelated cause (a coverage threshold, a lint step in the script) cannot be told apart from a test
     failure. Violates FR-013 ("whose structured report decides each outcome") and FR-016.

2. **Report first, with the exit code as a tie-breaker** (read the report when present, otherwise fall
   back to the exit code)
   - Pros: tolerates runners that sometimes fail to write a report.
   - Cons: the fallback brings back option 1's failure mode on exactly the runs most likely to be
     broken. A missing report then becomes a kill instead of a blocking diagnostic, which is what FR-016
     forbids.

3. **Only the structured report decides; the exit code can only downgrade a passing report to
   infrastructure** (chosen)
   - Pros: kill and survival are read from the testcases attributed to the matrix test, never inferred.
     Every ambiguous observation has a named infrastructure kind that blocks. It reuses the engine's
     single attribution and collection-error rules, and it is pure and table-testable.
   - Cons: it needs a runner that writes a fresh JUnit report naming the matrix test's file. A flaky or
     misconfigured runner blocks the gate instead of silently passing.

## Decision
**Only the matrix test's structured JUnit report decides killed, survived, invalid, red and green. The exit
code and signal can only turn an otherwise passing report into an infrastructure failure, and every
ambiguous observation is infrastructure, never a kill.**

### Components

- `engine/src/core/owner-verification/types.ts` defines the observation and the outcomes:
  - `MatrixTestRun` = `spawn-failed` | `timed-out { elapsedMs }` | `exited { exitCode, signal, report }`;
  - `MatrixTestReport` = `missing` | `unreadable { reason }` | `produced { bytes }`;
  - `MutantOutcome` = `killed` | `timed-out` | `survived` | `invalid { collectionErrors: NonEmpty }` |
    `infrastructure { failure }`;
  - `BaselineOutcome` = `green` | `red { failures: NonEmpty }` | `infrastructure { failure }`;
  - `OwnerInfrastructureFailureKind` is the closed set of named failure kinds.
- `engine/src/core/owner-verification/outcome.ts` (pure) exports `classifyMutantRun(run, matrixTest)` and
  `classifyBaseline(run, matrixTest)`. Both go through one private `readRun`, which reads the report first
  and consults the exit code only for a passing report, so the two classifiers cannot disagree about what
  a run says. The module also exports `verifiedMutationOf`, the only constructor of the branded
  `VerifiedMutation`. It refuses a negative or non-integer count, it refuses generated or unmutated
  mutants when the owner did not change in the Wave, and it refuses generated mutants that are all
  invalid (`no-valid-mutants`): such a run carries no mutation evidence, so it can never be a verified
  run, whether the gate tallied it or a persisted result is read back.
- Report parsing goes through `parseJunitTestcases` in `engine/src/core/structured-test-report.ts`. A
  report must first pass the strict structured-report parser. A Vitest JSON report is refused by name,
  because it carries no per-testcase file attribution, and a testcase without a name or classname is also
  refused. Either refusal is `report-unreadable`.
- Attribution uses `attributeReportedFile([matrixTest], testcase.classname, null)` from
  `engine/src/core/report-file-attribution.ts`. An identity is attributed by an exact path, a unique
  whole-segment suffix, or a unique JVM class match, and an ambiguous identity stays unattributed. The
  repository root passed is `null`, so an absolute classname is left unattributed (fail closed).
- Collection errors are recognized by the one shared rule, `isCollectionErrorTestcase` in
  `structured-test-report.ts`: a testcase whose `name` equals its `classname`. The I6 per-file projection
  uses the same rule.

### The outcome table, as shipped

"Attributed" means a non-skipped testcase whose classname attributes to the matrix test.

| Observation | Mutant | Baseline |
|---|---|---|
| process timed out | `timed-out` (a kill) | infrastructure `baseline-timed-out` |
| spawn failed | infrastructure `spawn-failed` | same |
| exited without a report | infrastructure `report-missing` | same |
| report unreadable, unparseable, Vitest JSON, or a testcase without a name/classname | infrastructure `report-unreadable` | same |
| no attributed, executed testcase | infrastructure `matrix-test-not-collected` | same |
| ≥1 attributed failing testcase that is not a collection error | `killed` | `red` (names every failing testcase) |
| attributed failures, every one a collection/import error | `invalid` (names them) | `red` |
| every attributed testcase passes, exit 0 and no signal | `survived` | `green` |
| every attributed testcase passes, but a non-zero exit or a signal | infrastructure `exit-unexplained-by-report` | same |

The order of these checks is fixed in `readRun`/`readReport`. Timeout and spawn come first, then report
presence and parse, then attribution, then failures, and the exit code only last. A failing report is
therefore read as `killed` or `red` whatever the exit code, and the exit code never creates a kill.

### Shell and verdict wiring

- `matrixTestRunOf` in `engine/src/orchestration/owner-verification-runner.ts` maps a runner execution to
  a `MatrixTestRun`. A run that could not reach an observed end (refused authority, unconfirmed
  containment, a surviving process tree) becomes `spawn-failed`, never a report. Before every run,
  `engine/src/orchestration/owner-mutation-workspace.ts` deletes the runner's report path, so a stale
  report is never read as this run's.
- `engine/src/core/owner-verification/verdict.ts` (pure) assembles one `InvariantVerdict` per owed
  obligation (`invariantVerdict`). A baseline that is not green decides the mutation verdict before any
  mutant counts (`red-baseline` or `infrastructure`). With a green baseline, `tally` checks that the
  results are the plan's mutants in plan order; results that are not are the `plan-drift` infrastructure
  verdict, returned as data rather than thrown, so the core stays total. If any mutant outcome is
  infrastructure, the whole Invariant's mutation verdict becomes infrastructure, and it is never tallied
  as a kill. The other outcomes are counted through `verifiedMutationOf`; its refusal is an infrastructure
  verdict too: `no-valid-mutants` when every generated mutant is invalid, `plan-drift` for counts the plan
  cannot explain. An obligation declared `verify` whose run was skipped as exempt is `plan-drift`.
- `ownerVerificationFailures(observation)` lists the blocking findings in verdict order, coverage before
  mutation for each Invariant: missing siblings, a red baseline, every survivor (an exempt Invariant runs
  no mutant), and every infrastructure failure, including an `unavailable` observation with no Invariant.
  A survivor diagnostic (`SurvivorDiagnostic`) carries the mutant id, operator, line, column, original
  text and mutated text. `renderOwnerVerificationFailure` renders it with the Invariant, owner path and
  matrix test, and it names the remedy: strengthen the matrix test, or declare a mutation exemption
  (AS-011).
- The operator-facing remedies for each kind are in `docs/operations.md`, under "Owner verification
  blocks a Wave Gate (G5b)".

### Where the shipped code is more specific than the plan seed

- "Zero attributed testcases" is shipped as zero attributed *executed* testcases. Skipped testcases are
  dropped before the count, so a matrix test whose cases are all skipped is `matrix-test-not-collected`,
  not `survived`.
- "Report unparseable" includes a structurally valid Vitest JSON report and a JUnit testcase without a
  name or classname. Both are `report-unreadable`, so the runner must produce JUnit.
- `spawn-failed`, `report-missing` and `report-unreadable` are separate named kinds, not a single
  "infrastructure" bucket.
- "Signal" is part of the passing-report check: a passing report with a signal and no exit code is
  `exit-unexplained-by-report`.

Tests: `engine/tests/core/owner-verification-outcome.test.ts` covers every table row;
`engine/tests/core/owner-verification-verdict.test.ts` covers verdict assembly and failure rendering;
`engine/tests/orchestration/owner-verification-runner.test.ts` exercises real kill, survive, invalid,
timeout and infrastructure runs against a git fixture.

## Consequences

**Positive:**
- A mutant counts as killed only when an assertion-bearing testcase of the matrix test failed, or when the
  run timed out. Crashes, import failures and misattributed reports can no longer inflate the kill count.
- Every unreadable run blocks with a named kind and a remedy that `helper orchestration status` and the
  gate diagnostic share, so an operator never has to guess why the gate refused.
- One attribution rule and one collection-error rule serve both I6 red-then-green evidence and G5b owner
  verification. A fix to either rule reaches both.
- Classification and verdict assembly are pure, so the whole table is unit-tested without spawning a
  runner, and the shell stays a thin translation of process facts into `MatrixTestRun`.
- The exit-code rule catches runners that report green but exit non-zero (a teardown crash, a threshold
  step), instead of reading them as survivors.
- AS-012 keeps an invalid mutant neither killed nor survived. As shipped in #127, a run whose every
  generated mutant was invalid verified as a pass with zero kills. The PR #131 review remediation makes
  it the blocking `no-valid-mutants` infrastructure failure: generated > 0 with no kill, timeout or
  survivor means the matrix test proved nothing about the owner. A run with invalid mutants beside a kill
  or a survivor still verifies, and its survivors still block as survivors.
- An owner the TypeScript parser reports syntax errors for has no mutation plan: `mutationPlan` returns
  `owner-unparseable` with every diagnostic, and the shell records it as that infrastructure failure, so a
  garbled tree never yields a silent or vacuous plan (ADR-0035 records the shared parse).

**Negative:**
- Owner verification needs a JUnit-writing `affectedRunner`. A project whose runner only emits Vitest JSON,
  or no report at all, must reconfigure it before any non-exempt owned Invariant can pass. Population
  refuses a plan with no runner (`owner-verification-runner-missing`), but an incompatible report
  format is found only at the first gate.
- A single infrastructure mutant turns the whole Invariant's mutation verdict into infrastructure, which
  discards the counts of the other mutants. A run whose every mutant only fails to collect blocks as
  `no-valid-mutants` until the matrix test can load the mutated owner, or the Invariant declares an
  exemption. One flaky run costs a full gate re-run, and there is no
  automatic retry.
- A timeout counts as a kill (FR-013), so a mutant that only makes the matrix test hang is credited as
  detected. This is accepted because an infinite loop is an observable behavior change. The baseline's
  timeout, by contrast, blocks.
- Collection errors are recognized by a heuristic (`name === classname`). A runner that reports
  collection failures in another shape could make an import-breaking mutant read as `killed` instead of
  `invalid`. The rule is shared with I6, so both gates would be wrong in the same way and would be fixed
  in one place.
- Attribution passes a `null` repository root, so a runner that writes absolute classnames is always
  `matrix-test-not-collected` until it reports repository-relative or runner-cwd-relative paths.
