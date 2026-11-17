# ADR-0080: A failure in another in-flight Task's test file is that Task's to fix

## Status
Accepted (2026-11-17). Implements loom#199, Cause 1.

## Context
A Task's regression verdict was the verdict of the last trusted test run its Agent ran: any failing test
failed the Task. Within one Wave, Tasks often change coupled code. A Task whose test file another Task of
the same Wave is still changing sees that file red until its owner finishes, and the failure was charged
to whichever Task happened to run it.

A live fugue-dags run hit this. Forward Fix T28 delivered its own work, and its own tests passed. Its
final attempt still escalated, because the run also contained a failing test in T25's file, and T25 was
waiting on T28 to finish. The escalated T28 never settled, so T25, and T12 behind it, could never run.

## Options Considered

1. **Exclude failures in test files another in-flight Task of the Wave owns (chosen).**
   - Pros: the owner of a file judges its own outcome; a Task that breaks someone else's settled test
     still fails; no baseline run is needed; it works with both evidence modes wherever per-file results
     are recorded.
   - Cons: a failure in an in-flight Task's file that this Task caused is not charged to it. That owner's
     own attempt, and the Wave Gate's completion suite, judge the file instead.

2. **Judge only the Task's own test files.**
   - Cons: a Task that breaks a settled Task's or a sealed Wave's test would pass its own proof and
     surface only at the Wave Gate. It is too weak for a check called regression.

3. **Excuse failures already present at the attempt's baseline.**
   - Cons: it needs a baseline test run per attempt, which neither evidence mode records, and it
     still charges a Task for a coupled file that turned red during its sibling's attempt.

## Decision
`resolveTestEvidence` takes a regression scope: the files of every other Task of the settling Task's
Wave that is not `implemented` or `completed`, mapped to their Task (`foreignTestOwners`). A trusted
failing run counts as this Task's pass only when all of the following hold (`attributeRegressionFailures`):

- the report recorded per-file results;
- every failing or collection-error file maps to such a foreign file;
- at least one test outside the foreign files executed (not skipped) and none of those failed.

Otherwise the failure stands, exactly as before. An attributed pass is then judged like any pass: a later
`FileWrite` demotes it. The evidence label names each excused file and its owner. Settlement reads the
roster from the pre-lock graph; a Task that settles meanwhile only stops excusing failures in its files.

## Consequences
- Coupled Tasks in one Wave no longer escalate each other on red files their sibling is still changing.
- A Task still fails for any test it breaks outside in-flight Tasks' files, including settled and sealed
  ones. The Wave Gate's completion suite judges the whole suite before the Wave completes.
- A report without per-file results (`unrecorded`) keeps the whole-run verdict. Per-file results are what
  make attribution sound, so engine-run evidence (ADR on loom#198 Cause 1) strengthens this.
- The Pi transport is unaffected. Its implementation verdict (`implementationTestResult`) is always
  `untrusted`, read from the child's structured test result or its transcript, never a trusted ledger
  failure, so it has no trusted failure to attribute.
