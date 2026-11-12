# Implementation proof

How a Task's implementation is attempted, observed, proved and settled. Core terms (Implementation Attempt, Settlement, Evidence Ledger, Epoch, Proof Obligation, Verification Manifest, Distill Task, …) are in the root [CONTEXT.md](../../../CONTEXT.md).

## Language

### Attempts and settlement

**Implementation Window**:
An execute Wave with no live Wave Gate: before its gate starts, or after an abandoned run that names no successor. Within it one classification decides which Tasks are active, reclaimable, escalated or dispatchable; a **Distill Task** is withheld until every other Task of its Wave is implemented.
_Avoid_: Unstarted Wave (alone), pre-gate state

**Implementation Binding**:
On Claude Code, the exact link between one running implementation Agent and the Implementation Attempt its own trusted first prompt names: pending (its prompt is not yet readable), bound, or refused. Only bound admits writes, and it is never inferred from which reservations are pending. Pi binds at spawn through Write Grants and has none.
_Avoid_: Write grant (Pi's mechanism), reservation guess, roster role

**Predecessor Output**:
What one completed direct dependency produced, as the dependent Task's brief shows it: its description, its Requirement Completion Claims, the files it changed and the declared files it left unchanged. Derived only from protected Task state, never from an Agent's summary.
_Avoid_: Task summary, handoff notes, dependency report

**Implementation Retry Context**:
The immutable prompt appendix derived from one first-attempt settlement that required a retry, binding the Task, the second attempt, the predecessor receipt and the failure kinds. An infrastructure failure mints none; a second semantic failure escalates instead.
_Avoid_: Failure reason, retry prompt, retry count, attempt token

**Implementation Completion Oracle**:
The pure aggregate command that combines attempt authority, the normalized observation, Proof Obligations, Verification Policy and a Completion Suite Result into exactly one transition: implemented, retry required, escalation required, infrastructure blocked, or ignored stale or duplicate evidence. Both harnesses adapt into it; neither is a separate completion authority.
_Avoid_: SubagentStop hook, Wave Gate check, test runner, completion service
_Mechanics_: One transition applier consumes its output, appends the settlement receipt, releases only matching authority, and invalidates review, spec-check and Wave state atomically.

**Implementation Settlement Receipt**:
The immutable, self-digested audit record of one Implementation Attempt's transition. Retry and escalation receipts consume the semantic attempt; implemented and infrastructure-blocked receipts do not.
_Avoid_: Rollback receipt, cleanup log, retry counter
_Mechanics_: Receipt identity makes duplicate delivery idempotent; matching the exact active authority and reservation digest stops a late result from releasing a newer reservation.

**Task-local Byte Scope**:
The exact path set an attempt is judged on: the Task's declared paths plus those previously attributed to it. Changes there are the Task's; changes to a same-Wave sibling's paths are inert; a change to any other path is out-of-scope evidence against the attempt, whether or not the transcript mentions it.
_Avoid_: Repository dirty set, transcript file list, Task test command
_Mechanics_: Every settlement retires the attempt's boundary, so repository movement between attempts is never attributed to the Task; only an attempt that ends without settlement leaves its boundary for the next registration.

**Proof Boundary Observation**:
The immutable record of whether TaskGraph Population captured every Task's declared-artifact proof boundary from Git at one revision, or why it could not. Explanatory provenance, not settlement authority.
_Avoid_: Boundary flag, capture status, Git health

### Verification

**Verification Policy**:
A Task's explicit, independently modeled requirements for regression execution and new-test creation, including typed waiver reasons.
_Avoid_: Test flag, new-tests flag, test exemption

**Completion Check Result**:
One engine-observed deterministic check outcome carrying independent exit-code, timeout, signal, and report-production facts under an exact check identity and Task-or-Wave scope. Spawn failure is a separate arm, never disguised as a failed test.
_Avoid_: Test evidence, command output, exit status

**Completion Suite Result**:
A non-empty exact set of Completion Check Results bound either to one Implementation Attempt or to one quiescent Wave workspace. Missing, surplus, duplicate, stale, or wrong-scope results cannot settle completion.
_Avoid_: Test run, CI result, lint result

**Project Verification Coverage**:
A read-only statement of which project checks are configured, independent of whether any passed. A Wave with only reserved checks may advance, but cannot claim that project verification passed.
_Avoid_: Test coverage, project-check pass, verification waiver, persisted coverage flag

### Test-first proof

**Red-Then-Green Obligation**:
The **Proof Obligation** that a Task show test-first work within one attempt's ledger facts, in order: a failing testcase in one of its test files, then the first write to one of its implementation files, then a passing run covering every one of its test files. Owed by a Task that requires new tests and is neither a claimant nor a Contract Task. It covers logged facts only: a write that mints no ledger event is a hole it cannot see.
_Avoid_: TDD check, test-first gate, red/green (alone)

**Test-File Classification**:
The frozen split of paths into test files and implementation files, made by file-name suffix only. Every declared path that is not a test file is an implementation file, fixtures and helpers included. Its presence in a TaskGraph is what makes the Red-Then-Green Obligation owed.
_Avoid_: Test glob, test pattern (alone), spec file

**Evidence Minting Rule**:
The one rule that turns a tool call into Evidence Ledger facts on both harnesses: each harness reduces its event to one normalized tool call, and a single pure extraction mints the facts from it.
_Avoid_: Recorder (alone), evidence hook

**Changed Files**:
A Task attempt's files as of its stop: the paths its Epoch's ledger recorded as written, without repeats, inside the repository and still existing. Files written with no ledger event are not among them.
_Avoid_: Diff, modified files, touched files

### Stop checks

**Affected-Test Stop Check**:
At every implementation Agent's stop, the engine runs the manifest's affected runner over the attempt's **Changed Files**; a failing affected test blocks the stop, a bounded number of times, so the same Agent keeps working. It fails open on every fault, is report-only on Pi, and is never completion evidence.
_Avoid_: Affected gate, regression check, test cadence

**Task Mutation Check**:
The check an implementation Agent runs on its own Task before it stops: it mutates the lines the Task changed, runs the affected runner against each mutant, and names every mutant the tests did not kill. A run whose every mutant only broke collection or ran no test is inconclusive, never clean. A missing, stale or surviving result blocks the stop on Claude Code, a bounded number of times. It fails open and is never completion evidence.
_Avoid_: Mutation gate, mutation testing (alone — **Owner Verification** also mutates), Task-level Owner Verification (that is the Wave Gate's, over an Invariant's owner)

**Task Mutation Record**:
What one **Task Mutation Check** run leaves: its result (no mutants, clean, survivors, inconclusive or unavailable; clean always names a kill) with a digest of the bytes it judged, so a record of other bytes is stale. One runtime file per Task, never in the TaskGraph.
_Avoid_: Mutation receipt, mutation proof (it proves nothing to settlement), mutation evidence
_Mechanics_: Keyed by Task, not by Agent, because the check cannot learn which Agent ran it.

**Stop-Check Plan**:
The read-only view of what the acceptance and affected-test stop checks would do at one Task's stop: the same pure plan both live checks decide from. It runs nothing.
_Avoid_: Dry run, stop-check preview, acceptance dry run

### Distill and reopening

**Task Role**:
What a **Task** is in its TaskGraph: authored (the decompose roster wrote it) or distill (a **Distill Task**). Every rule that differs between the two is one field of the role's policy. Derived, never stored.
_Avoid_: Task kind, Task type (the Agent's kind is a different thing), distill flag

**Distill Scope**:
A **Distill Task**'s file list, and the only files the pass may edit: the implementation files its Wave's authored Tasks list, other than Contract Tasks' and ADR Tasks', minus every Acceptance Contract's frozen paths. It never holds a test file, so the pass cannot weaken the tests that judge it.
_Avoid_: Wave diff, distill file list (alone), **Changed Files** (those are one attempt's ledger writes)

**Task Reopening**:
The operator-only operation that returns an implemented Task of the active Wave to pending at a new Review Generation, so a Wave Gate Finding on it can be fixed. The Wave's settled **Distill Task** returns with it.
_Avoid_: Re-dispatch (alone), reset, force re-populate

## Relationships

- An **Implementation Attempt** is settled only by the **Implementation Completion Oracle**, leaving exactly one **Implementation Settlement Receipt**
- A first-attempt semantic failure yields exactly one **Implementation Retry Context**
- An implementation Agent on Claude Code has at most one **Implementation Binding**
- A dependent Task's brief shows one **Predecessor Output** per direct dependency
- A Task has exactly one **Verification Policy** and exactly one **Task Role**
- A **Completion Suite Result** holds one or more **Completion Check Results**
- A Task-scoped suite holds only the **Task-local Byte Scope** check
- A TaskGraph has at most one **Test-File Classification**
- The **Evidence Minting Rule** is the only source of Evidence Ledger facts on either harness
- **Changed Files** feed only the **Affected-Test Stop Check** and the **Stop-Check Plan**
- A Task has at most one **Task Mutation Record**
- No stop check can satisfy or fail a Proof Obligation
- A **Distill Task** has exactly one **Distill Scope**
