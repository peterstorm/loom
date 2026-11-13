# Requirements trace

How Tasks are traced to a Spec's Requirements and how that trace is checked at the Wave Gate. Core terms (Requirement, Claimant, Spec Index, Spec, TaskGraph Population, …) are in the root [CONTEXT.md](../../../CONTEXT.md).

## Language

**Requirement Contribution**:
A Task's partial traceability claim that it advances a Spec requirement without satisfying it. Stored in `spec_contributions`; it never enters Wave Gate spec-check completion scope and must lead to exactly one same-or-later Requirement Completion Wave.
_Avoid_: Partial anchor, weak anchor, completion claim

**Requirement Completion Claim**:
A Task's declaration that its Wave fully satisfies a Spec requirement. Stored in `spec_anchors`; repeated claims are permitted only among Tasks in the same completion Wave.
_Avoid_: Contribution, coverage hint, partial anchor

**Requirement Content Hash**:
The Spec Index content hash of the text a **Requirement Completion Claim** was last verified against. Engine-derived, never authored: decompose says which Requirements a Task completes, and the Spec's own bytes say what they said. An identifier the specification does not define records nothing. Three absences are three different facts: a Task with no recorded hash yields *unverifiable*, never *stable*; a stored value the engine could not have minted is corrupt authority, not missing authority; and a recorded hash that disagrees with the current text is drift.
_Avoid_: Anchor checksum, spec fingerprint, decompose-supplied hash

**Requirement Coverage Projection**:
The engine's deterministic join of the Spec Index against the whole Task roster, classifying every **Requirement Completion Claim** before any Agent reads a file. Four outcomes are decided by structure alone and are not a model's to overturn: the claim names no Spec Index entry, it claims an excluded item, its Task declared no artifacts, or its Task modified no files. The rest are candidates an Agent assesses for behaviour. It also names every Requirement whose completion no Task owns. When no Spec Index can be projected it is an honest absence with a stated reason, never a pass.
_Avoid_: Coverage report, spec-check result, requirement checklist, LLM verdict
_Mechanics_: Severity and settlement are separate facts: who decides a row follows from its verdict kind, while severity says how bad the structural fact is, so a drifted candidate carries a severity and still owes an assessment. **Requirement Contributions** are not counted as completion. A Wave that claims no completion but carries valid Contributions is a legitimate foundation Wave, not work that traces nowhere.

**Spec-check Settlement**:
The pure TaskGraph transition that takes validated Wave or manual authority plus a parsed spec-check transcript, or a capture failure, and produces exactly one settlement: applied evidence that changes the spec-check result and the Wave's block together, or a refusal that leaves the TaskGraph as it was. Captured evidence is passed or blocked, nothing else. Every transport delegates to it; none commits spec-check state on its own.
_Avoid_: Spec-check store, transport-specific settlement, evidence write

**Requirement Trace Amendment**:
The pure transition that changes a populated TaskGraph's Completion Claims and Contributions in place. It keeps every settled implementation, review and refutation fact, retires only the current Wave's review authority that froze the old trace, and appends an immutable audit. It refuses completed Waves, a live Wave Gate, active implementation, and ids the current Spec Index does not define.
_Avoid_: Re-population, trace upgrade (the one-shot legacy migration), anchor edit

**Spec Parse Error**:
One structured reason a specification failed to project into a Spec Index: the failure's kind plus where it occurred. It is the failure itself, not a rendering of it: callers discriminate on the kind, and one renderer owns the operator-facing text.
_Avoid_: Error message, diagnostic string, validation warning

## Mechanics of the Spec Index

**Spec Index** is defined in the root file. Its grammar boundary is stated here because a parser test binds this sentence to the parser's behaviour:

The colon and the contiguous family token are the deliberate prose-disambiguation boundaries: an ID-shaped line without a colon ("FR-002 and FR-003 are related") or with a spaced family token ("F R-002:") is prose, not a malformed identifier, and stays legal; every Markdown marker-run form (`> >`, `- -`, `* *`, `1. 2.`) before a colon-full ID fails closed.

## Relationships

- A Task has zero or more **Requirement Completion Claims** and zero or more **Requirement Contributions**
- A Requirement is completed in exactly one Wave; repeated **Requirement Completion Claims** exist only among Tasks of that Wave
- Every **Requirement Contribution** has exactly one same-or-later completion Wave, and none occurs after completion
- A **Requirement Contribution** never enters Wave Gate completion scope; a **Requirement Completion Claim** does
- A **Requirement Completion Claim** has at most one **Requirement Content Hash**
- A Wave Gate has exactly one **Requirement Coverage Projection** and exactly one **Spec-check Settlement** per captured spec-check
- A **Requirement Trace Amendment** leaves exactly one audit entry
- A failed Spec projection yields one or more **Spec Parse Errors** and no Spec Index
