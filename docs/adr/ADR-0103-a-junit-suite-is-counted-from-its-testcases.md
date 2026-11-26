# ADR-0103: A JUnit suite is counted from its testcases

## Status
Accepted (2026-11-26). Amends ADR-0100: its premise that no real runner writes a JUnit report whose
testcase elements and summary counts disagree is false.

## Context
ADR-0100 reconciles two counts from one structured report. The declared-count rule counts every declared
testcase, skipped included, with per-file results; the executed-count rule counts only the testcases that
ran. For JUnit XML, `parseTraditionalJunit` required a suite's `tests` attribute to equal the sum of its
`<testcase>` children. A report whose attributes disagreed was refused as `malformed-counts` and the run
stayed untrusted.

Surefire + jqwik writes exactly that disagreement. A class mixing `@Test` and `@Property` writes one
`<testcase>` per generated invocation but a `tests=` attribute that counts containers and test methods.
A real mixed jqwik/Jupiter class therefore reported `tests="7"` around twelve invocations. A `@Nested`
layout could also write an outer suite whose `tests` attribute did not count the cases in its nested
suites. In both shapes the run could never show I6 green, even when every test ran and passed (loom#242),
and the only workaround was to restructure the test class.

## Options Considered

1. **Keep requiring the attribute to equal the testcase sum.**
   - Pros: One simple reconciliation rule; a suite that disagrees with its cases is never trusted.
   - Cons: Refuses a real, fully reported green run from a supported runner. Mixed-engine, jqwik-only and
     `@Nested` JVM suites remain unattributable completion evidence, so I6 green can never be shown.

2. **Trust the suite attributes and ignore the testcase elements.**
   - Pros: No disagreement to reconcile.
   - Cons: The per-file results and the failure evidence are the testcase elements; a suite-level count
     cannot say which file ran or which test failed. A claimed failure with no element would become
     unreadable evidence.

3. **Count a suite from its testcases when its subtree lists them (chosen).**
   - Pros: Real Surefire + jqwik reports parse; the elements remain the executed facts and the per-file
     evidence; a claimed failure with no failing element is still refused; no wire change.
   - Cons: A suite's `tests` attribute is no longer an independent cross-check when cases exist. An
     underclaim is accepted as runner metadata.

## Decision
**Within one JUnit suite whose subtree lists `<testcase>` elements, those elements are the executed facts:
total, failed and skipped derive from them, and the suite's `tests`, `failures`, `skipped` and `disabled`
attributes are runner metadata in value.**

The attributes must still parse: a traditional testsuite must carry a numeric `tests` attribute (a
`testsuites` root falls back to the observed total) and `failures`, `errors`, `skipped` and `disabled`
must be numeric when present. Only the values of `tests`, `skipped` and `disabled` are discarded; the
`failures + errors` values are still checked against the elements.

In `engine/src/core/structured-test-report.ts`, `parseTraditionalJunit` aggregates the testcase elements
and returns their counts when the subtree lists any. A suite whose `failures + errors` attribute claims
more failures than its elements show is still refused as `malformed-counts`: a claimed failure with no
element cannot be read as a pass. A summary-only suite (no testcase elements) keeps the strict attribute
accounting, so it still reconciles or is refused. The `testsuites` Node dialect and the Vitest JSON rule
are unchanged.

ADR-0100's two counts still read the same derived counts, so `readTestRunSummary` continues to hold them
equal. The declared-count rule still counts every element, skipped included; the executed-count rule still
counts only those that ran.

## Consequences

**Positive:**
- A mixed jqwik/Jupiter, jqwik-only or `@Nested` Surefire report now yields a structured report and per-file
  results, so a green JVM run can satisfy I6.
- The failure evidence stays in the testcase elements: a suite cannot claim a failure the report does not
  show.
- Summary-only reports keep the strict accounting they had.

**Negative:**
- When testcases exist, a suite's `tests` attribute is metadata and an underclaim is accepted. The
  attribute is no longer an independent check on how many tests ran.
- A report whose testcase elements omit a failure the suite claims stays untrusted rather than being
  repaired from the attribute.
