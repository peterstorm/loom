# Loom

An orchestration engine that decomposes complex features into phased, wave-based task graphs executed by specialized AI agents. Enforces ordering, quality gates, and traceability from specification through implementation.

## Language

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
An event-driven handler that fires on tool use (PreToolUse) or agent completion (SubagentStop). Enforces invariants and mutates state.
_Avoid_: Trigger, callback, listener

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

**Lens**:
A single committed perspective an agent argues from, assigned rather than chosen, so a panel's diversity is structural instead of hoped for. Deliberately two disjoint vocabularies — see Flagged Ambiguities.
_Avoid_: Angle, viewpoint, role, persona

**Candidate**:
One architectural design produced by one designer through one **Lens** during `/loom --panel`. Judged against derived criteria; the winner becomes the **Plan**.
_Avoid_: Option, proposal, variant

**Verdict**:
One agent's complete judgment on one criterion or lens, covering every item exactly once. The unit both panels validate at the boundary; a verdict that skips or invents an item is rejected outright rather than counted as a weaker vote.
_Avoid_: Score, vote (alone), opinion

**Run Directory**:
A uniquely-named directory under a panel's runs-root holding one panel run's artifacts: its context document, its item set, its manifest, and one verdict file per criterion. Bound to the working directory and rejected if any path component is a symlink.
_Avoid_: Workspace, scratch dir, output dir

**Standalone Review Run**:
An immutable review-and-adjudication record outside the wave lifecycle. It binds an exact file scope to the complete expected reviewer transcript set, identified Findings, optional Refutation Panel outcomes, and one finalized remediation input. It never reads or writes the State File.
_Avoid_: Synthetic Task, fake Wave, ad-hoc review output

**State File**:
The single source of truth for orchestration progress (`active_task_graph.json`). Write-protected; only hooks mutate it.
_Avoid_: Config, manifest, plan file

**Plan**:
The architecture document produced in Phase 3. Defines component design, file structure, and implementation phases that decompose parses into a task graph.
_Avoid_: Design doc, architecture doc, blueprint

**Spec**:
The formal requirements document produced in Phase 1. Contains user scenarios (US), functional requirements (FR), success criteria (SC), and clarification markers.
_Avoid_: PRD, requirements doc, brief

**Brainstorm**:
Phase 0 output. Captures intent, selected approach, constraints, and scope boundaries. Feeds into the spec.
_Avoid_: Discovery, exploration, ideation

**Clarification Marker**:
A `[NEEDS CLARIFICATION]` tag in the spec indicating unresolved ambiguity. More than 3 triggers mandatory clarify phase.
_Avoid_: TODO, question, placeholder

**Dispatch**:
The SubagentStop routing mechanism that inspects completed agent type and delegates to the appropriate hook handler.
_Avoid_: Router, multiplexer

**Functional Core**:
Pure business logic with no I/O. Takes data in, returns data out. Unit testable without mocks.
_Avoid_: Domain layer (too vague), business logic layer

**Imperative Shell**:
Thin orchestration layer that handles I/O (DB, network, filesystem) and calls the functional core.
_Avoid_: Service layer, infrastructure layer, use case layer

**Shell Orchestrator**:
A class or function in the imperative shell that coordinates a single operation: load via port → call pure core → persist via port. Contains no business logic.
_Avoid_: Service, UseCase, Handler (for this concept), Manager

**Port**:
A narrow interface owned by the domain for each real I/O collaborator. Adapters implement it; tests substitute with fakes.
_Avoid_: Interface (too generic), abstraction, wrapper

**Bounded Context**:
A DDD boundary enclosing a consistent domain model with its own ubiquitous language. Each context has its own `CONTEXT.md`.
_Avoid_: Module, service, package (unless referring to code packaging)

**Ubiquitous Language**:
The shared vocabulary between developers and domain experts within a bounded context. Enforced in code, docs, and conversation.
_Avoid_: Glossary (it's more than a glossary — it's the living language of the system)

**Tier**:
An execution scope that determines which lint rules apply. "Immediate" (PostEdit, regex-only, <50ms budget) or "full" (wave-gate boundary, all rules including programmatic structural analysis).
_Avoid_: Level, mode, severity

**Aggregate**:
An immutable data cluster (root entity + value objects) treated as a single consistency unit. Command functions in the functional core take an aggregate and return a new aggregate plus domain events.
_Avoid_: Entity group, object graph, mutable domain object

**Value Object**:
An immutable domain concept defined entirely by its attributes, with no identity. Validates invariants at construction.
_Avoid_: DTO (DTOs carry no invariants), data class (too implementation-specific)

**Either**:
A sum type representing success (`Right`) or failure (`Left`). Used for error handling in the functional core — never throw.
_Avoid_: Result (acceptable in Rust), Optional (different semantics)

**LLM Profile**:
A semantic policy assigning one Agent role to complete harness-specific model bindings: a Claude Code model and an exact Pi provider/model/thinking tuple. Missing bindings fail closed; an Agent never inherits the orchestrator's current model.
_Avoid_: Model alias, Sonnet equivalent, current model, model fallback

**Proof Obligation**:
An engine-authored requirement a Task must discharge before its status can become implemented: completion, required regression tests, required new tests, and declared artifacts changed. Evidence keeps its provenance; Pi structured evidence is never relabeled as ledger-trusted.
_Avoid_: Checklist item, self-report, completion claim

**Review Packet**:
A canonical immutable snapshot binding one Task to its base/head revisions, exact declared/modified path scope, diffs, byte-preserving postimages, plan context, and Proof Obligations. Postimages use `utf8` when lossless and `base64` otherwise; their digest identifies the original bytes. The sole review scope; empty scope fails rather than broadening to the wave. Its self-hashes prove integrity, not provenance; historical write recovery additionally requires the exact engine-issued packet registration stored in protected Task state at packet creation.
_Avoid_: File list, live diff, review context, fallback scope, self-authenticating recovery packet

**Issued Review Packet Registration**:
Protected Task-state authority written atomically with Review Packet publication. Binds Task id, canonical packet path, packet id, base/head revisions, and exact scope so later historical recovery can distinguish an engine-issued packet from operator-authored content with recomputed hashes.
_Avoid_: Packet hash, packet signature, inferred provenance

**Panel Program**:
The executable event-sourced dispatch policy for an architecture panel or Refutation Panel. Emits exact spawn batches, LLM Profiles, retry actions, engine operations, and terminal outcomes; Markdown explains execution but does not own ordering.
_Avoid_: Runbook sequence, workflow DSL, panel prompt

**Executable Model**:
A model the system imports, runs, or enforces — a lifecycle machine, an AuthoredDag, or a lint rule. The only kind of model loom permits: a model either executes or it doesn't exist (`references/executable-models.md`).
_Avoid_: Behavioral model, descriptive model, structural diff (these name the forbidden alternative)

**Lifecycle Machine**:
A statechart or typed reducer bound to a plan's `LC-N` declaration. The single source of truth for a domain lifecycle; implementation code imports it and never re-implements its transitions.
_Avoid_: State diagram, workflow doc, lifecycle description

**Checkable Invariant**:
A plan invariant (`INV-N`, tier `checkable`) expressed as a lint rule enforced fail-closed on every edit. Invariants that cannot be deterministically checked are tiered `advisory` and stay honest prose.
_Avoid_: Constraint (too generic), rule (alone), enforced guideline (advisory rules are never enforced)

## Relationships

- A **Phase** produces one or more artifacts consumed by subsequent **Phases**
- A **Plan** is decomposed into **Tasks** grouped into **Waves**
- A **Wave Gate** validates all **Tasks** in a **Wave** before the next **Wave** begins
- A **Tier** determines which lint rules execute: "immediate" runs regex-only at PostEdit, "full" runs all rules at wave-gate boundaries
- An **Agent** executes exactly one **Task** or one **Phase**
- Every Loom-owned **Agent** resolves one explicit **LLM Profile** before spawn
- A **Task** becomes implemented only after all of its **Proof Obligations** are satisfied
- Review Agents consume one immutable **Review Packet** per Task
- A **Review Run** binds that Review Packet to one **Review Generation**, the expected review Agents, and all prior active Finding IDs
- A **Resolved Finding** leaves the active set only when every Agent in its Review Run explicitly verifies remediation; any `still_present` assessment keeps it active
- A **Panel Program** emits the exact Agent batches and engine operations for each panel
- A **Standalone Review Run** feeds identified critical Findings through the same **Refutation Panel** without creating a Task or mutating the State File
- A **Skill** is loaded into an **Agent** to provide domain expertise
- **Hooks** enforce invariants on the **State File** — no other actor writes to it
- A **Spec** contains **Clarification Markers** resolved by the clarify **Phase**
- An **Aggregate** is immutable data; command functions in the **Functional Core** produce new instances
- The **Imperative Shell** orchestrates: load via **Port** → call **Functional Core** → persist via **Port**
- **Domain Events** are returned by pure command functions; the **Imperative Shell** publishes them
- A **Plan** may declare **Executable Models**; decompose validation blocks a declared model that no **Task** binds to an artifact
- A **Lifecycle Machine** is implemented by a dedicated **Task** in the earliest wave; dependent **Tasks** import it
- A **Checkable Invariant** is written as a lint rule during the architecture **Phase** and enforced by **Hooks** on every edit thereafter

## Example Dialogue

> **Dev:** "I want to add a new task to wave 2."
> **Domain expert:** "You don't add tasks to waves — you add tasks to the plan, and decompose assigns them to waves based on dependencies. If you need to re-wave, re-run decompose."

> **Dev:** "The hook failed, so I'll just write to the state file directly."
> **Domain expert:** "You can't. The state file is chmod 444. Only hooks write to it via StateManager. Fix why the hook failed."

> **Dev:** "Should I put the validation in the service?"
> **Domain expert:** "No — validation is a pure function. It belongs in the functional core. The imperative shell just calls it and handles the Either result."

## Flagged Ambiguities

- "gate" was used alone to mean both the wave gate concept and the approach gate in the architecture interview — resolved: "wave gate" for quality checkpoints, "approach gate" for the architecture phase's option-selection step.
- "template" was used for both prompt templates (commands/templates/) and project scaffolding — resolved: always "prompt template" for the former; loom does not do project scaffolding.
- "plan" was used to mean both the architecture plan document and the overall orchestration plan — resolved: "plan" always means the Phase 3 architecture document; the overall orchestration is "the loom flow" or "orchestration."
- "lens" names two disjoint closed vocabularies with nothing in common but the idea of a committed single perspective: the five DESIGN lenses of `/loom --panel` (`simplicity-first`, `type-driven-fp`, `risk-security-first`, `performance-first`, `codebase-conventionist` — `PANEL_LENSES`, `references/panel-lenses.md`) and the five REFUTATION lenses of the wave gate's panel (`reproduction`, `intent`, `blast-radius`, `security`, `test-coverage` — `REVIEW_LENSES`, `references/review-lenses.md`). Resolved: say "design lens" or "refutation lens" wherever both panels are in scope; bare "lens" is fine inside one panel's own documentation, where only one vocabulary exists. They are deliberately NOT unified — a designer's lens shapes what it builds, a verifier's shapes what it tries to disprove.
- "panel" alone is ambiguous between the two — resolved: "architecture panel" (`/loom --panel`) and "refutation panel" (wave gate Step 3.5). The shared machinery they both instantiate is "the panel kernel."
