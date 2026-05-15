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
A quality checkpoint between waves. Requires test evidence, spec alignment, and code review before advancing.
_Avoid_: Gate, barrier, checkpoint (alone — always qualify as "wave gate")

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
_Avoid_: Service layer, infrastructure layer

**Port**:
A narrow interface owned by the domain for each real I/O collaborator. Adapters implement it; tests substitute with fakes.
_Avoid_: Interface (too generic), abstraction, wrapper

**Bounded Context**:
A DDD boundary enclosing a consistent domain model with its own ubiquitous language. Each context has its own `CONTEXT.md`.
_Avoid_: Module, service, package (unless referring to code packaging)

**Ubiquitous Language**:
The shared vocabulary between developers and domain experts within a bounded context. Enforced in code, docs, and conversation.
_Avoid_: Glossary (it's more than a glossary — it's the living language of the system)

**Aggregate**:
A cluster of domain objects treated as a single unit for data changes. Has a root entity that enforces invariants.
_Avoid_: Entity group, object graph

**Value Object**:
An immutable domain concept defined entirely by its attributes, with no identity. Validates invariants at construction.
_Avoid_: DTO (DTOs carry no invariants), data class (too implementation-specific)

**Either**:
A sum type representing success (`Right`) or failure (`Left`). Used for error handling in the functional core — never throw.
_Avoid_: Result (acceptable in Rust), Optional (different semantics)

## Relationships

- A **Phase** produces one or more artifacts consumed by subsequent **Phases**
- A **Plan** is decomposed into **Tasks** grouped into **Waves**
- A **Wave Gate** validates all **Tasks** in a **Wave** before the next **Wave** begins
- An **Agent** executes exactly one **Task** or one **Phase**
- A **Skill** is loaded into an **Agent** to provide domain expertise
- **Hooks** enforce invariants on the **State File** — no other actor writes to it
- A **Spec** contains **Clarification Markers** resolved by the clarify **Phase**
- The **Functional Core** is separated from the **Imperative Shell** by **Ports**
- A **Bounded Context** owns its own **Ubiquitous Language** captured in `CONTEXT.md`
- An **Aggregate** contains **Value Objects** and enforces invariants via its root
- The **Functional Core** returns **Either** types; the **Imperative Shell** converts them to effects

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
