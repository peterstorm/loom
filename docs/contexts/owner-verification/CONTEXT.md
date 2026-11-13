# Owner verification

Plan invariants and the rule that each has one implementation: who owns an invariant, who else applies it, how the Wave Gate verifies that, and the lint tiers and module surfaces that enforce invariants on every edit. The core term **Owner Verification** is in the root [CONTEXT.md](../../../CONTEXT.md).

## Language

### Invariants

**Checkable Invariant**:
A plan invariant (`INV-N`, tier `checkable`) expressed as a lint rule enforced fail-closed on every edit. Invariants that cannot be deterministically checked are tiered `advisory` and stay honest prose.
_Avoid_: Constraint (too generic), rule (alone), enforced guideline (advisory rules are never enforced)

**Tier**:
The execution scope that decides which lint rules run: "immediate" (after each edit: the regex rules and the few programmatic rules marked immediate, under a per-file deadline) or "full" (at the Wave Gate or an explicit scan: every rule, including structural analysis).
_Avoid_: Level, mode, severity

**Public Surface**:
The curated list of symbols a module publishes to callers outside it. Deliberately not the union of what its parts export: a sub-module exports a symbol so its siblings can use it, which says nothing about what outside callers need. The distinction is enforced, because the compiler cannot see an export with no importer.
_Avoid_: Barrel, API surface, exports (bare), the index

### Ownership

**Invariant Owner**:
The one module a plan invariant names as the only implementation of its rule. Every invariant, checkable or advisory, names its owner or says it has none and why (a prohibition or an unobservable SLA has no home). An owner is declared per rule, not per subsystem.
_Avoid_: Home module (informal), canonical implementation, single source of truth (vague about which kind)

**Sibling Entry Point**:
A module other than the **Invariant Owner** that applies an owned invariant's rule, and must do so by calling the owner rather than re-implementing it. The Task changing one depends on the Task building the owner.
_Avoid_: Caller (too broad — not every caller applies the rule), consumer, copy

**Matrix Test**:
The test an owned invariant names that runs its rule through the owner and every **Sibling Entry Point**, so a divergent second copy fails it. Any Task change to the family must come with a change to its matrix test. That the test imports a module proves reach, not exercise.
_Avoid_: Parity test (one specific shape), integration test (says nothing about coverage)

**Second Copy**:
An implementation of an owned invariant's predicate outside its **Invariant Owner**. A reviewer reports it citing the plan's invariant: critical when it diverges from the owner on some input (that input is the consequence), advisory when it is behaviourally identical. The reviewer decides which; the Refutation Panel checks it.
_Avoid_: Duplicate (says nothing about the rule), divergent copy (only one of the two severities)

### Verification

**Owner Obligation**:
One owned invariant of the plan as population stamps it into the TaskGraph: its id, title, statement, **Invariant Owner**, **Sibling Entry Points**, **Matrix Test** and mutation policy. Every path plays exactly one role. A Wave owes Owner Verification for an obligation when one of its Tasks, other than a Contract Task, changed the owner or a sibling; a change to the matrix test alone does not count. A TaskGraph with no stamp owes nothing.
_Avoid_: Ownership duty (informal), owned invariant (that is the plan declaration; the obligation is its stamped form)

**Mutation Exemption**:
An owned invariant's declared, reasoned opt-out of mutation verification, written in its plan block. It disables only the mutation half; sibling coverage still runs. One with a blank or placeholder reason, or on an unowned invariant, is refused, so it is never a silent opt-out.
_Avoid_: Waiver (that is a Verification Policy arm), skip

**Owner Map**:
The engine-written, digest-bound section of the Wave review Context Packet for a code-reviewer or architecture-tech-lead reviewing a Task that touches an owned family. It lists each touched invariant's id, title, statement, owner, siblings, matrix test and plan citation, followed by the fixed **Second Copy** rule. Standalone reviews never carry one.
_Avoid_: Owner registry (there is no repository-wide one), ownership section (that is the implementation brief's)

**Family-site Metric**:
The count and location of raw sites of each known invariant family that lie outside the family's owner modules, comparable with a recorded baseline. The patterns are line matches, so it is a gauge of consolidation progress, not a proof.
_Avoid_: Duplication count, lint (it blocks nothing)

## Relationships

- A **Checkable Invariant** is written as a lint rule during the architecture Phase and enforced by Hooks on every edit thereafter
- A lint rule runs in exactly one **Tier**
- Every symbol on a module's **Public Surface** has a consumer outside that module
- A plan invariant has at most one **Invariant Owner**; an owned one has zero or more **Sibling Entry Points** and exactly one **Matrix Test**
- Population stamps exactly one **Owner Obligation** per owned invariant
- An **Owner Obligation** has at most one **Mutation Exemption**
- A Task touching an owned family gets one **Owner Map** in each of its code-reviewer and architecture-tech-lead packets
- A reviewer reports each **Second Copy** against the **Owner Map**
- The **Matrix Test** lands no later than the first Wave that owes Owner Verification for its invariant
- The **Family-site Metric** blocks nothing
