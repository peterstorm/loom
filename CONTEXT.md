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

**Requirement Contribution**:
A Task's partial traceability claim that it advances a Spec requirement without satisfying it. Stored in `spec_contributions`; it never enters Wave Gate spec-check completion scope and must lead to exactly one same-or-later Requirement Completion Wave.
_Avoid_: Partial anchor, weak anchor, completion claim

**Requirement Completion Claim**:
A Task's declaration that its Wave fully satisfies a Spec requirement. Stored in `spec_anchors`; repeated claims are permitted only among Tasks in the same completion Wave.
_Avoid_: Contribution, coverage hint, partial anchor

**Agent**:
A specialized AI subagent spawned to perform one phase or task. Defined by a markdown persona with preloaded skills.
_Avoid_: Worker, bot, assistant

**Agent Catalog**:
The single declarative registry defining every Agent's identity: its kind (phase, architecture-panel, implementation, reviewer, spec-check, review-verifier, utility), model profile, required Skill, and Pi transport contract (headless or interactive RPC) — one record per Agent, keyed by name so a duplicate or double-kinded Agent is unrepresentable. Every agent set, phase map, transport projection, and policy table is derived from the catalog, never a second source.
_Avoid_: Agent list, agent config, roster (a roster is an ordered per-run selection drawn from the catalog, not identity)

**Skill**:
A reusable knowledge module loaded into an agent. Contains domain expertise, process instructions, and reference material.
_Avoid_: Plugin, module, prompt

**Hook**:
An event-driven handler that fires on tool use (PreToolUse) or agent completion (SubagentStop). Enforces invariants and mutates state.
_Avoid_: Trigger, callback, listener

**Spawn Admission**:
The pure decision that accepts or blocks one subagent spawn batch before any state mutation, taking pre-gathered inputs (batch items, Agent Catalog entries, agent definitions, graph state) and returning either an allow or a block naming the exact guard that decided. The Hook is the shell that gathers inputs and applies the decision; the decision itself never performs I/O.
_Avoid_: Spawn gate (that is the Hook applying the decision), spawn validation

**Interactive Phase Transport**:
The Pi-only parent-relayed RPC child transport for one interactive phase Agent. It preserves the same child process and Agent turn while translating child `extension_ui_request` frames into parent-TUI dialogs and returning exactly correlated `extension_ui_response` frames. It resolves the same exact effective provider/model/thinking binding as the normal subagent transport and records that binding in its result. Headless Agents remain on the normal subagent transport.
_Avoid_: Question-file fallback, parent interview, interactive subagent (that is the tool surface, not the transport contract)

**Wire Contract**:
The exact machine-readable output shape a review Agent must emit — Machine Summary counts and marker lines, the fenced findings block, and the review_lifecycle assessment schema. Owned by the parser that consumes it; the copy in each reviewer Agent file is stamped from one shared fragment, never hand-edited, and the contract tests execute that fragment against the real parser.
_Avoid_: Output format, response template, Machine Summary (that is one section of the contract, not the whole)

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
One architectural design produced by one designer through one **Lens** during `/loom --panel`. Judges rank Candidates against derived criteria; the user selects a Candidate as the base for the **Plan**, and may reject the ranking recommendation.
_Avoid_: Option, proposal, variant

**Verdict**:
One agent's complete judgment on one criterion or lens, covering every item exactly once. The unit both panels validate at the boundary; a verdict that skips or invents an item is rejected outright rather than counted as a weaker vote.
_Avoid_: Score, vote (alone), opinion

**Run Directory**:
A uniquely-named directory under a panel's runs-root holding one panel run's artifacts: its context document, its item set, its manifest, and one verdict file per criterion. Bound to the working directory and rejected if any path component is a symlink. Named by its run id — bare or as a full path to that same direct child — and created by the engine on the operations that start a run; every other operation requires it to already exist, because an absent Run Directory is an orphaned run, not a fresh one.
_Avoid_: Workspace, scratch dir, output dir

**Standalone Review Run**:
An immutable review-and-adjudication record outside the wave lifecycle. It binds an exact file scope to the complete expected reviewer transcript set, identified Findings, optional Refutation Panel outcomes, and one finalized remediation input. It never reads or writes the State File.
_Avoid_: Synthetic Task, fake Wave, ad-hoc review output

**State File**:
The single source of truth for orchestration progress (`active_task_graph.json`). Write-protected; only hooks mutate it.
_Avoid_: Config, manifest, plan file

**Session TaskGraph Pointer Lease Registry**:
The exact parsed immutable generation record beside one session's `.task_graph` pointer. Every same-target binder owns one lease; only the final lease may restore the generation's previous target, and a different target or contradictory/malformed crash state fails closed under the same no-follow lock.
_Avoid_: Pointer owner flag, shared pointer, best-effort rollback

**Trusted Review Witness Aggregate**:
The process-local Pi authority grouped by session, Standalone Review root, and Review Run, with explicit touch recency. Verification considers only the current run for that root; rejection never falls back, exact acceptance is idempotent and retires older root witnesses, and session shutdown prunes the session aggregate.
_Avoid_: Review cache, accepted result fallback, global witness map

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
An execution scope that determines which lint rules apply. "Immediate" (PostToolUse after edits, regex-only, cooperative 50ms per-file deadline) or "full" (Wave Gate/explicit scan, all rules including programmatic structural analysis).
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
A semantic policy assigning one Agent role to complete harness-specific requested bindings: a Claude Code model and an exact Pi provider/model/thinking tuple. Missing bindings fail closed. Pi launcher policy may explicitly inherit a local parent model at the spawn boundary; the profile catalog never infers that override.
_Avoid_: Model alias, Sonnet equivalent, current model, implicit model fallback

**Runtime Revision**:
A content-addressed identity over Loom's extension, engine, and runtime package bytes. Pi captures it when the extension loads; every fresh Pi-launched CLI mutator must present the same identity before changing a TaskGraph or Run Directory.
_Avoid_: Package version, schema version, commit hash, current checkout

**Implementation Attempt**:
One engine-reserved execution of one Task under one semantic attempt ordinal and one immutable byte baseline. Only engine-issued attempt authority can settle it; a Task id inferred from concurrent execution state is cleanup evidence, not completion authority.
_Avoid_: Agent run, retry (that is a transition between attempts), subagent result

**Implementation Retry Context**:
The canonical immutable prompt appendix derived from one exact attempt-1 `retry-required` settlement receipt. It binds Task, semantic attempt 2, predecessor receipt, and sorted failure kinds; the shared spawn gate must match the status-issued appendix byte-for-byte before issuing attempt-2 authority. Infrastructure failures reuse the current semantic attempt and never mint this context; attempt-2 semantic failure produces terminal escalation rather than another context.
_Avoid_: Failure reason, retry prompt, retry count, attempt token

**Verification Policy**:
A Task's explicit, independently modeled requirements for regression execution and new-test creation, including typed waiver reasons. It replaces the ambiguous `new_tests_required` coupling; legacy booleans are translated only at the TaskGraph parse boundary.
_Avoid_: Test flag, new-tests flag, test exemption

**Verification Manifest**:
The operator-owned `.loom/verification-manifest.json` source of fixed Wave completion commands. TaskGraph population parses and freezes its executable/argv/cwd/timeout/report authority before implementation; decompose and implementation Agents cannot supply runtime command authority. An absent source freezes the engine default containing only reserved checks.
_Avoid_: Test script, model command, shell command, CI config

**Completion Check Result**:
One engine-observed deterministic check outcome carrying independent exit-code, timeout, signal, and report-production facts under an exact check identity and Task-or-Wave scope. Spawn failure is a separate arm, never disguised as a failed test.
_Avoid_: Test evidence, command output, exit status

**Completion Suite Result**:
A non-empty exact set of Completion Check Results bound either to one Implementation Attempt or to one quiescent Wave workspace. Missing, surplus, duplicate, stale, or wrong-scope results cannot settle completion.
_Avoid_: Test run, CI result, lint result

**Implementation Completion Oracle**:
The pure aggregate command that combines Implementation Attempt authority, normalized observation, Proof Obligations, Verification Policy, and a Completion Suite Result into exactly one transition: implemented, retry required, escalation required, infrastructure blocked, or ignored stale/duplicate evidence. Pi and Claude Code adapt into it; neither harness is a separate completion authority. One exact transition applier consumes its output, appends the settlement receipt, releases only matching authority, and performs review/spec/Wave invalidation atomically.
_Avoid_: SubagentStop hook, Wave Gate check, test runner, completion service

**Task-local Byte Scope**:
The exact path set captured in `attempt_artifact_baseline`: declared Task paths plus previously attributed Task paths at registration. `loom:task-byte-scope` compares only those bytes against that attempt baseline. Parser-proven transcript paths outside the set are semantic failure regardless of repository ownership; baseline/path/read/Git uncertainty is infrastructure unavailable. Under the locked TaskGraph, other current-Wave Tasks' canonical `file_list` plus `files_modified` form sibling ownership. Repository changes relative to the first unresolved baseline classify exactly: current Task paths are Task-local, sibling-owned paths are inert/non-attributable, and every remaining unowned path is semantic out-of-scope evidence recorded in `unresolved_repository_paths` even when the transcript omits it. The baseline and unresolved paths persist across failed, infrastructure-blocked, rolled-back, and reclaimed attempts; reversion removes resolved paths, and accepted exact settlement clears the carry. The Task-local suite runs no Task/project subprocesses; build, test, typecheck, reports, and full-tier lint remain Wave-quiescent checks.
_Avoid_: Repository dirty set, transcript file list, Task test command

**Implementation Settlement Receipt**:
The immutable, self-digested audit record for one exact Implementation Attempt transition. Retry/escalation receipts consume the semantic attempt; implemented and infrastructure-blocked receipts do not. Receipt identity makes duplicate delivery idempotent; exact active-authority and reservation-digest matching prevents a late result from releasing a newer reservation.
_Avoid_: Rollback receipt, cleanup log, retry counter

**Proof Obligation**:
An engine-authored requirement a Task must discharge before its status can become implemented: completion, required regression tests, required new tests, and declared artifacts changed. Regression and new-test obligations derive independently from Verification Policy. Evidence keeps its provenance; Pi structured evidence is never relabeled as ledger-trusted.
_Avoid_: Checklist item, self-report, completion claim

**Spec Index**:
A pure deterministic projection of one canonical specification into Functional Requirement (`FR-NNN`), Acceptance Scenario (`AS-NNN`), Out-of-Scope (`OOS-NNN`), and glossary entries with canonical content hashes. It is derived join input, not a second source of truth; malformed or duplicate identifiers fail parsing. Each family is a distinct type and each entry's content hash is derived at construction, so the three collections cannot be substituted for one another and an entry whose hash disagrees with its content is unrepresentable. The colon and the contiguous family token are the deliberate prose-disambiguation boundaries: an ID-shaped line without a colon ("FR-002 and FR-003 are related") or with a spaced family token ("F R-002:") is prose, not a malformed identifier, and stays legal; every Markdown marker-run form (`> >`, `- -`, `* *`, `1. 2.`) before a colon-full ID fails closed.
_Avoid_: TaskGraph, specification database, LLM requirement summary

**Spec Parse Error**:
One structured reason a specification failed to project into a Spec Index — the failure's kind plus its payload (section, document-absolute line, identifier, term). It is the parse failure itself, not a rendering of it: callers discriminate on the kind, and one total renderer owns the operator-facing text, so rewording a diagnostic cannot change any caller's behavior and a new failure reason cannot reach an operator without text.
_Avoid_: Error message, diagnostic string, validation warning

**Review Packet**:
A canonical immutable snapshot binding one Task to its base/head revisions, exact declared/modified path scope, diffs, byte-preserving postimages, plan context, and Proof Obligations. Postimages use `utf8` when lossless and `base64` otherwise; their digest identifies the original bytes. The sole review scope; empty scope fails rather than broadening to the wave. Its self-hashes prove integrity, not provenance; historical write recovery additionally requires the exact engine-issued packet registration stored in protected Task state at packet creation.
_Avoid_: File list, live diff, review context, fallback scope, self-authenticating recovery packet

**Issued Review Packet Registration**:
Protected Task-state authority written atomically with Review Packet publication. Binds Task id, canonical packet path, packet id, base/head revisions, and exact scope so later historical recovery can distinguish an engine-issued packet from operator-authored content with recomputed hashes.
_Avoid_: Packet hash, packet signature, inferred provenance

**Panel Program**:
The executable event-sourced dispatch policy for an architecture panel or Refutation Panel. Emits exact spawn batches, LLM Profiles, retry actions, engine operations, and terminal outcomes; Markdown explains execution but does not own ordering.
_Avoid_: Runbook sequence, workflow DSL, panel prompt

**Scoped Write Grant**:
A one-time Pi capability minted per spawn, scoped to prompt-derived artifact directories (`.claude/specs/`, `.claude/plans/`, panel-run dirs) for WRITER agents only: phase writers (brainstorm, specify, clarify, plan-alignment, architecture) and panel writers (interviewer, designers, finalizer). Issuance is role-driven — a read-only agent (judge, verifier, reviewer, decompose, spec-check) receives nothing even when its prompt names artifact paths.
_Avoid_: Write permit, edit allowance, blanket phase write

**Agent Request Authority**:
An engine-issued immutable binding of Run, request, roster slot, semantic attempt, program, Agent role, LLM Profile, both harness bindings, required Skill, Context Packet digest, and fixed transcript slot. Harness-native ids correlate to it but never replace it.
_Avoid_: Prompt metadata, spawn args, transcript filename

**Context Packet**:
A content-addressed immutable collection of fixed and variable byte sections published before an Agent request. Its digest is part of Agent Request Authority; children read it instead of relying on a parent model to reconstruct scope and protocol prose.
_Avoid_: Prompt blob, context string, temporary instructions

**Effect Receipt**:
A typed durable record that an authorized orchestration side effect completed. Resume reconciles a matching receipt instead of executing the effect again.
_Avoid_: Log line, success flag, checkpoint

**Orchestration Façade**:
The single parent-facing engine interface for status and registered architecture/refutation/standalone-review/Wave-Gate/remediation programs. It returns only spawn-batch, await-user, blocked, or done at external boundaries.
_Avoid_: Helper collection, workflow script, shell runbook

**Inline-Program Stdin Inheritance**:
The guard-state-file residual class where an interpreter's `-c`/`-e` inline program inherits the command's stdin: if the program is itself a stdin-reading interpreter (`bash -c 'sh'`, `bash -c 'python3'`) or a reader+executor pair (`bash -c 'eval "$(cat)"'`), the heredoc body is a SCRIPT and is judged as full command text. An inline program with its own program source (`bash -c 'sh file.sh'`) or an inline DATA reader (`bash -c 'cat'`) reads the body as data.
_Avoid_: Nested interpreter, double interpreter, inner shell

**Executable Model**:
A model the system imports, runs, or enforces — a lifecycle machine, an AuthoredDag, or a lint rule. The only kind of model loom permits: a model either executes or it doesn't exist (`references/executable-models.md`).
_Avoid_: Behavioral model, descriptive model, structural diff (these name the forbidden alternative)

**Lifecycle Machine**:
A statechart or typed reducer bound to a plan's `LC-N` declaration. The single source of truth for a domain lifecycle; implementation code imports it and never re-implements its transitions. "Imports it" means a production path reduces through it — a machine only a test drives is not a source of truth, it is a second opinion nobody consults. A machine reaches production either by **checkpoint** (its serialized state is the resume position, as LC-2 and LC-3 do) or by **projection** (a pure function reduces it over durable evidence the shell already reads, as LC-1 does through `projectWaveGateLifecycle`). Which one a machine uses is a property of where its truth lives: a program outside the State File must checkpoint; a program whose evidence is already durable elsewhere may project.
_Avoid_: State diagram, workflow doc, lifecycle description, model that only tests drive

**Guarded Skill Machine**:
A deterministic phase machine (`machines/<agent-type>.machine.json`) that drives one SUBAGENT RUN: the runtime enforces phase order and tool availability while attributed tool calls are the events that advance it (`machines/README.md`). Unrelated to the **Lifecycle Machine** above — see Flagged Ambiguities. A Lifecycle Machine models a DOMAIN lifecycle declared by a plan's `LC-N` and reaches production by checkpoint or projection; a Guarded Skill Machine models one agent's PHASE ORDER and reaches production by gating that agent's tools while it runs. Bound per session with an epoch (`<agent_id>:<agent_type>`); an unparseable machine file binds too, so the gate fails closed rather than silently disabling.
_Avoid_: Skill state machine, agent statechart, phase gate (alone)

**Public Surface**:
The curated list of symbols a module publishes to callers outside it — for the orchestration shared kernel, exactly what `orchestration-contract/index.ts` re-exports. Deliberately NOT the union of what its parts export: a sub-module exports a symbol so sibling sub-modules above it can use it, which is an internal relationship and says nothing about what callers need. The distinction is enforced, because `tsc` cannot see it — an export with no importer is invisible to the compiler, so a barrel that re-exports everything makes dead exports indistinguishable from public ones.
_Avoid_: Barrel, API surface, exports (bare), the index

**Checkable Invariant**:
A plan invariant (`INV-N`, tier `checkable`) expressed as a lint rule enforced fail-closed on every edit. Invariants that cannot be deterministically checked are tiered `advisory` and stay honest prose.
_Avoid_: Constraint (too generic), rule (alone), enforced guideline (advisory rules are never enforced)

## Relationships

- A **Phase** produces one or more artifacts consumed by subsequent **Phases**
- A **Plan** is decomposed into **Tasks** grouped into **Waves**
- A **Task** may make **Requirement Contributions** before or during the one Wave that owns the **Requirement Completion Claim**
- A **Requirement Contribution** never enters Wave Gate completion scope; the **Requirement Completion Claim** does
- Every **Requirement Contribution** has exactly one same-or-later completion Wave, and none may occur after completion
- A **Wave Gate** validates all **Tasks** in a **Wave** before the next **Wave** begins
- A **Tier** determines which lint rules execute: "immediate" runs regex-only after edits, "full" runs all rules at Wave Gate boundaries or explicit scans
- An **Agent** executes exactly one **Task** or one **Phase**
- Every Loom-owned **Agent** resolves one explicit requested **LLM Profile** before spawn; Pi launcher overrides are explicit at the transport boundary
- An interactive Pi phase **Agent** runs through the **Interactive Phase Transport**; every headless role remains on the normal subagent transport
- A Pi-launched mutating CLI process must match the in-memory extension's **Runtime Revision** before changing protected or run-scoped state
- A **Task** becomes implemented only after all of its **Proof Obligations** and required Task-scoped Completion Check Results are satisfied
- An **Implementation Attempt** is settled only by the **Implementation Completion Oracle** under exact engine-issued authority and one **Implementation Settlement Receipt**
- Unversioned Slice-3 **Implementation Settlement Receipts** use a read-only compatibility projection until the next registration records protocol-2 cutover authority; from that strict suffix, ordered receipts form one fail-closed lineage: current-attempt infrastructure preserves state, current-attempt implementation reopens attempt 1, attempt-1 semantic failure derives exactly one byte-exact **Implementation Retry Context**, and attempt-2 semantic failure escalates terminally; skipped-terminal, reordered, or post-escalation receipts authorize nothing
- A Task-local Completion Suite contains only `loom:task-byte-scope`; it runs no Task/project subprocesses
- Repository observation never grants Task attribution: current Task paths stay local, locked current-Wave sibling-owned paths stay inert, and every changed unowned path is unresolved semantic failure/invalidation
- Slice 3 classifies retry-required/escalation-required without dispatch; Slice 4 freezes retry context, authorizes semantic attempt 2 dispatch, and publishes terminal escalation for operator handling
- A Task's **Verification Policy** independently determines its regression and new-test **Proof Obligations**
- A **Verification Manifest** is frozen by the engine before implementation and cannot be authored through decompose output
- A Task-scoped **Completion Suite Result** binds to one **Implementation Attempt**; a Wave-scoped result binds to a quiescent Wave workspace
- Review Agents consume one immutable **Review Packet** per Task
- A **Session TaskGraph Pointer Lease Registry** restores its previous target only after the generation's final exact lease is released
- A **Trusted Review Witness Aggregate** verifies only the most recently touched Standalone Review Run for one session/root and is pruned at session shutdown
- A **Review Run** binds that Review Packet to one **Review Generation**, the expected review Agents, and all prior active Finding IDs
- A **Resolved Finding** leaves the active set only when every Agent in its Review Run explicitly verifies remediation; any `still_present` assessment keeps it active
- A **Panel Program** emits the exact Agent batches and engine operations for each panel
- The **Orchestration Façade** materializes each batch as **Agent Request Authority** plus a **Context Packet**
- An **Effect Receipt** makes an authorized side effect reconcilable and idempotent across resume
- A **Standalone Review Run** feeds identified critical Findings through the same **Refutation Panel** without creating a Task or mutating the State File
- A **Skill** is loaded into an **Agent** to provide domain expertise
- **Hooks** enforce invariants on the **State File** — no other actor writes to it
- A **Spec** contains **Clarification Markers** resolved by the clarify **Phase**
- An **Aggregate** is immutable data; command functions in the **Functional Core** produce new instances
- The **Imperative Shell** orchestrates: load via **Port** → call **Functional Core** → persist via **Port**
- **Domain Events** are returned by pure command functions; the **Imperative Shell** publishes them
- A **Plan** may declare **Executable Models**; decompose validation blocks a declared model that no **Task** binds to an artifact
- A **Lifecycle Machine** is implemented by a dedicated **Task** in the earliest wave; dependent **Tasks** import it
- Every declared **Lifecycle Machine** reaches production by checkpoint or by projection; one that neither checkpoints nor projects is not an **Executable Model**
- A module's **Public Surface** is curated, and every symbol on it has a consumer outside that module
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
- "machine" names two unrelated things: the **Lifecycle Machine** (a plan's `LC-N` domain lifecycle, in `engine/src/core/`) and the **Guarded Skill Machine** (a per-agent-type phase gate, defined in `machines/` and implemented in `engine/src/machine/`). The directory names are the trap — `core/*-machine.ts` is the first, `machine/` is the second. Resolved: always say "Lifecycle Machine" or "Guarded Skill Machine" when both could be meant; bare "machine" is fine inside one of the two subsystems' own documentation. They share no types and no code.
