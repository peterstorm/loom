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

**Emission Tool**:
The exact frozen-schema producer tool one emission-enabled child request advertises — one registered name per producer kind (`loom_emit_reviewer_payload`, `loom_emit_judge_verdict`, `loom_emit_refutation_verdict`; the issued binding selects the reviewer schema version, v2 or v3), with parameters byte-identical to the frozen payload schema for that kind/version. The child registers and executes it; the engine parser stays validity-authoritative and the model does not select the tool, kind or version.
_Avoid_: output schema, structured output (generic), second schema (there is exactly one frozen schema)

**Emission Source**:
The engine-side provenance recorded for every ingested payload: `emission-tool` arguments or final-message `extraction`. Selection is one deterministic decision bound to the issued request attempt over a closed emission-observation vocabulary — absent, exactly one complete call, multiple distinct calls, or an unusable observation with a reason — where wrong-request, wrong-kind/version, incomplete and otherwise unusable observations refuse as typed rejections rather than becoming absence, and an exact transport replay of one call is idempotent. Acceptance binds the source durably to the accepted evidence. Genuinely pre-feature accepted events were extraction; a malformed present-day source field is not historical absence.
_Avoid_: payload origin, delivery path

**Qualified Emission Route**:
The exact provider/served-model/schema-digest triple whose recorded qualification accepts the frozen emission schemas — the sole authority for enabling emission on an issued request. Provider capability flags remain operator configuration; a flag, a provider name, or a successful local schema round-trip is not qualification. Requalification is triggered by a served-model switch, a schema digest change, or a pi upgrade changing tool serialization or resolver behavior.
_Avoid_: capable provider, strict-sampling support (unproven), auto-detected capability

**Readiness Barrier**:
The bounded, request-bound pre-model gate at the Pi launcher: the child must prove its actual registered, active tool matches the issued request, producer kind, version and schema digest before any model request is delivered. Missing, stale, contradictory or wrong-request readiness fails closed, and the remediation names the actual cause. Parent admission and the runtime revision handshake alone are not readiness proof.
_Avoid_: startup notification, readiness flag, parent hash check

**Wire Contract**:
The exact machine-readable output shape a review Agent must emit. Fresh independent standalone/Wave issuance uses Reviewer Protocol v2: one JSON payload with engine-derived counts and IDs. Only explicit standalone successor schema-3 input selects the separate v3 envelope; its new Finding drafts retain v2 evidence. The executable schema/rubric generate the shared fragment and seven stamped shims; never hand-edit those copies. Completed and unfinished issued v1 contracts retain their original markers/block/lifecycle parsing. [ADR-0009](docs/adr/ADR-0009-versioned-reviewer-protocol.md) records the boundary. P4 merged as `96153ed` on 2026-09-10; publication and loaded-runtime cutover were verified. P5 successor contracts are implemented and the registered review and remediation are complete ([ADR-0010](docs/adr/ADR-0010-standalone-finding-lineage.md)); they do not rewrite issued v1/v2 evidence. Publication and the /reload cutover happen after merge.
_Avoid_: Output format, response template, Machine Summary (that is one historical v1 section, not the current contract)

**Wave Gate**:
A quality checkpoint between waves. Requires test evidence, spec alignment, code review, and — whenever the wave holds critical **Findings** — the adjudication of a **Refutation Panel** before advancing.
_Avoid_: Gate, barrier, checkpoint (alone — always qualify as "wave gate")

**Finding**:
One assertion a review agent made about the code, carrying a severity (critical or advisory), an optional file/line, and a derived id. The unit a **Refutation Panel** votes on. Ids are derived from (agent, ordinal), never agent-chosen — an agent-chosen id collides across runs and reviewers, and a k-of-n vote needs an item two verifiers can agree they are discussing. A finding a reviewer merely emitted is a *draft finding*; it becomes a finding when attribution gives it identity.
_Avoid_: Issue, comment, violation, remark

**Issued Reviewer Protocol**:
The nominal authority joining independent registration, published request and Context Packet to reviewer admission. Current packets freeze exact reviewer schema and impact rubric bytes; genuine v1 issuance retains its original contract without inventing a retrospectively frozen rubric. Output shape and caller version hints never select the decoder.
_Avoid_: Payload version authority, decoder fallback, current prompt

**Finding Basis**:
A reviewer's structured evidence or execution trace, violated contract, consequence and evidence limits, truth confidence, and severity rationale accompanying one claim. Required for a v2 critical; optional but complete for an advisory, which requires a concise reason. These six critical fields (claim plus five basis fields) are semantic assertions, not engine-proven truth, impact, reachability, execution, or test adequacy.
_Avoid_: Proof of defect, impact score, execution receipt

**Reviewer Protocol Failure**:
Unusable reviewer evidence under its Issued Reviewer Protocol, consuming only existing bounded evidence-retry authority and creating no v2 product Finding or Defect-Family repair obligation. Infrastructure observation failure instead remains unavailable at the same semantic attempt.
_Avoid_: Synthetic critical, advisory downgrade, clean review

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

**Finding Origin**:
The immutable identity of one originally attributed Finding, qualified by its originating Standalone Review Run, issued request and accepted transcript, and joined to its original result publication. A bare Finding ID is only local identity; a successor preserves the original assertion, severity, location and evidence rather than reminting it. Current locally originated Findings obtain their result identity from enclosing publication, never a self-referential digest.
_Avoid_: Similar claim, deduplicated Finding, global ordinal

**Standalone Disposition Record**:
An immutable independently published parent-policy record bound to one exact completed Standalone Review result and its complete ordered advisory-origin inventory, including retired history. A no-agent program publishes it immediately after autonomous parent triage, even without later remediation/successor work. Accepted/deferred/dismissed decisions and reasons remain DECLARED; corrections name an exact earlier published revision without editing it, and forks remain explicit. Historical absence and present-day imports retaining exact prose/reference are distinct; missing/corrupt expected current publication never becomes historical absence. This is neither Refutation Panel authority nor repair evidence.
_Avoid_: Resolved Finding, policy proof, mutable triage ledger

**Standalone Successor Binding**:
One explicit authenticated predecessor result, exact published disposition revision or honest historical absence, conserved Finding Origin inventory, and the successor's frozen source bytes/modes and complete issued reviewer roster. Explicit schema-3 start selects this binding; independent standalone/Wave issuance remains v2. Successors retain prior scope and roles; dependencies/contracts must be explicitly scoped, and unknown historical observations stay unknown. Every current reviewer assesses every inherited origin once in order, including retired history. Forks are never automatically merged. Independent reviews and same-Run infrastructure recovery are not successor bindings.
_Avoid_: Latest review, same-name Run, review reuse, recoverable predecessor state

**Standalone Resolution Assessment**:
A source-bound semantic assessment resolving one prior Finding only when every current expected review Agent explicitly verifies its repair and identifies a relevant implementation change. Every reason and current request is retained; any disagreement, not-assessable or absent assessment prevents resolution. It is reviewer judgment, never engine proof, a Task Review Generation, or an automatic consequence of Repair-Checked.
_Avoid_: Refutation, declared repair, passing-check proof

**Standalone Reopening Proposal**:
An issued successor reviewer's explicit challenge to one exact prior disposition/refutation/resolution, naming its Finding Origin, current applicability, changed conditions or contradictory new evidence, and evidence limits. A critical proposal reaches a fresh fully bound Refutation Panel under the existing majority rule before re-adjudication. It never rewrites the origin, promotes advisory severity or erases historical votes.
_Avoid_: Parent override, duplicate Finding, severity promotion

**Current Critical Coverage**:
A standalone successor's engine-derived complete-or-limited assessment coverage over inherited critical origins, including refuted/resolved history. A not-assessable critical origin yields explicit limitation even when no critical is currently active; P3 refuses before checks/candidate/installable authority. This is separate from fresh panel work and surviving-critical counts.
_Avoid_: Zero-critical pass, new-finding count, test coverage

**Attempt-One Admission**:
The pure decision that classifies every expected attempt-1 slot of a resumed standalone review as captured, reissue, or tombstoned, given the captured-attempt set and every gathered capture-rejection receipt. Two refusal classes both reject the slot where the machine can advance it to attempt 2 instead of dead-locking the roster on every resume: a semantically refused transcript, and a capture terminally rejected by the harness runtime (no bytes landed at all). A tombstoned slot is dead for capture and is not re-issued; the machine advances it to attempt 2 through the rejection path. The shell gathers the I/O first and applies the returned trichotomy — the policy is never interleaved with I/O.
_Avoid_: Admission sweep, Phase A (a reviewer's phase label, not the decision), retry decision

**Defect-Family Accounting**:
Exact accounting of one Standalone Review Run's surviving critical Finding IDs into Declared Repair Groups or explicit blocking dispositions. Grouping, root cause, invariant, sibling-path completeness, and Historical RED remain semantic declarations; accounting never changes the source Findings or creates a Resolved Finding.
_Avoid_: Proven closure, automatic root-cause discovery, cross-run finding lineage

**Declared Repair Group**:
A separately identified grouping that retains every original Finding ID and declares one root cause, invariant, sibling-path accounting, and selected operator-owned regression checks. Grouping is declared, not confirmed by a digest or inferred from similar text.
_Avoid_: Merged Finding, confirmed defect, replacement Finding ID

**Historical RED Declaration**:
An explicitly `DECLARED` statement about a regression against vulnerable behavior. It may cite historical evidence, but is never represented as engine-observed execution of the vulnerable snapshot.
_Avoid_: Observed counterfactual, verified historical failure, execution receipt

**Repair-Checked**:
The bounded remediation outcome: every surviving critical and declared sibling is accounted for without blocking dispositions, and selected operator-owned checks produced fresh passing structured test reports under engine observation on unchanged candidate bytes. It proves neither the declared root cause nor historical RED. Zero surviving criticals instead yields `not-required`; legacy completion has `historical-unknown` accounting.
_Avoid_: Proven closed, Resolved Finding, semantic proof

**State File**:
The single source of truth for orchestration progress (`active_task_graph.json`). Write-protected; Hooks and explicitly whitelisted StateManager-backed CLI helpers are its only mutation paths.
_Avoid_: Config, manifest, plan file

**Session TaskGraph Pointer Lease Registry**:
The exact parsed immutable generation record beside one session's `.task_graph` pointer. Every same-target binder owns one lease; only the final lease may restore the generation's previous target, and a different target or contradictory/malformed crash state fails closed under the same no-follow lock.
_Avoid_: Pointer owner flag, shared pointer, best-effort rollback

**Trusted Review Witness Aggregate**:
The process-local Pi authority grouped by session, Standalone Review root, and Review Run — one instance per loaded extension factory, injected into spawn admission, result capture, the review-authority bridge and session shutdown rather than reached as module state. A run becomes current when its first exact standalone spawn is bound before dispatch; retries and later captures enrich that run without reordering it. Verification considers only the current run for that root; rejection or missing capture never falls back, exact acceptance is idempotent and retires older root witnesses, and session shutdown prunes the session aggregate.
_Avoid_: Review cache, accepted result fallback, global witness map

**Spawn Claims Ledger**:
The immutable record of every capability one Pi spawn batch has taken while its admission is in progress — staged emission launches, issued write grants and whether their prompt was rewritten, reserved roster entries, the task-graph pointer lease. A refused admission releases it in one planned order (capabilities first, roster entries newest-first, the pointer lease last), attempting every release; exactly what failed to release stays on the parent session as cleanup debt. Role authority is never part of the ledger: none is committed until the whole reservation is.
_Avoid_: Rollback list, cleanup closure, admission state

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
A semantic policy assigning one Agent role to complete harness-specific requested bindings: a Claude Code model and an exact Pi provider/model/thinking tuple. Missing bindings fail closed. Wave/standalone reviewer issuance may explicitly select the catalog's `qualified-local-review` alternative only when the observed Pi parent has the exact qualified provider, model, and thinking setting; other roles and cloud sessions retain their assigned default. Both harness bindings and the selected profile are frozen in Agent Request Authority. Pi launcher policy may explicitly inherit a local parent model at the spawn boundary, but cannot change issued authority or infer a new profile from task text.
_Avoid_: Model alias, Sonnet equivalent, current model, implicit model fallback

**Runtime Revision**:
A content-addressed identity over Loom's extension, engine, and runtime package bytes. Pi captures it when the extension loads; every fresh Pi-launched CLI mutator must present the same identity before changing a TaskGraph or Run Directory.
_Avoid_: Package version, schema version, commit hash, current checkout

**Implementation Attempt**:
One engine-reserved execution of one Task under one semantic attempt ordinal and one immutable byte baseline. Only engine-issued attempt authority can settle it; a Task id inferred from concurrent execution state is cleanup evidence, not completion authority.
_Avoid_: Agent run, retry (that is a transition between attempts), subagent result

**Implementation Binding**:
On Claude Code, the exact link between one running implementation Agent and the Implementation Attempt its own trusted first prompt names, persisted as the implementation-attempt sidecar. It is `pending` (rostered, no sidecar: Claude writes the child transcript only after SubagentStart), `bound`, or `refused` (the prompt names no, an unknown, or a non-executing Task, or a conflicting authority owns the Agent). It is attempted opportunistically at SubagentStart when the prompt is already on disk, by block-direct-edits before every write decision, and once more at SubagentStop for an Agent that never wrote; `refused` is re-derived on each attempt, not permanent. A `pending` write is a retriable block, but one that persists across retries means the child transcript location cannot be resolved and is reported, not retried. Only `bound` admits writes, and it is never inferred from which reservations are pending. Pi binds at spawn through write grants and has no Implementation Binding.
_Avoid_: Write grant (Pi's mechanism), reservation guess, roster role

**Implementation Retry Context**:
The canonical immutable prompt appendix derived from one exact attempt-1 `retry-required` settlement receipt. It binds Task, semantic attempt 2, predecessor receipt, and sorted failure kinds; the shared spawn gate must match the status-issued appendix byte-for-byte before issuing attempt-2 authority. Infrastructure failures reuse the current semantic attempt and never mint this context; attempt-2 semantic failure produces terminal escalation rather than another context.
_Avoid_: Failure reason, retry prompt, retry count, attempt token

**Verification Policy**:
A Task's explicit, independently modeled requirements for regression execution and new-test creation, including typed waiver reasons. It replaces the ambiguous `new_tests_required` coupling; legacy booleans are translated only at the TaskGraph parse boundary.
_Avoid_: Test flag, new-tests flag, test exemption

**Verification Manifest**:
The operator-owned `.loom/verification-manifest.json` source of fixed Wave completion commands. TaskGraph population parses and freezes its executable/argv/cwd/timeout/report authority before implementation; decompose and implementation Agents cannot supply runtime command authority. An absent source freezes the engine default containing only reserved checks.
_Avoid_: Test script, model command, shell command, CI config

**Project Verification Coverage**:
A pure read-model projection of the configured project-check roster, independent of Completion Suite acceptance. `projectVerificationCoverage` is either `configured` with immutable, sorted, non-empty `checkIds`, or `not-configured` with reason `engine-default` (source absent at population), `empty-operator-manifest` (operator configured zero project checks), or `historical-unknown` (archived reserved-only receipt lacks source provenance). Current coverage comes from the frozen Verification Manifest; completed schema-v2 Wave coverage comes from its archived accepted receipt, never the live source file. Legacy-unavailable readiness supplies no invented coverage. It adds no persisted authority, waiver, or requirement that every project configure checks: reserved-only suites may still advance, but cannot claim project verification passed. Configuration itself is not a pass.
_Avoid_: Test coverage, project-check pass, verification waiver, persisted coverage flag

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
A pure deterministic projection of one canonical specification into Functional Requirement (`FR-NNN`), Acceptance Scenario (`AS-NNN`), Out-of-Scope (`OOS-NNN`), and glossary entries with canonical content hashes. It is derived join input, not a second source of truth; malformed or duplicate identifiers fail parsing. Each FR/AS/OOS entry's complete Markdown list-item body — physical bullet, directly adjacent lazy paragraph continuations, and blank-separated paragraphs indented beneath the marker — is one canonical content value and one hash input; an unindented block after a blank ends the entry, so wrapping a mandatory clause cannot remove it from drift authority and unrelated prose cannot enter it. Owned nested prose, headings, thematic breaks, and fence-shaped text remain content; colon-full FR/AS/OOS identifiers inside that owned body refuse the specification instead of becoming hidden or absorbed declarations. Genuine top-level examples remain excluded. This is a bounded Spec grammar, not complete CommonMark conformance. Each family is a distinct type and each parser-minted entry's content hash is derived at construction, so the three collections cannot be substituted for one another and engine-produced entries keep content/hash construction in one place. The phantom constructor-origin brand is not forgery-proof: structural spreading can preserve its static type while replacing content, so runtime consumers trust parser provenance rather than the brand as a security boundary. The colon and the contiguous family token are the deliberate prose-disambiguation boundaries: an ID-shaped line without a colon ("FR-002 and FR-003 are related") or with a spaced family token ("F R-002:") is prose, not a malformed identifier, and stays legal; every Markdown marker-run form (`> >`, `- -`, `* *`, `1. 2.`) before a colon-full ID fails closed.
_Avoid_: TaskGraph, specification database, LLM requirement summary

**Spec Index Observation**:
The compact immutable record of the Spec observation prepared during TaskGraph Population, stored in `spec_index_observation`. It retains either indexed document path/digest or the typed unavailable reason; it never copies ParsedSpec or Requirement text into the TaskGraph. Population replaces it with the Tasks, the load boundary checks its shape and protected document path, and later Wave packets can explain missing Requirement hashes from it. It is explanatory provenance, not an independent settlement floor or proof that a missing hash is stable. Legacy absence stays absent.
_Avoid_: Cached Spec Index, current Spec verdict, settlement authority

**Requirement Coverage Projection**:
The pure deterministic join of one Spec Index against the whole protected Task roster — rows for the current Wave, unclaimed lists over every Wave — classifying every Requirement Completion Claim before any Agent reads a file. Four outcomes are decided by structure alone and are not a model's to overturn — the claim names no Spec Index entry, it claims completion of an explicitly excluded item, its Task declared no artifacts, or its Task modified no files — and what survives is a candidate the Agent assesses for behaviour. **Severity and settlement are separate facts**: who decides a row follows from its verdict kind, while severity says how bad the structural fact is, so a drifted or altered-hash candidate carries a severity AND still owes an assessment. It names the Functional Requirements and the Acceptance Scenarios whose completion has no planned owner at any Wave — Requirement Contributions are deliberately not counted there, because they never assert completion. A Wave that claims no completion but carries valid Contributions is a legitimate foundation Wave and is rendered as one, never as work that traces nowhere; so is a Wave made only of Architecture Decision Records for work that already shipped, which traces to the plan's decisions rather than to a Requirement. The settled floor contains every canonical structural CRITICAL Finding line, including an altered-hash candidate even though an Agent still assesses its implementation, plus the unclaimed identifiers and synthetic no-trace Finding. The immutable packet renders those exact lines; the Wave epoch records their identities and safe count; capture requires every identity while allowing additional Agent Findings. Historical count-only floors remain count-enforced for their original packet and upgrade on the next byte-identical installation. Enforced and rendered authority is the same value by construction: nothing re-projects it later, because the inputs that decide it are not all covered by the epoch digest. When no Spec Index can be projected the projection is an honest absence with a stated reason, never a pass, and it then carries no Requirement text, scenario roster, exclusion list or glossary. Registered settlement records a typed projection-unavailable evidence failure; only the separately authorized, parser-minted manual operator override may settle without projection authority, and its reason is persisted on the captured evidence.
_Avoid_: Coverage report, spec-check result, requirement checklist, LLM verdict

**Spec-check Settlement**:
The pure TaskGraph aggregate command that consumes validated Wave/manual authority plus a parsed transcript or capture failure and produces exactly one deeply immutable settlement: applied evidence with `spec_check` and its derived Wave block changed together, or a manual-evidence refusal that preserves the graph. Captured evidence has exactly two usable verdicts, `PASSED` and `BLOCKED`; a historical `UNKNOWN` count record parses into retryable transcript evidence failure rather than a third captured state. Transport shells own byte observation, request/document authority, locking, and persistence; none independently constructs or commits spec-check state.
_Avoid_: Spec-check store, transport-specific settlement, evidence write

**TaskGraph Population**:
The pure aggregate command that consumes a non-empty parser-proven authored Task roster, prepared Spec/verification authority, overwrite authority, and one locked TaskGraph and returns either a typed population refusal or the complete reset graph. It owns Task sanitization, Requirement Content Hash stamping, Wave Gate construction, current-Wave reset, and removal of every active or historical Wave/epoch/spec-check/completion authority tied to the replaced Tasks; the Hook owns JSON/CLI parsing, Git/filesystem observation, model checks, locking, and persistence.
_Avoid_: Populate hook policy, task merge, graph initializer

**Requirement Content Hash**:
The Spec Index content hash recorded per Requirement Completion Claim at the moment the Task→Requirement edge is created. Engine-derived, never authored: decompose says WHICH Requirements a Task completes, and the specification's own bytes say what they SAID. It is taken from the entry itself rather than re-derived, so no second canonicalization can disagree with the parser's; an identifier the specification does not define records nothing, because there is no text to assert about. Three absences are three different facts and none may be rendered as another: a Task with no recorded hash yields *unverifiable*, never *stable*; a stored value this engine could not have minted is corrupt authority, not missing authority; and a recorded hash that disagrees with the current text is drift.
_Avoid_: Anchor checksum, spec fingerprint, decompose-supplied hash

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
The single parent-facing engine interface for status and registered architecture/refutation/standalone-review/Wave-Gate/remediation programs. A new Wave Gate publishes its recoverable Run Directory program before installing protected `active_wave_gate` authority, so failed program publication leaves the TaskGraph unchanged; the locked install re-derives the exact Wave roster and authority digest, so TaskGraph drift after publication leaves only the recoverable Run Directory registration. It returns only spawn-batch, await-user, blocked, or done at external boundaries.
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
- **Project Verification Coverage** describes configured commands independently of **Completion Suite Result** acceptance; it never grants completion authority or asserts coverage of unconfigured test/build/typecheck categories
- A Task-scoped **Completion Suite Result** binds to one **Implementation Attempt**; a Wave-scoped result binds to a quiescent Wave workspace
- Review Agents consume one immutable **Review Packet** per Task
- A **Session TaskGraph Pointer Lease Registry** restores its previous target only after the generation's final exact lease is released
- A **Trusted Review Witness Aggregate** verifies only the latest first-bound Standalone Review Run for one session/root; retries/captures never reorder runs, and session shutdown prunes the aggregate
- A refused Pi spawn admission releases its **Spawn Claims Ledger**; only the releases that failed remain as the session's cleanup debt
- A **Review Run** binds that Review Packet to one **Review Generation**, the expected review Agents, and all prior active Finding IDs
- A **Resolved Finding** leaves the active set only when every Agent in its Review Run explicitly verifies remediation; any `still_present` assessment keeps it active
- A **Panel Program** emits the exact Agent batches and engine operations for each panel
- The **Orchestration Façade** materializes each batch as **Agent Request Authority** plus a **Context Packet**
- An **Effect Receipt** makes an authorized side effect reconcilable and idempotent across resume
- A **Standalone Review Run** feeds identified critical Findings through the same **Refutation Panel** without creating a Task or mutating the State File
- P5's feature-worktree implementation (final validation/review/publication pending in `.claude/plans/2026-09-10-standalone-lineage.md`): a **Standalone Disposition Record** captures advisory policy immediately and independently of later remediation or successor review
- A **Standalone Successor Binding** conserves every **Finding Origin**, its original publication and prior disposition history; fresh reviewer evidence never reuses predecessor votes as current review completion
- A **Standalone Resolution Assessment** requires the full current roster against one frozen source; **Repair-Checked** alone creates none
- Limited **Current Critical Coverage** cannot authorize P3 installation even when there are zero active criticals; full v3 canonical source bytes and original IDs remain in schema-2 remediation authority
- Only new criticals and evidence-bound critical reopening require current **Refutation Panel** work; unchanged upheld inherited criticals remain active without a new panel or extra automatic reviewer roster
- A **Standalone Reopening Proposal** preserves old adjudication and supplies explicit new evidence to current adjudication; only engine attribution creates new Finding IDs
- **Attempt-One Admission** is one pure decision applied by every standalone resume orchestrator; the shell gathers capture-rejection receipts first and the policy is never interleaved with I/O
- An **Issued Reviewer Protocol** binds the same parser/rubric through capture admission, retry, replay, panel projection, and publication; completed and unfinished issued v1 reviews retain their original contract
- A **Finding Basis** distinguishes truth confidence from consequence; structural admission proves neither, and an admitted surviving critical stays blocking without a new severity-dispute authority
- A **Reviewer Protocol Failure** blocks evidence completion, not product-defect accounting; the existing explicit Wave operator override remains separate from reviewer settlement
- A **Skill** is loaded into an **Agent** to provide domain expertise
- **Hooks** and explicitly whitelisted StateManager-backed CLI helpers enforce mutation invariants on the **State File** — no other actor writes to it
- A **Spec** contains **Clarification Markers** resolved by the clarify **Phase**
- An **Aggregate** is immutable data; command functions in the **Functional Core** produce new instances
- The **Imperative Shell** orchestrates: load via **Port** → call **Functional Core** → persist via **Port**
- Every spec-check transport delegates its TaskGraph transition to **Spec-check Settlement**
- The populate Hook delegates its locked TaskGraph transition to **TaskGraph Population**
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
