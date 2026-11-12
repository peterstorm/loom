# ADR-0068: The distill pass is an engine-added Task per Wave

## Status
Accepted (2026-11-11). Implements Q1 of the deterministic-implementation plan's Q-track.

## Context
Across 1,247 labelled review findings, the simplification lens (`code-simplifier`, which runs the `distill`
skill in review mode) is the largest single source: 389, or 31%. Every one of them is found at review, after
the code settled, and costs a fix run. The only thing asking for the pass earlier is a "Distilled" checkbox in
the `code-implementer` skill, which nothing observes.

Half of the rule is already enforced. A write after the last trusted test pass demotes that pass
(`resolveTestEvidence`), and a write outside the Task's scope fails settlement. What is missing is proof that
a distill pass happened, done by something other than the author.

## Options Considered

1. **A third stop check that sends the implementer back to distill.**
   - Cons: stop checks fail open by design (ADR-0028). A Claude Code stop that ended with a hand-back settles
     anyway and the block becomes a note. On Pi the child has already ended, so the check is report-only. It
     is also the author distilling its own code in the same context.

2. **A distill phase inside the Wave Gate.**
   - Cons: no agent may write while a gate is live, on either harness. It needs a new write admission with a
     per-file allow-list, a new gate state, and a rollback story the gate does not have.

3. **A third attempt kind on the same Task.**
   - Cons: `SemanticAttempt` is `1 | 2` and is the retry budget. The Task lifecycle union is closed. It needs
     a new lifecycle state, a new dispatch kind and a State File change for every Task.

4. **A step in the implementation brief.**
   - Pros: small.
   - Cons: nothing proves it ran. It is the existing checkbox in a more visible place.

5. **One engine-added Task per Wave (chosen).**
   - Pros: attempt authority, write admission, byte scope, test evidence, retry and settlement are the ones
     every Task already has. A fresh agent does the pass and sees copies across the Wave's Tasks.
   - Cons: one more agent per Wave. Dispatch needs its first in-Wave ordering rule.

## Decision

### 1. The Distill Task
A **Distill Task** is a Task whose `agent` is `distill-agent`. That is its whole identity, as
`adr-writer-agent` is the ADR Task's. `distill-agent` is a new Agent Catalog entry of kind `impl`, with the
`implementation` profile and required Skill `distill`. An authored roster may not name it: the decompose
payload is refused, as an authored engine-only waiver reason is.

### 2. Population adds it
`populateTaskGraph` adds at most one Distill Task per Wave, after the authored Tasks, from one pure function
(`core/distill-task.ts`, the owner of every rule in this ADR that is not proof evaluation).

- **Sources.** The Wave's authored Tasks that are neither a Contract Task nor an ADR Task.
- **Distill Scope.** The sources' `file_list` entries that the frozen **Test-File Classification** calls
  implementation files, minus every Acceptance Contract's frozen paths, deduplicated in first-appearance
  order. Test files are excluded so the distiller cannot weaken its own oracle; fixture copies are the
  `no-duplicate-block` lint rule's job. Frozen paths are excluded because a second Task listing them makes
  the State File refuse to load.
- **No Task** when the scope is empty, when the frozen manifest carries no classification, or when the
  operator's verification manifest says `"distillPass": "off"`.
- **Fields.** Id `T<n>`, numbered after the highest authored id in Wave order. `depends_on: []`, no
  Requirement trace, `file_list` = the scope. Verification Policy: regression and new tests both waived with
  the engine-only reason `distill-pass`, because its one obligation carries the test requirement (below).
  No population proof baseline: its declared-artifact baseline is stamped at its first registration, which
  is the bytes its siblings left.

### 3. Dispatch withholds it
A Distill Task is dispatchable only when every other Task of its Wave is `implemented` or `completed` and
holds no reservation. One predicate decides it for `classifyImplementationWindow` (status never offers the
dispatch early) and for `taskExecutionDecision` (registration refuses it early, on both harnesses).
`depends_on` cannot say this: dependencies must sit in an earlier Wave and must be `completed`.

### 4. Its Proof
Obligation derivation gains a third `DeclaredArtifactExpectation`, `preserved`, selected for a Distill Task.
It yields exactly `task-completed` and one new obligation, `behaviour-preserved`:

- satisfied when the attempt left every scope path as its attempt baseline captured it; or
- satisfied when the attempt changed scope paths, the regression verdict is a pass the evaluation policy
  admits, and no changed path violates contract conformance;
- failed otherwise, with the existing regression or contract-violated failure.

Changing nothing is a legal outcome. New tests and red-then-green are never owed. The evidence records which
of the three bases held: `unchanged`, `tests-passed`, or `restored`.

### 5. A failed pass is restored, not retried
A distill pass that cannot prove it preserved behaviour must not cost the Wave anything.

- **Snapshot.** Registration of a Distill Task attempt stores the scope's bytes as one Git tree
  (`git hash-object -w` per leaf, built in a throwaway index) kept alive by the ref
  `refs/loom/distill/<authority digest>`. Nothing is recorded on the Task. The ref is deleted once the
  attempt settles semantically, and kept when it settles `infrastructure-blocked`. One entry point, used by
  both transports, settles the attempt, persists the settled state, and only then deletes the ref: a
  settlement whose state never lands keeps the snapshot its re-run restores from. A delete that is lost
  after the state landed leaves a ref the Task's next registration drops.
- **Decision.** Settlement first settles the attempt's bytes as a trial. One pure function over the
  attempt's changed scope paths and the trial settlement answers both questions: `keep` or
  `restore(reasons)` for the bytes, and `keep` or `discard` for the snapshot. It restores exactly when the
  attempt changed scope paths and the trial would settle anything but `implemented`.
- **Restore.** The settlement shell writes the snapshot back, re-observes the scope, and settles on the new
  observation. The obligation is then satisfied on the `restored` basis, which keeps the reasons. A restore
  that fails, or leaves a path differing from the baseline, is `infrastructure-blocked`.
- **Not restored.** Writes outside the scope. The engine holds no bytes for them, so they fail the attempt
  as they do for any Task: retry, then escalation.

### 6. Review
A Distill Task is exempt from Wave review. The exemption is explicit, never an empty **Wave Review Roster**
(§9). Its siblings' Review Packets read current bytes, so they review the distilled code. Reviewing the Distill
Task itself would review the whole Wave a second time.

### 7. Reopening
Returning any Task of a Wave to revalidation (Task Reopening, Contract Revision, a reopened completed Wave)
returns that Wave's settled Distill Task too, so re-implemented code is distilled again.

### 8. Brief and machine
The dispatch carries a fixed distill appendix, which the spawn gate binds as exact lines (§9). It states
the scope, the rules (green baseline before the first edit; one move, then the same tests; only the listed
files, never a test file or an exported signature; one final report-writing run) and that leaving the code
unchanged is an acceptable result. `machines/distill-agent.machine.json` denies Edit, Write and MultiEdit
before a passing test run on Claude Code; it does not check that a pass follows the last write. Pi has no
live phase gate; settlement is the authority on both.

### 9. Rulings the implementation needed
- **"Changed" is the raw byte delta.** `behaviour-preserved` judges the attempt's scope paths against its
  attempt baseline (`attemptScopeChangedPaths`), not the transcript-attributed set, so a write no tool call
  reported still counts as a change.
- **Review is an explicit exemption, not an empty roster.** `waveTaskReviewRoster` answers
  `{ kind: "exempt", reason: "distill-task" }`. The Distill Task stays in the gate's registered Task ids and
  in the spec-check scope, contributes no subject, packet, slot, workspace observation or epoch entry, and
  completes without a review status of `passed`. A Review Run stored on one is a roster problem.
- **The appendix is bound as exact lines.** It is multi-line prose, so the spawn gate compares whole lines
  from its header line `LOOM_DISTILL_PASS: 1`. A non-Distill prompt carrying that label is refused.
- **Batch registration.** Tasks registering in the same batch count as reserved, so a Distill Task is never
  admitted beside a sibling. A sibling with a stranded reservation is re-dispatched before the pass.
- **Red window.** A Distill Task keeps `distill-pass` in a red-window Wave. Its regression run is the tests
  covering its scope without the contract's pending acceptance files, which the brief says; the Wave Gate's
  acceptance-aware suite stays the authority over the Wave.
- **Reopening a completed Wave** sweeps the `completed` Distill Task back too, and the operator's proof must
  name it.
- **Reopening audits say what was swept.** `TaskReopeningAudit` and `WaveReopeningAudit` carry an optional,
  non-empty `sweptDistillTaskIds`: the reopened Distill Tasks that returned because a sibling did. For a
  Task Reopening those are the ids the operator did not name, and its replay check and message read the
  field instead of the roster. For a completed Wave the operator names them too, and the field says they
  were never proven drifted. A Contract Revision's audit has no such field: its operator names a contract,
  never a Task, so every id it lists is engine-derived.
- **The legacy manual review override refuses it.** `helper store-review-findings` writes no review state
  onto a Task that `waveReviewStanding` exempts.
- **No skeletons.** Registration writes no Skeleton for a Distill Task: it implements nothing, and a bound
  path missing from its scope is a sibling's deletion to judge, not a file to scaffold.
- **Attestation and reconcile.** A Distill Task cannot be armed for attestation. Proof reconcile treats it
  as it treats any Task whose attempt is over: from stored evidence, never by re-reading bytes against a
  baseline that settlement retired.
- **Owner Verification.** The Distill Task is invisible to the family schedule and the mutation plan's Wave
  base. Owner lines it rewrote are still the Wave's changed lines and are mutation-verified at the gate.

## Consequences
- Every Wave with implementation files runs one more agent. `"distillPass": "off"` removes it for a project.
- A sibling's stored test result describes bytes the Distill Task may have rewritten. The Distill Task's own
  proof and the Wave completion suite cover the rewritten bytes; with an engine-default manifest only the
  first does.
- A discarded snapshot's objects stay in the object store until Git prunes them.
- The proof is as strong as the test run the agent chose. It is the same trust every Task's regression
  obligation has.
- A TaskGraph populated before this ADR has no Distill Tasks and owes none.
- Requirement Trace Amendment rosters must list the Distill Tasks, with empty traces. An amendment that
  gives one a trace is refused.
- **Not restored: an attempt that never settles semantically.** A Distill Task attempt that ends
  `infrastructure-blocked`, or whose reservation is reclaimed, keeps whatever it wrote. Those bytes become
  the next attempt's baseline, so that attempt can settle `unchanged` over edits no test run proved. The
  engine does not restore at the next registration, because a sibling re-implemented or an operator edit
  made in between would be reverted with them. The edits still meet the siblings' reviews and the Wave
  completion suite, which is what every Wave had before this ADR. The kept ref
  (`refs/loom/distill/<authority digest>`) is the operator's copy of the starting bytes.
- **Snapshot refs can outlive their attempt** after an infrastructure-blocked settlement, a reclaimed
  reservation, or a re-population. The Task's next registration discards those of its settled attempts.
  Nothing sweeps `refs/loom/distill/*`: refs are shared across linked worktrees, and a sweep from one
  TaskGraph could delete another's live snapshot.
- **A restore re-run after a crash loses the reason.** If the process dies after the restore and before the
  State File write, settling again reaches the same `implemented` transition on the `unchanged` basis, not
  `restored`.
- **An `implemented` receipt cannot say a restore happened.** Only the Task's Proof does. The restored
  Task's stored test result is the agent's failing one.
- **A bound scope path that is missing at the Distill Task's registration records the outcome
  `absent-no-skeleton-owed`** ("absent, no skeleton owed"), so "every production path has one outcome"
  holds for a Distill Task too and the sibling's deletion is visible in status and the brief. The State
  File admits that outcome only on a Task that holds no Skeleton, at a bound path that is a skeleton
  target. Stage-two binding problems block the binding's real holder, not the Distill Task.
