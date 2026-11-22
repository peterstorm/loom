# ADR-0100: A TestRun passes only when a test executed

## Status
Accepted (2026-11-22).

## Context
One read of a structured test report (`readTestReport`) yields two counts. The declared-count rule counts
every declared testcase, skipped, pending and todo included, with per-file results. The executed-count rule
counts only the testcases that ran. Completion checks and remediation already require the executed count to
be above zero, so an all-skipped report never became completion evidence.

TestRun facts took the declared summary as it was, and `judgeTestRun` read its `total` as "tests that ran".
A Vitest JSON or JUnit report whose every test was skipped therefore reached the judge as `total > 0` with no
failure and was a `trusted-pass`, although the executed-count rule read the same bytes as 0 executed. A Task
whose tests were all skipped or todo could satisfy the regression proof without any test running, and
nothing said so. The intended rule, "a report with zero tests is a trusted non-pass because nothing ran",
was stated in the judge and the docs, but held only for reports that declared no test at all.

The ledger stores a summary as `total`, `failed`, `source` and per-file results, and the results reconcile
with `total` under the declared rule (INV-8). Existing ledger lines are read back and judged again.

## Options Considered

1. **Store the executed count as `total`.**
   - Pros: One count, the one the judge needs.
   - Cons: Changes what a stored `total` means and the INV-8 reconciliation, so every existing ledger line
     with a skipped test would stop reading back. It would also refuse the summary-only Vitest JSON that
     carries no passed, pending or todo counts.

2. **Add a separate executed or skipped count to the summary.**
   - Pros: Explicit.
   - Cons: A new wire field on every ledger line and engine receipt. The per-file results already hold the
     skipped count for every report that lists its testcases.

3. **Derive the executed count from the summary, and hold capture to the executed-count rule (chosen).**
   - Pros: No wire change. Old ledger lines with per-file results are judged correctly too. The invariant
     lives in two pure functions.
   - Cons: A summary with no per-file results has no skip facts, so its `total` must already be the
     executed count; capture and merge have to keep that true.

## Decision
**A TestRun is a trusted pass only when its report proves at least one test executed. A report in which
nothing executed takes the existing zero-test verdict, `trusted-fail` ("nothing ran"); no new verdict is
added.**

In `engine/src/core/structured-test-report.ts`:

- `executedTestCount(summary)` is the number of tests a summary proves ran. With per-file results it is
  the sum of `executed - skipped`; without them it is `total`.
- `readTestRunSummary(read, format)` is the only projection TestRun capture uses (`findReport`'s three
  report sources, the JUnit report-dir scan through `junitReportRead`, and, through its null projection
  `testRunSummary`, `engineRunReport`). It replaces the declared-count projection, which is deleted. It
  takes the declared summary and holds it to the executed-count rule wherever that rule reads the same
  bytes:
  - with per-file results, the summary is kept only when `executedTestCount` equals the executed-count
    rule's total, else it is refused as an `executed-count-disagreement` (the run is untrusted, and a
    report-dir scan is refused);
  - without per-file results, the summary is minted from the executed-count rule's counts;
  - when the executed-count rule cannot count the report (a Vitest summary without its passed, pending
    and todo counts), the declared summary stands.

  Every refusal is a named `TestRunSummaryRefusal`, which `findReport` writes to stderr through
  `describeTestRunSummaryRefusal`, so an operator can tell a malformed report from one of the other
  format or one whose counts disagree about what ran.
- The seam enforces this by type, not by convention: a read's declared summary is held under a symbol
  key the module does not export, so no caller can take it without the executed-count check.
  `readTestRunSummary` and `executedTestCount` are the only ways to a TestRun summary and its count.
- `mergeSummaries` sums `executedTestCount` when the merged result loses per-file results, so a recorded
  part's skipped testcases never reappear as run.

In `engine/src/machine/test-report.ts`, `judgeTestRun` requires `executedTestCount(report) > 0` where it
required `report.total > 0`.

Bun console summaries and `runner-crash` summaries record one failing testcase per file, so they are
unaffected. The Pi evidence path mints its TestRun facts through the same extraction and `findReport`, so
it needs no change of its own.

## Consequences

**Positive:**
- The two count rules can no longer disagree about whether a TestRun ran a test: a property test pins that
  no report whose executed count is 0 judges `trusted-pass`.
- Ledger lines written before this change, whose per-file results show every test skipped, now judge as
  `trusted-fail` on read-back, as they always should have.

**Negative:**
- A recorded report whose per-file results and summary counts disagree about how many tests ran, which no
  real runner writes, now leaves the run untrusted instead of judged.
- A legacy ledger line without per-file results keeps the `total` it was written with, which may count
  skipped tests. Nothing on the line can tell them apart.
