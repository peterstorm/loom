# Acceptance contracts

The executable models a plan declares, and the life of an Acceptance Contract: who writes it, what it binds, when it freezes and how it changes. Core terms (Acceptance Contract, Skeleton, Claimant, Requirement, …) are in the root [CONTEXT.md](../../../CONTEXT.md).

## Language

### Executable models

**Executable Model**:
A model the system imports, runs, or enforces: a lifecycle machine, an authored dependency graph, a lint rule, or a frozen **Acceptance Contract**. The only kind of model Loom permits: a model either executes or it does not exist.
_Avoid_: Behavioral model, descriptive model, structural diff (these name the forbidden alternative)

**Lifecycle Machine**:
A statechart or typed reducer bound to a plan's `LC-N` declaration: the single source of truth for a domain lifecycle, which implementation code imports and never re-implements. A machine only a test drives is not a source of truth. It reaches production either by checkpoint (its serialized state is the resume position) or by projection (a pure function reduces it over durable evidence the shell already reads).
_Avoid_: State diagram, workflow doc, lifecycle description, model that only tests drive

### Writing a contract

**Contract Task**:
The one Task whose file list holds every frozen path of an **Acceptance Contract**. It writes the types and the acceptance tests, contributes to the covered Requirements but never claims them, and its Wave Gate must observe every acceptance testcase collected and failing. It never writes a stub of a bound file: the engine writes the contract stubs when it stops.
_Avoid_: Test task, scaffolding task

**Contract Surface**:
An **Acceptance Contract**'s types file as the declarations its dependents implement against, together with the **Export Bindings** tied to its aliases; a contract with no types file has none. The Wave review of its **Contract Task** is the last review before any dependent builds on it, so that review adds architecture-tech-lead and issues the type and architecture reviewers one engine-written section describing the surface and what to judge in it.
_Avoid_: Frozen surface (that is the parsed types file a **Skeleton** is generated from), contract framing, types review

**Export Binding**:
One line of a plan's `**Export bindings:**` list that ties each named export of one new implementation file to a function-type alias declared by one contract's frozen types file. One contract per file. Only consumer-facing signatures are bound; helpers and module structure stay the implementer's choice. An alias that is missing, not a function type or generic blocks the spawn of the Task holding the file.
_Avoid_: Interface block (the plan's `**Interface:**` prose is never read for signatures), export list, stub list

**Frozen ADT**:
An algebraic data type declared in a frozen types file: a TypeScript discriminated union or branded type, or a Java sealed interface, record or permitted variant. Implementation files use it and never redeclare it; completion refuses a production file that shadows it or re-lists its variants. Frozen ADTs are enforced, never skeleton targets.
_Avoid_: Shared type (says nothing about the freeze), domain enum

**Contract Entry Point**:
The production file an **Acceptance Contract**'s tests reach the code through (a route, a handler, a CLI command), declared by the plan and never a frozen path. A claimant of a covered Requirement must write it or depend on a Task that does, because its tests could not pass before it exists. The **Contract Task** never counts as its writer.
_Avoid_: Entry point (alone — collides with **Sibling Entry Point**)

### Freeze and change

**Acceptance Freeze**:
What the contract Wave's accepted gate stamps on an **Acceptance Contract**: the digest of every frozen path and the roster of testcases it observed failing. A contract is awaiting red, then frozen, then revised after a **Contract Revision** until a gate re-records the roster. Every later gate re-hashes the frozen paths and blocks on drift. The stamp lands with the Wave's completion, after the advisory decision, so an abandoned run freezes nothing.
_Avoid_: Snapshot, lock, baseline

**Red Window**:
The Waves from a contract Wave through the last Wave completing one of its covered Requirements. A testcase is pending until the Wave completing all its Requirements and due after. A pending failure is excused only at the Wave Gate, so Tasks in the window carry the engine-only regression waiver `acceptance-red-window` and the gate's suite is their regression authority.
_Avoid_: Grace period, expected-failure list

**Acceptance Stop Check**:
At a claimant's stop, the engine runs the frozen acceptance files that decide its claims; if a testcase due by its Wave is not passing, it blocks the stop, a bounded number of times, so the same Agent keeps working. It fails open on anything it cannot observe, is report-only on Pi, and is never completion evidence: the Wave Gate's completion suite stays the authority.
_Avoid_: Stop gate, pre-gate (it gates nothing the Wave Gate owns)

**Contract Revision**:
The operator-only way to change an **Acceptance Contract**'s frozen bytes: it re-stamps them, clears the roster for the next gate to re-record, appends an audited revision, and returns the current Wave's implemented claimants to revalidation. Refused while a Wave Gate is live, before the freeze, and while any claimant sits in a completed Wave.
_Avoid_: Unfreeze, test fix, override

**Contract Status**:
The read-only view of every **Acceptance Contract** in a TaskGraph: its **Contract Task**, its **Acceptance Freeze** state, and the Wave by which each covered Requirement is due.
_Avoid_: Contract report, freeze dump, contract list

## Relationships

- A **Plan** may declare **Executable Models**; a declared model that no Task binds to an artifact blocks decompose
- Every **Lifecycle Machine** reaches production by checkpoint or by projection
- An **Acceptance Contract** has exactly one **Contract Task**; every claimant depends on it and may not write a frozen path
- An **Acceptance Contract** has at most one **Contract Surface** and zero or more **Export Bindings**; an implementation file is bound to at most one contract
- An **Acceptance Contract** declares zero or more **Frozen ADTs** and at most one **Contract Entry Point**
- An **Acceptance Contract** has exactly one **Acceptance Freeze** state and exactly one **Red Window**
- Only an accepted Wave Gate stamps an **Acceptance Freeze**; only a **Contract Revision** changes one
- A claimant in a completed Wave blocks a **Contract Revision** until that Wave is reopened
