# Loom

An orchestration engine that decomposes complex features into phased, wave-based task graphs executed by specialized AI agents. Enforces ordering, quality gates, and traceability from specification through implementation.

This is the core vocabulary. Each area's own terms are in the context file [CONTEXT-MAP.md](CONTEXT-MAP.md) lists for it; load only the one you are working in.

## Language

### Orchestration

**Phase**:
A sequential stage in the orchestration lifecycle. Each phase produces an artifact consumed by the next.
_Avoid_: Step, stage

**Wave**:
A parallelism unit within the execute phase. Tasks in the same wave run concurrently; waves run sequentially.
_Avoid_: Batch, round, iteration

**Task**:
A discrete unit of implementation work assigned to one agent in one wave. Has a status lifecycle and produces file changes.
_Avoid_: Job, ticket, story

**Agent**:
A specialized AI subagent spawned to perform one phase or task. Defined by a markdown persona with preloaded skills.
_Avoid_: Worker, bot, assistant

**Skill**:
A reusable knowledge module loaded into an agent. Contains domain expertise, process instructions, and reference material.
_Avoid_: Plugin, module, prompt

**Hook**:
An event-driven handler the harness runs before or after a tool call, when an Agent starts or stops, and when a session starts. Enforces invariants, records evidence, and mutates state.
_Avoid_: Trigger, callback, listener

**Dispatch**:
Spawning the Agent for one Task or Phase from an engine-issued instruction. The handler that routes a stopped Agent to its settlement is the "stop dispatcher", never bare "dispatch".
_Avoid_: Router, multiplexer

**Brainstorm**:
Phase 0 output. Captures intent, selected approach, constraints, and scope boundaries. Feeds into the spec.
_Avoid_: Discovery, exploration, ideation

**Spec**:
The formal requirements document produced in Phase 1. Contains user scenarios (US), functional requirements (FR), success criteria (SC), and clarification markers.
_Avoid_: PRD, requirements doc, brief

**Clarification Marker**:
A `[NEEDS CLARIFICATION]` tag in the spec indicating unresolved ambiguity. More than 3 triggers mandatory clarify phase.
_Avoid_: TODO, question, placeholder

**Plan**:
The architecture document produced in Phase 3. Defines component design, file structure, and implementation phases that decompose parses into a task graph.
_Avoid_: Design doc, architecture doc, blueprint

### State and evidence

**TaskGraph**:
The orchestration aggregate: the current Phase, the Tasks and their Waves, each Wave's gate and review authority, and everything frozen at population.
_Avoid_: Task list, DAG (the authored dependency graph is only its input), state (bare)

**State File**:
The TaskGraph's single persisted form (`active_task_graph.json`), the source of truth for orchestration progress. Write-protected: only the engine's state manager writes it, reached from Hooks and from explicitly whitelisted CLI helpers.
_Avoid_: Config, manifest, plan file

**TaskGraph Population**:
The transition that replaces a TaskGraph's Tasks with the roster decompose authored, freezing the **Verification Manifest** and adding each Wave's **Distill Task**.
_Avoid_: Populate hook policy, task merge, graph initializer

**Run Directory**:
The uniquely named directory holding one registered program run (a panel, a Standalone Review Run, a Wave Gate, a remediation, a security audit): its event journal, packets, transcripts and results. Never deleted; a run whose directory is missing is orphaned, not fresh.
_Avoid_: Workspace, scratch dir, output dir

**Implementation Attempt**:
One engine-reserved execution of one Task under one semantic attempt ordinal and one immutable byte baseline. Only engine-issued attempt authority can settle it; a Task id inferred from concurrent execution state is cleanup evidence, not completion authority.
_Avoid_: Agent run, retry (that is a transition between attempts), subagent result

**Settlement**:
The engine's single decision on one piece of submitted work (an Implementation Attempt, a spec-check, a captured review), recording exactly one outcome in one atomic transition. Late or duplicate evidence settles nothing.
_Avoid_: Completion (alone), result handling, post-processing

**Evidence Ledger**:
A session's append-only record of facts the engine minted from observed tool calls: file writes, test runs with their parsed reports, sandbox runs. An Agent's own account of what it did is never a ledger fact.
_Avoid_: Log, transcript, audit trail

**Epoch**:
The attribution key of one Agent run, stamped on every **Evidence Ledger** record; a reader folds only its own. A Wave Gate run's frozen review authority is a different thing: always "Wave review epoch".
_Avoid_: Session, attempt (the engine's reservation, which an Agent run serves), generation

### Review

**Wave Gate**:
A quality checkpoint between waves. Requires test evidence, spec alignment, code review, and — whenever the wave holds critical **Findings** — the adjudication of a **Refutation Panel** before advancing.
_Avoid_: Gate, barrier, checkpoint (alone — always qualify as "wave gate")

**Finding**:
One assertion a review agent made about the code, carrying a severity (critical or advisory), an optional file/line, and a derived id. The unit a **Refutation Panel** votes on. Ids are derived from (agent, ordinal), never agent-chosen — an agent-chosen id collides across runs and reviewers, and a k-of-n vote needs an item two verifiers can agree they are discussing. A finding a reviewer merely emitted is a *draft finding*; it becomes a finding when attribution gives it identity.
_Avoid_: Issue, comment, violation, remark

**Refutation Panel**:
The wave gate's adjudication step. N verifiers, each committed to one **Lens**, each covering ALL of the wave's critical **Findings**, try to REFUTE them. A finding survives unless a strict majority refutes it — ties favour keeping it, because a false positive costs a cycle while a false negative ships a bug.
_Avoid_: Review panel (ambiguous with the reviewers themselves), jury, second opinion

**Refuted Finding**:
A finding a **Refutation Panel** killed, recorded with the lenses and reasoning that killed it. Moved out of the active set, never deleted — a wrong refutation is a shipped bug, and a silently dropped critical is indistinguishable from one that was never found.
_Avoid_: Dismissed finding, false positive, resolved

**Resolved Finding**:
A Finding that held before implementation changed and that every expected review Agent explicitly verified as fixed against one immutable Review Packet. Retained with Review Generation, packet/head identity, and all assessment reasons; never stored as a Refuted Finding.
_Avoid_: Refuted finding, dismissed finding, false positive

**Review Generation**:
A Task's monotonic implementation revision for review purposes. Any implementation byte change increments it and invalidates an in-progress Review Run, preventing late evidence for older bytes from mutating current review state.
_Avoid_: Review round, retry count, packet version

**Review Run**:
A packet-bound collection of evidence from the exact expected reviewer roster for one Task and Review Generation. It snapshots all active Finding IDs; every reviewer must assess each prior ID exactly once before atomic finalization can resolve old Findings or activate new ones.
_Avoid_: Review Generation, Refutation Panel, reviewer batch (without the binding)

**Review Packet**:
A canonical immutable snapshot binding one Task to its base and head revisions, exact path scope, diffs, postimages, plan context and Proof Obligations. The sole review scope; an empty scope fails rather than broadening to the Wave. Its hashes prove integrity; its registration in protected Task state at publication proves the engine issued it.
_Avoid_: File list, live diff, review context, fallback scope, self-authenticating recovery packet; for its registration: packet hash, packet signature, inferred provenance

**Context Packet**:
A content-addressed immutable collection of fixed and variable byte sections published before an Agent request. Children read it instead of relying on a parent model to reconstruct scope and protocol prose.
_Avoid_: Prompt blob, context string, temporary instructions

**Wire Contract**:
The exact machine-readable output a review Agent must emit, fixed by the protocol version its request was issued under. Generated and stamped into each reviewer's definition, never hand-edited.
_Avoid_: Output format, response template, Machine Summary (one section of the first protocol version, not the contract)

**Lens**:
A single committed perspective an agent argues from, assigned rather than chosen, so a panel's diversity is structural instead of hoped for. Deliberately two disjoint vocabularies — see Flagged Ambiguities.
_Avoid_: Angle, viewpoint, role, persona

**Standalone Review Run**:
An immutable review-and-adjudication record outside the wave lifecycle. It binds an exact file scope to the complete expected reviewer transcript set, identified Findings, optional Refutation Panel outcomes, and one finalized remediation input. It never reads or writes the State File.
_Avoid_: Synthetic Task, fake Wave, ad-hoc review output

**Plan Design Review**:
The review of a **Plan**'s design before Tasks are cut from it: a **Standalone Review Run** scoped to exactly the Plan. A gate on decompose, not a Phase: the decompose spawn asks it, and first TaskGraph population asks it again. Acceptance is bound to the reviewed bytes, so any later edit closes the gate until a fresh review is accepted.
_Avoid_: Plan review (plan alignment is also one), design phase, plan-design phase, architecture review (that is the `architecture` Standalone Review kind), plan approval

### Proof

**Proof Obligation**:
An engine-authored requirement a Task must discharge before its status can become implemented: completion, required regression tests, required new tests, test-first evidence where owed, and declared artifacts changed. A **Distill Task** owes completion and preserved behaviour instead.
_Avoid_: Checklist item, self-report, completion claim

**Verification Manifest**:
The operator-owned `.loom/verification-manifest.json`: the fixed Wave completion commands and optional settings (acceptance runner, affected runner, test-file suffixes, distill-pass and Task-mutation-check switches). Population freezes it, so no Agent can supply command authority; an absent file freezes the engine default of reserved checks only.
_Avoid_: Test script, model command, shell command, CI config; for its settings: related-tests command, affected script, distill flag, skip-distill, simplifier toggle, mutation flag, skip-mutation

**Distill Task**:
The one engine-added **Task** a **Wave** may carry: a fresh Agent applies the `distill` Skill to the files the Wave's other Tasks implemented, after they settle and before the **Wave Gate**. It has no Requirement trace, is exempt from Wave review, and may legitimately change nothing.
_Avoid_: Distill phase, simplification Task, cleanup Task, refactor Task, distill step (it is a Task with its own attempt, not a step of another Task)

**Owner Verification**:
The Wave Gate check that an owned plan invariant has one implementation: its matrix test reaches the owner module and every sibling entry point, and every mutant of the owner's changed lines is killed.
_Avoid_: Mutation testing (alone — it is one half), owner check (informal)

### Requirements and contracts

**Requirement**:
One identified **Spec** entry that work is traced to: a Functional Requirement (`FR-NNN`) or an Acceptance Scenario (`AS-NNN`). An Out-of-Scope entry (`OOS-NNN`) names what is excluded.
_Avoid_: Anchor (the stored field name), story, ticket

**Claimant**:
A Task that claims to complete a **Requirement**; where an **Acceptance Contract** covers it, the Task that must turn the frozen testcases green.
_Avoid_: Owner (that is the module holding an invariant), implementer, assignee

**Spec Index**:
A deterministic projection of one **Spec** into its Requirement, Out-of-Scope and glossary entries, each with a content hash. Derived input, never a second source of truth; population records which Spec bytes it observed as provenance only.
_Avoid_: TaskGraph, specification database, LLM requirement summary; for the recorded observation: cached Spec Index, current Spec verdict, settlement authority

**Acceptance Contract**:
A plan's `CT-N` declaration made executable: a declarations-only types file (or none, with a reason) and dedicated acceptance test files, written before any implementation and frozen once observed failing. Each testcase is named after the Requirement it decides; that name prefix is the only attribution.
_Avoid_: Contract (alone — collides with **Wire Contract** and the orchestration contract), spec test, golden test

**Skeleton**:
An engine-written file at a not-yet-existing path a plan binds to an **Acceptance Contract**, declaring each bound export with its frozen type and a body that throws unimplemented. Completion refuses a bound export that is deleted, renamed, retyped or still unimplemented. A "contract stub" is the Skeleton written when the contract's own Task stops.
_Avoid_: Stub (alone), scaffold, template, hand-written stub

## Relationships

- A **Phase** produces one or more artifacts consumed by subsequent **Phases**
- A **Spec** contains **Requirements** and **Clarification Markers**
- A **Plan** is decomposed into **Tasks** grouped into **Waves**
- An **Agent** executes exactly one **Task** or one **Phase**; a **Skill** is loaded into an **Agent**
- A **TaskGraph** has exactly one **State File** and one frozen **Verification Manifest**
- A registered program run has exactly one **Run Directory**
- A **Wave** holds one or more authored **Tasks** and at most one **Distill Task**
- A **Wave Gate** validates all **Tasks** in a **Wave** before the next **Wave** begins
- A **Task** has one or more **Implementation Attempts**; each ends in exactly one **Settlement**
- An Agent run has one **Epoch**; its **Evidence Ledger** records belong to no other
- A **Task** becomes implemented only when all its **Proof Obligations** are discharged
- A **Review Run** binds one **Review Packet** to one **Review Generation** and the expected review Agents
- A review **Agent** emits zero or more **Findings** under one **Wire Contract**
- A **Refutation Panel** has N verifiers with one **Lens** each; each covers every critical **Finding**
- A **Finding** is active, a **Refuted Finding** or a **Resolved Finding**; it is never deleted
- A **Standalone Review Run** uses the same **Refutation Panel** without a **Task** or the **State File**
- A **Plan** has at most one accepted **Plan Design Review**
- A **Spec** projects to exactly one **Spec Index**
- A **Requirement** is completed in exactly one **Wave**; each **Task** claiming it is a **Claimant**
- An **Acceptance Contract** covers one or more **Requirements** and yields one **Skeleton** per bound file

## Example Dialogue

> **Dev:** "The Wave Gate is blocked on a critical **Finding**: the reviewer says my handler fails AS-004. I think the reviewer is wrong, so I'll dismiss it."
> **Domain expert:** "Nobody dismisses a **Finding**. The **Refutation Panel** tries to refute it. If a strict majority of its verifiers does, it becomes a **Refuted Finding** and stays on record. If it survives, you fix the code."

> **Dev:** "It survived. The quickest fix is to relax the AS-004 acceptance test."
> **Domain expert:** "That test belongs to the **Acceptance Contract** and is frozen; your **Task** may not write it. Fix the handler. That raises the Task's **Review Generation**, and the Finding becomes a **Resolved Finding** only when every reviewer in the new **Review Run** verifies the fix."

## Flagged Ambiguities

- "gate" was used alone to mean both the wave gate concept and the approach gate in the architecture interview — resolved: "wave gate" for quality checkpoints, "approach gate" for the architecture phase's option-selection step.
- "template" was used for both prompt templates (commands/templates/) and project scaffolding — resolved: always "prompt template" for the former; loom does not do project scaffolding.
- "plan" was used to mean both the architecture plan document and the overall orchestration plan — resolved: "plan" always means the Phase 3 architecture document; the overall orchestration is "the loom flow" or "orchestration."
- "lens" names two disjoint closed vocabularies with nothing in common but the idea of a committed single perspective: the five DESIGN lenses of `/loom --panel` (`simplicity-first`, `type-driven-fp`, `risk-security-first`, `performance-first`, `codebase-conventionist` — `PANEL_LENSES`, `references/panel-lenses.md`) and the five REFUTATION lenses of the wave gate's panel (`reproduction`, `intent`, `blast-radius`, `security`, `test-coverage` — `REVIEW_LENSES`, `references/review-lenses.md`). Resolved: say "design lens" or "refutation lens" wherever both panels are in scope; bare "lens" is fine inside one panel's own documentation, where only one vocabulary exists. They are deliberately NOT unified — a designer's lens shapes what it builds, a verifier's shapes what it tries to disprove.
- "panel" alone is ambiguous between the two — resolved: "architecture panel" (`/loom --panel`) and "refutation panel" (wave gate Step 3.5). The shared machinery they both instantiate is "the panel kernel."
- "machine" names two unrelated things: the **Lifecycle Machine** (a plan's `LC-N` domain lifecycle, in `engine/src/core/`) and the **Guarded Skill Machine** (a per-agent-type phase gate, defined in `machines/` and implemented in `engine/src/machine/`). The directory names are the trap — `core/*-machine.ts` is the first, `machine/` is the second. Resolved: always say "Lifecycle Machine" or "Guarded Skill Machine" when both could be meant; bare "machine" is fine inside one of the two subsystems' own documentation. They share no types and no code.
- "contract" names three things: the plan's **Acceptance Contract** (`CT-N`, `core/acceptance-contract/`), the **Wire Contract** a review Agent emits, and the orchestration shared kernel (`core/orchestration-contract/`). Resolved: say "Acceptance Contract" (or "plan contract") for `CT-N`; never bare "contract" where another could be meant.
