# Loom architecture

Loom is a dual-harness orchestration system for software delivery. Claude Code hooks and a Pi extension adapt harness events into one TypeScript engine. The engine combines a protected feature task graph with immutable, run-scoped programs for review, panels, Wave Gates, and remediation.

The central design rule is simple:

> Language models perform semantic work and users make genuine policy decisions. Loom code owns deterministic routing, identity, validation, persistence, retries, aggregation, and state transitions.

## System map

```text
commands / skills / agents / templates / rules
                    |
          harness adapter boundary
       +------------+-------------+
       |                          |
Claude Code hooks            Pi extension
hooks/hooks.json              pi/extension.ts
       |                          |
       +------------+-------------+
                    |
        handlers + parsers (shell boundary)
                    |
       pure domain cores and typed reducers
                    |
      orchestration façade + program drivers
                    |
       +------------+-------------+
       |                          |
protected TaskGraph       immutable Run Directory
(StateManager)            (RunDirHandle)
```

## Layer 1: product resources

Loom is not only an engine. Its package includes the semantic resources agents execute:

- `commands/` — slash-command runbooks. `/loom`, `/wave-gate`, `/review-pr`, `/review-and-fix` and `/security-audit` are the principal operational surfaces.
- `commands/templates/` — parameterized prompts for sequential phases, implementation Tasks, architecture-panel roles, and refutation verification.
- `agents/` — the Agent definitions, each with an explicit model profile and, where needed, a preloaded Skill ([inventory](agents.md)).
- `skills/` — reusable architecture, implementation, testing, security, frontend, lint, review/remediation, deepening, and domain-language knowledge.
- `rules/` — architecture and language guidance supplied to implementation and review Agents.
- `references/` — plan, spec and ADR templates, lens catalogs, and the runbooks `/loom` loads on demand.
- `lint-rules/` and `machines/` — executable policy, not prompt guidance.

These resources are shared source. Claude Code consumes them from the plugin. Pi renders commands, skills, references, and rules into a content-addressed cache and renders Agent definitions into the user Agent directory.

## Layer 2: harness adapters

### Claude Code

`hooks/hooks.json` binds Claude Code lifecycle events to small shell shims under `hooks/scripts/`. Every shim delegates to:

```bash
bun engine/src/cli.ts <hook-type> <handler> [arguments]
```

`engine/src/handler-routes.ts` is the closed routing table (`KNOWN_HANDLERS`). The spawn gates, the direct-edit block and the state guard act only while a State File exists. The routes marked *fail-closed* block when the handler itself crashes (`FAIL_CLOSED_ROUTES`), so a top-level import or stdin failure cannot allow a call by accident.

| Hook shim | Event and matcher | Purpose |
|---|---|---|
| `validate-phase-order.sh` | PreToolUse: Task/Agent/subagent | Phase sequencing: refuses a phase agent whose prerequisite phase is incomplete, and the decompose spawn until the plan design review is accepted for the plan's current bytes (or skipped). *Fail-closed* |
| `validate-task-execution.sh` | PreToolUse: Task/Agent/subagent | Expands an implementation brief marker; checks Wave and dependency order and path ownership; reclaims only policy-eligible reservations; writes skeletons; captures baselines; registers attempt and retry authority atomically. *Fail-closed* |
| `validate-template-substitution.sh` | PreToolUse: Task/Agent/subagent | Refuses a prompt that still holds an unsubstituted `{variable}`. *Fail-closed* |
| `validate-agent-model.sh` | PreToolUse: Task/Agent/subagent | Refuses a spawn whose model does not match the agent's LLM Profile. *Fail-closed* |
| `validate-agent-skill.sh` | PreToolUse: Task/Agent/subagent | Refuses a spawn whose prompt does not name the agent's required skill. *Fail-closed* |
| `block-direct-edits.sh` | PreToolUse: Edit, Write, MultiEdit | Keeps the orchestrator from editing; a phase agent writes only under its artifact roots, and an implementation agent only once its exact Implementation Attempt is bound (pending is a retriable block, refused a hard block). Scoped to the Orchestrated Repository: a write whose every canonical target lies outside the root owning the live graph passes (ADR-0046). *Fail-closed* |
| `enforce-phase-tools.sh` | PreToolUse: Edit, Write, MultiEdit | Guarded-skill machine: denies a tool the bound agent's phase does not allow. *Fail-closed* |
| `guard-state-file.sh` | PreToolUse: Bash | Deny by default on guarded state paths: only read-only commands and the helpers in `WHITELISTED_HELPERS` (`core/guard-state-file.ts`) pass. Covers the task graph, subagent evidence and binding files, and machine definitions. *Fail-closed* |
| `guard-subagent-authority.sh` | PreToolUse: Bash | A subagent may not change audit or orchestration authority (ADR-0067 D6). *Fail-closed* |
| `rules-gate.sh` | PreToolUse: Edit, Write, MultiEdit, Bash | Blocks code edits until the Loom rules and skills are in the model's context and adherence is stated. *Fail-closed* |
| `mark-subagent-active.sh` | SubagentStart | Tracks active subagents and binds the guarded-skill machine; binds an implementation agent's exact attempt when its prompt is already on disk, else leaves it pending |
| `record-evidence.sh` | PostToolUse: Read, Edit, Write, MultiEdit, Bash; PostToolUseFailure: Bash | Appends epoch-stamped facts (file reads, file writes, test runs) to the evidence ledger. Claude Code fires PostToolUse only when a call succeeded, so a failing test run reaches the ledger only through the failure event |
| `lint-file.sh` | PostToolUse: Edit, Write, MultiEdit | Immediate-tier lint: regex rules plus the immediate-tier programmatic rules; the full tier runs at the Wave Gate |
| `type-diagnostics.sh` | PostToolUse: Edit, Write, MultiEdit | Runs the project's incremental type check after a TypeScript edit and reports what no longer typechecks. Advisory; never blocks |
| `record-orchestration-spawn.sh` | PostToolUse: Task/Agent | Binds an engine-issued request id to the harness's child agent id |
| `surface-stop-check-notes.sh` | PostToolUse: Task/Agent | Hands the orchestrating session the stop-check notes its agents left |
| `cleanup-stale-subagents.sh` | SessionStart | Sweeps stale subagent tracking and binding files |
| `resume-after-clear.sh` | SessionStart: clear | Restores the `/loom` execution context after `/clear` |
| `dispatch.sh` | SubagentStop | Runs the stop checks, then routes by agent type to the handlers below (`engine/src/handlers/subagent-stop/`) |
| ↳ `capture-orchestration-result` | via dispatch, first | Request-bound capture of an engine-issued agent's result into its Run Directory |
| ↳ `advance-phase` | via dispatch | Advances `current_phase` once the phase's artifact is on disk, and records `spec_file` and `plan_file` |
| ↳ `update-task-status` | via dispatch | Settles an implementation attempt: implemented, retry-required, escalation-required or infrastructure-blocked |
| ↳ `store-reviewer-findings` | via dispatch | Parses review findings |
| ↳ `store-spec-check-findings` | via dispatch | Parses spec-check findings |
| ↳ `cleanup-subagent-flag` | via dispatch, always | Removes subagent tracking and machine bindings |

Two details the table does not show:

- **Implementation brief marker.** The parent sends only a marker (`LOOM_IMPLEMENTATION_BRIEF: T5`, optionally followed by `LOOM_OPERATOR_NOTE: <text>` lines that become the brief's Operator Note section). `validate-task-execution` renders the brief, runs every spawn veto and the reservation on it, and returns it as the call's `updatedInput`. Its sibling gates expand the marker themselves, because hooks on one matcher see only the original input (`engine/src/handlers/pre-tool-use/implementation-brief-marker.ts`).
- **Stop checks.** At SubagentStop, `handlers/subagent-stop/stop-checks.ts` runs the Acceptance Stop Check and then the Affected-Test Stop Check from one planner (`planStopChecks`). The Task Mutation Check runs nothing at the stop: it reads the record `helper mutation-check` left ([ADR-0071](adr/ADR-0071-the-task-mutation-check-names-surviving-mutants-before-the-stop.md)). What each check does is in [operations](verification.md#acceptance-stop-check-claimants).

### Pi

`pi/extension.ts` is the Pi registration shell. It maps Pi's `tool_call`, `tool_result`, Agent lifecycle and resource discovery events to the same core decisions, and owns the per-process session state those handlers share. Because a Pi subagent is a separate process, the adapter adds three things Claude Code does not need: one-time write grants for children, a binding from Pi's native batch-item identity to the engine's request identity, and a recorder that writes a child's tool calls into the parent's evidence ledger. Interactive phase Agents run as RPC children whose dialogs are relayed to the parent TUI.

The module inventory and the contributor checklist are in [Pi adapter](pi-adapter.md); installation and operation are in [Using Loom with Pi](pi-usage.md).

## Layer 3: handler shell and parsing boundaries

`engine/src/handlers/` turns untrusted harness payloads and CLI arguments into calls to the core. Handler families mirror harness lifecycle events; `handlers/helpers/` exposes explicit operator/program operations.

Important parser boundaries include:

- `runtime-compatibility.ts` — binds fresh Pi-launched CLI mutators to the exact extension/engine bytes loaded in memory;
- `state-manager.ts` — parses the complete protected TaskGraph before use;
- `parsers/parse-phase-artifacts.ts` — derives phase artifacts from completed Agent output;
- `core/parse-plan-models.ts` — parses exact lifecycle, pipeline, invariant (including ownership), and contract declarations;
- `core/acceptance-contract/wire.ts` — parses persisted Acceptance Contracts and their freeze, and the gate expectation and per-check report facts a suite result or receipt records (`core/completion-suite.ts` parses the observation envelope around them);
- `core/structured-test-report.ts` — projects a strict JUnit report into testcases for acceptance judgment;
- `core/review-output.ts` and `core/findings.ts` — parse, identify, reconcile, and classify review Findings;
- `core/review-packet.ts` — parses immutable code-review scope packets;
- `core/panel-contract.ts` / `core/review-panel.ts` — validate architecture and refutation verdicts;
- `core/orchestration-contract/` — parses request identity, exact rosters, artifact references, external actions, effects, and receipts.

The project follows “parse, do not cast”: untrusted JSON, transcripts, paths, and persisted checkpoints do not become domain values until a parser has reconstructed their invariants.

## Layer 4: deterministic domain cores

`engine/src/core/` contains harness-neutral policy and reducers. Major bounded areas are:

| Area | Primary source | Responsibility |
|---|---|---|
| Spawn validation | `validate-phase-order.ts`, `validate-task-execution.ts`, `validate-template-substitution.ts` | Enforce lifecycle and prompt prerequisites |
| Protected Bash policy | `guard-state-file.ts` (state-file policy; pure — the guarded directories arrive as a `GuardedLocations` value from `guarded-locations.ts`, which the hook shell and the Pi extension resolve from `config.ts` per decision), `subagent-authority.ts` (a subagent's audit and orchestration authority writes; defence in depth, never the proof; see [the subagent authority guard](security-audit.md#the-subagent-authority-guard)), over one pure shell grammar: `shell-command-head.ts`, `shell-heredoc.ts`, `shell-match-views.ts`, `shell-normalize.ts`, `shell-ansi-c.ts`, `shell-substitution.ts` | Detect guarded-path writes through shell syntax and fail closed |
| Completion evidence | `proof-obligations.ts`, `wave-gate-model.ts` | Derive whether a Task earned `implemented` |
| Operator reopening | `task-revalidation.ts` (the active-Wave transition Contract Revision and Task Reopening share), `task-reopening.ts` (`helper orchestration reopen-task`: preconditions, audit, idempotent replay) | Make settled Tasks dispatchable again without discarding evidence |
| Finding lifecycle | `findings.ts`, `review-output.ts`, `review-packet.ts` | Stable identity, generations, packet-bound remediation verification |
| Architecture panel | `panel-kernel.ts`, `panel-contract.ts`, `panel-program.ts` | Lenses, exact candidates/criteria, verdict validation, ranking, retries |
| Refutation panel | `panel-kernel.ts`, `review-panel.ts`, `panel-program.ts` | Exact critical set, verifier lenses, majority tally, retained audit |
| Standalone review | `standalone-review.ts`, the one owner of source, disposition and successor preparation, issued admission, roster aggregation and the review reducer; `standalone-successor-reviewer.ts` is a named entry surface into it | Frozen scope/roster, successor admission, aggregation, current refutation work, authoritative result |
| Standalone lineage | `standalone-lineage-contract.ts` (the wire contract below the aggregate), `standalone-disposition-machine.ts` (advisory publication without Agents) | Original identity and history, explicit policy and source joins, complete current assessment |
| Plan design review | `plan-design-review.ts` | The kind and its roster, the State File record, the gate decision |
| Wave Gate | `wave-gate-machine.ts` (the reducer, readiness snapshot, next-action proof and the completion commit, which stamps the Acceptance Freeze from the archived suite receipt), `wave-gate-checks.ts`, `wave-completion-suite-readiness.ts`, `wave-gate-preparation.ts`, `wave-gate-registration.ts`, `wave-status-facts.ts`, `loom-status.ts` (canonical status read model), `task-implementation-dispatch.ts` | Review/refutation/advisory/completion lifecycle and canonical status |
| Acceptance Contracts | `acceptance-contract/` behind one curated `index.ts`: `model.ts`, `tasks.ts` (writer rule, claimants, red window, population), `binding.ts`, `gate.ts` (expectation, attribution, red/green judgment), `freeze.ts`, `wire.ts`; `contract-revision.ts` | Contracts before code: frozen acceptance tests observed red, then green by Requirement |
| Owner verification | `owner-verification/` (pure), with `obligations.ts` as the one owner of which obligations a Wave or Task owes; `core/family-sites.ts` beside it | Sibling coverage, deterministic mutation plans, report-only outcome classification, per-Invariant verdicts, the reviewer owner map |
| Remediation | `remediation-machine.ts` | Scope authority, excluded evidence paths, audit/stage/install lifecycle |
| Model policy | `model-profiles.ts` (profile and Agent Catalog, resolution, issuance eligibility), `agent-catalog-projections.ts`, `pi-spawn-input.ts`, `model-calibration.ts` | Explicit cross-harness bindings, catalog-derived dispatch sets, deterministic calibration scoring |
| Compatibility | `legacy-archive.ts` | Read-only parsers for historical artifacts; never new domain behavior |

### Algebraic state machines

The Wave Gate, standalone review, refutation/architecture panels, and remediation are represented as closed state/event unions. Terminal and illegal transitions are explicit. Examples:

- Wave Gate: `preparing → awaiting-review-results → awaiting-refutation? → awaiting-advisory-decision? → ready-to-complete → done`.
- A malformed semantic result gets one retry; an attempt-2 semantic rejection reaches a typed terminal block.
- Infrastructure-effect failures preserve the predecessor and expected effect so a receipt can reconcile the operation without replaying semantic work.
- Complete rosters are parser-produced values; aggregation cannot accept a partial roster. A slot's identity binds its lens or criterion, so caller prose cannot swap it.

The public action algebra is deliberately small:

- `spawn-batch` — execute exact engine-issued Agent requests;
- `await-user` — obtain one explicit decision;
- `blocked` — stop with typed diagnostics;
- `done` — report an authoritative completion receipt.

The parent does not build event arrays, retry policy, reviewer lists, model lookups, or result JSON.

## Layer 5: orchestration shell

`engine/src/orchestration/` is the imperative shell around the reducers.

### One façade

`engine/src/handlers/helpers/orchestration.ts` (`helper orchestration <operation>`) is the parent-facing interface:

```text
status                  # canonical status; read-only
brief                   # engine-rendered implementation brief and spawn invocation; read-only
inspect                 # one run's program, state, captures and event tail; read-only
start <architecture|refutation|standalone-review|standalone-disposition|wave-gate|remediation|security-verification>
resume
restart                 # exhausted Wave reviewer run only
recover-orphan          # a Wave Gate whose Run Directory is missing
abandon                 # retire a run; deletes nothing
submit                  # compatibility/manual capture path
correlate               # harness-native id → request authority
complete                # compatibility for old panel callers
decide                  # user decision
remediate               # retire a terminal implementation escalation
attest                  # arm implementation re-attestation
reopen-task             # return implemented Tasks of the active Wave to pending
```

The registered programs are driven by `handlers/helpers/programs/`. The façade materializes Context Packets and complete request authorities for Agent work; advisory publication has no Agents. Harness adapters capture results directly; the parent never rewrites transcripts. Flags and recovery use: [operations](operations.md#run-directory-operations).

### Program durability

Each program persists in its Run Directory (ADR-0029). Durable history is an append-only journal of dedup-keyed events (the record format and its parser in `orchestration/program-journal.ts`; `RunDirHandle` owns the append, read and checkpoint operations). A checkpoint is only a projection beside it.

Panels persist in one of two forms:

- **Registered panels**, including every architecture panel, append `spawn-outcome` and `engine-outcome` events and rebuild by replaying them on resume (ADR-0030).
- **Refutation panels** inside a review persist as a checkpoint whose event prefix must replay exactly to its recorded state, and that state is re-proved on every read. The persistent panel program in `core/persistent-panel` is this panel's alone.

Because an append is idempotent on its dedup key, a crash between publishing an artifact and journalling its event resumes by republishing the same bytes and journalling the event once.

Each program's drive function is plain shell code over this journal and the pure reducers (ADR-0005). There is no workflow runtime or DSL; each domain retains its own state/event algebra.

### Effects and idempotency

Reducers emit typed effect intents. `orchestration/effect-runner.ts` executes them and records receipts. On resume, an already-receipted effect is reconciled, not run again. This separates “the domain authorizes this effect” from “the shell performed it.”

Each effect reaches only the adapter it needs: run-artifact publication through the anchored `RunDirHandle`, the protected-state commit through `StateManager`, and Git-index operations through `git-remediation`. Pure validation and routing code receives none of them.

## Two persistence domains

### Protected TaskGraph

The active feature lifecycle lives in the State File:

- Claude Code: `.claude/state/active_task_graph.json`
- Pi: `.pi/state/active_task_graph.json`

It is orchestration authority: an Agent that could edit it could forge phase completion, tests, Findings or Wave advancement. Protection has four layers:

1. mode `0444` at rest;
2. a deny-by-default Bash guard over state, evidence, binding and machine paths;
3. the `StateManager` lock plus temporary-file/rename writes;
4. narrow hook and helper ownership of mutations.

`StateManager` is the only general writer. The graph contains phase artifacts, skipped phases, Tasks/Waves, proof results, review generations/runs, Findings, Wave Gate records, Acceptance Contracts with their freeze and revisions, and GitHub tracking metadata.

**The Bash guard.** Bash can reassemble the same path through quotes, ANSI-C strings, parameter expansion, brace and glob forms, substitutions, wrappers and heredocs. `core/guard-state-file.ts` evaluates reveal-monotonic views of the command and recursively judges live substitutions and script-bearing heredoc bodies. It distinguishes data from executable stdin: prose in a quoted heredoc is not treated as a command unless the heredoc feeds an interpreter or evaluator. Common wrappers and fused spellings are normalized before judgment. Unparseable or unbounded forms fail closed.

**Runtime Revision (Pi).** The extension hashes `engine/src/`, `pi/`, and runtime package metadata when it loads. Mutating CLI routes hash the checkout again before dynamic import, while `StateManager` repeats the check immediately before any chmod/lock/write. A missing or unequal Runtime Revision refuses the operation with a `/reload`/restart diagnostic. Status remains available during skew. This prevents a fresh CLI writer from emitting state that the stale in-memory extension cannot parse.

**Shape at initialization.** `cli.ts init-state` writes the State File before the first phase. Nobody authors it by hand.

| Field | At `init-state` | Later |
|---|---|---|
| `current_phase` | `init`, or the first phase the skip flags leave | Advanced by `advance-phase`; `populate-task-graph` moves `decompose` to `execute` |
| `phase_artifacts` | `{}` | One entry per completed phase |
| `skipped_phases` | From the skip flags: `--skip-specify` adds `brainstorm`, `specify`, `clarify`; `--skip-plan-alignment` adds `plan-alignment` | Unchanged |
| `plan_design_review` | `{"status":"required"}`, or `{"status":"not-required","reason":"skipped"}` with `--skip-plan-design-review` (a gate, so `skipped_phases` is unchanged) | Set to `accepted`, bound to the plan's bytes, only by `accept-plan-design-review` |
| `spec_dir` | `.claude/specs/<date-slug>` | Unchanged |
| `spec_file`, `plan_file` | `null` (`spec_file` is set at once with `--skip-specify`) | Recorded when the phase artifact appears |
| `tasks`, `wave_gates` | `[]`, `{}` | Installed by `populate-task-graph` with `github_issue`, `current_wave` and `executing_tasks` |

Task status moves `pending` → `implemented` (the exact attempt satisfies proof and the Task-local suite) → `completed` (its Wave Gate passed). A Task stays `pending` through an infrastructure block, through a failed attempt 1 (one attempt-2 retry is issued) and through a failed attempt 2 (status then publishes a terminal escalation; there is no attempt 3).

### Immutable Run Directories

Review/panel/remediation evidence lives in fresh direct-child Run Directories. `orchestration/run-directory-handle.ts` anchors every access and exposes no arbitrary-path write API.

Canonical layout:

```text
run.<id>/
├── authority.json
├── abandoned.json    # present only once an operator retires the run
├── program.json
├── checkpoint.json
├── events/
├── requests/
│   └── correlators/
├── contexts/       # packet files: section identity only
├── blobs/          # section bytes, one file per section digest
├── transcripts/
├── receipts/
└── artifacts/
```

Authority, abandonment, request, context, section-blob, transcript, event, and receipt slots are immutable/exclusive. A symlink swap, a traversal component, a duplicate publication or a mismatched run identity fails closed, which protects evidence from both path bugs and prompt-chosen output paths.

Context Packet digests cover section identity (label, length, digest), not an inline byte encoding, so a packet file lists its sections and their bytes live once in `blobs/<section-digest>`. A frozen Wave source shared by a Task's reviewers and their retries is one blob, not a JSON byte array copied into every packet (a 34 MB Wave Gate run stores 1.9 MB). Every read restores section bytes through one resolver and re-hashes each section; packet files written before blob storage carry inline bytes and remain readable. The handle verifies the direct-child relation, rejects unsafe identity/path shapes, and reopens path components with no-follow filesystem operations. Checkpoints are projections; append-only events and immutable evidence remain the audit history.

A Run Directory is never deleted, so `abandoned.json` is how a retired run says so: it records the operator's terminal decision and, optionally, the run that replaced it. It is written once and never removes anything. Afterwards `helper orchestration inspect` still reads the run's evidence, but every operation that would advance the run refuses it, and no recovery can adopt it as a pristine replacement. It is deliberately not a program event: the event log is folded by each program's machine on every replay, and this is metadata about the run, not a transition within it.

## Request and evidence authority

Every engine-issued semantic request binds:

- Run and request identity;
- exact roster slot and attempt;
- program and Agent role;
- semantic model profile plus both harness bindings;
- required Skill;
- immutable Context Packet digest;
- fixed transcript output slot.

A result is accepted only against that authority. The harness-native correlator is recorded separately so transport identity cannot silently replace domain identity.

Context Packets split fixed and variable byte sections, hash the complete content, and are published before the spawn action. This avoids repeatedly asking a parent model to reconstruct scope and protocol prose.

### Evidence ledger

The evidence ledger (`<session>.evidence.jsonl`) holds facts stamped with an agent epoch; judgments such as trusted, passed or red-then-green are computed from those facts when they are read. Both harnesses mint facts through one rule:

```text
Claude PostToolUse/PostToolUseFailure payload ─ claudeToolCall ─┐
                                                                ├─ HarnessToolCall ─ recordToolEvidence ─ extractEvidence (pure) ─ ledger append
Pi child tool_result event ─ piToolCall ────────────────────────┘
```

The fact kinds, the minting rules, the trust judgment, attribution and the ledger's known limits are described once, in [Guarded Skill Machines](../machines/README.md#the-evidence-ledger). The decision is [ADR-0027](adr/ADR-0027-pi-ledger-capture-through-one-shared-minting-rule.md).

## Review authority model

A review Finding is identified by Agent plus emission ordinal, never by model-supplied id. A Task implementation write increments its Review Generation. A Review Packet binds that generation to exact base/head revisions, exact path scope, diffs, postimage bytes, plan context, and proof obligations. Artifacts are files: a scoped directory is reviewed through its Git-visible leaves at either revision (deleted leaves included, ignored files excluded, symlinks by target), and every scoped path must cover at least one artifact.

The protected graph records an engine-issued packet registration atomically with Review Run creation. A packet's self-hashes prove integrity; the registration proves issuance. A caller-authored file with recomputed hashes is not authority.

A Review Run freezes:

- packet identity;
- exact reviewer roster;
- ordered active Finding ids;
- generation and repository revisions.

A Wave Task's roster is derived, never configured: `waveTaskReviewRoster` (`core/wave-review-authority.ts`) answers the base five, or the six with `architecture-tech-lead` appended last when the Task's review carries the architecture lens. `ArchitectureLensReasons` (`core/agent-catalog-projections.ts`) is the closed record of why: the Task's packets carry the owner map (ADR-0047), or the Task writes an Acceptance Contract's types file (ADR-0069). Each reason is also a fixed, digest-bound packet section rendered from the same derivation, so a section and the roster cannot disagree: `owner-map` for code-reviewer and architecture-tech-lead, `contract-surface` (`core/contract-surface-section.ts`) for type-design-analyzer and architecture-tech-lead. Both are schema-2 only and leave every other packet byte-identical. The derivation reads one persisted value: a Review Run already installed with the roster the Task has without the contract-surface reason keeps it.

Every expected reviewer must assess every prior Finding exactly once before finalization. A `still_present` assessment keeps it active. A Finding becomes **resolved** only when the complete roster verifies remediation. A Finding becomes **refuted** only through adjudication (or an audited manual override); refutation is not resolution. Finalization is atomic: old Findings resolve and new Findings activate together, or neither change occurs. The user-facing rules are in [Workflows](workflows.md#wave-gate).

### Plan design review

The architecture plan is design-reviewed before decompose ([ADR-0070](adr/ADR-0070-the-plan-design-review-gates-decompose.md)). The review is a Standalone Review of kind `plan-design`; no program, phase or reviewer protocol was added. `core/plan-design-review.ts` owns every rule: the kind and its fixed roster, the State File record (`not-required | required | accepted{planSha256, runId, resultDigest}`), the gate decision, the judgement of a completed review, and the lens text. These consume it:

- `core/standalone-review-scope.ts` holds the one per-kind review profile (`standaloneReviewProfile`): the fixed roster, the one-file scope, the whole-document read obligation, the lens and the successor ban. Reviewer selection, registration, successor ingress and `programs/standalone-requests.ts` (the read obligation and the `plan-design-lens` packet section) read the kind's policy there, not from their own string compares.
- `handlers/helpers/accept-plan-design-review.ts` takes the evidence from the programs volume (`readPlanDesignEvidence`, which reads the Run Directory in one authenticated walk and parses every value into its branded or closed type), hands it to the pure `judgePlanDesignEvidence`, and makes the one locked State File write, re-hashing the plan under the lock. It reads the plan through the `ArtifactProbe` port, whose filesystem adapter is `orchestration/artifact-probe.ts`.
- `core/validate-phase-order.ts` asks the gate on a decompose spawn, with the plan's digest from the `ArtifactProbe.sha256` port, resolving the plan once for the plan-alignment and design gates.
- `handlers/helpers/populate-task-graph.ts` asks the same gate (`populationPlanDesignRequirement`) on first population, with the digest of the plan bytes it read once for the binding check, before the lock and under it.

The coupling runs one way. The gate reads a digest from the State File and never opens a Run Directory; the Run never reads the State File.

### Standalone lineage

A standalone review reuses per-role Finding ordinals, so two independent reviews cannot share identity by id or similarity. Lineage makes the join explicit ([ADR-0010](adr/ADR-0010-standalone-finding-lineage.md)):

- **Advisory publication.** The `standalone-disposition` program records the parent's complete ordered accepted, deferred and dismissed decisions immediately, without Agents. The policy is declared, not observed; a correction names the exact earlier publication.
- **Successor review.** An explicitly selected successor joins one exact predecessor result and policy revision, keeps its scope and roles, freezes source bytes, modes and absence, and conserves every original Finding with its id, assertion, severity, evidence and votes. Every current reviewer assesses every origin. Only new criticals and an evidence-bound reopening reach a fresh Refutation Panel; an unchanged upheld blocker stays active without re-adjudication.
- **One reducer.** The existing standalone review reducer admits the successor's assessments; there is no second lifecycle. A current origin binds its Run, request, transcript and ordinal and takes its result identity from the enclosing publication, which avoids a self-digest cycle.

In the shell, three lower modules hold what the per-program drivers share, so the drivers never import each other: `program-result.ts` (the result vocabulary and the closed `FacadeAction` union every driver emits), `standalone-evidence.ts` (checkpoint-independent evidence, source observation and refutation replay) and `standalone-disposition-source.ts` (authentication of published advisory revisions). The drivers stay per program (ADR-0005), and the façade exports parent operations, not every internal parser (ADR-0007).

Lineage adds no automatic predecessor, branch join, similarity merge, severity override or review reuse, and a digest or a formally phrased claim is not semantic proof. Inputs, limits and commands: [operations](standalone-review.md#standalone-lineage).

## Owner verification in the completion suite

A plan may declare that an Invariant is owned by one function, with the sibling entry points that must go through it. Those declarations become Wave Gate obligations through the existing Wave completion suite, not a new gate stage:

```text
plan ─parsePlanModels─► obligationsFromInvariants (ownerObligationOf) ─► owner_obligations (stamped at population, [] included)
Wave Gate ─ ensureWaveCompletionSuite ─ authorizeGraphCompletionSuite(graph, workspaceDigest)   (readiness calls the same)
  ownerCheckAuthorityOf(waveOwnerDuty(graph, wave)) ── null (no stamp: older graph) ──► suite roster and digest unchanged
        │ non-null
        ▼
  authorizeWaveCompletionSuite(…, authority) ─► loom:owner-verification { obligationsDigest, owed }
  re-read plan_file ─► planModelsIntegrityFailure (stampAgreement) ─► blocked on unreadable / malformed / drifted plan
  owed = [] ─► verified, no verdicts
  owed ≠ [] ─► runOwnerVerification (shell, outside the StateManager lock)
                 coverage: siblingCoverage walks the import graph over duePaths(tasks, wave), reading through readRepositoryText
                 mutation: Wave base ─► changedHeadLines ─► mutationPlan ─► detached worktree:
                           baseline, then each mutant via the frozen affectedRunner ─► classify*
                 invariantVerdict per owed obligation; real-workspace digest before = after
  result.ownerVerification ─► evaluateWaveCompletionSuite ─► receipt or rejection
```

- **One selection owner.** `core/owner-verification/obligations.ts` decides which obligations a Wave owes, the family schedule, which Tasks touch an owned family, and which obligations owe mutation. Callers never filter the raw stamp; they ask `waveOwnerDuty` or `taskOwnerDuty`, and each answers an absent stamp with its own variant, so "absent" and "empty" are never confused. Every caller is a row in `engine/tests/core/owner-obligations.matrix.test.ts` ([ADR-0032](adr/ADR-0032-owner-obligations-stamped-at-population-gate-fails-closed-on-drift.md), [ADR-0034](adr/ADR-0034-family-scope-keeps-changesfamily-selection-has-one-owner.md), [ADR-0063](adr/ADR-0063-owner-verification-follows-the-family-schedule.md)).
- **Pure core, effects in three modules.** Coverage, the mutation plan, outcome classification, the verdict and the plan-integrity check are pure functions in `core/owner-verification/`. `orchestration/owner-verification-runner.ts` sequences coverage and mutation; `orchestration/mutation-run-steps.ts` holds the repository file read, Git base resolution and runner execution, shared with the Task mutation check's runner so the two cannot drift; the isolated worktree lives in `orchestration/owner-mutation-workspace.ts`. The command is always the frozen `affectedRunner`'s, with the matrix test as its only file; no command text comes from the plan ([ADR-0035](adr/ADR-0035-sibling-coverage-is-direct-imports-closed-under-re-exports.md), [ADR-0036](adr/ADR-0036-deterministic-mutation-plan-over-changed-owner-lines.md), [ADR-0038](adr/ADR-0038-isolation-via-one-detached-worktree-per-invariant.md)).
- **Fail closed.** The runner never throws: an unreadable file, a missing report, an unparseable owner, a missing Wave base and a changed real workspace are each a named infrastructure result, never a kill and never a pass ([ADR-0037](adr/ADR-0037-outcome-classification-reads-only-the-structured-report.md)).
- **Receipt semantics unchanged.** The check is part of the suite digest, so receipt reuse, workspace binding, replay and status come from the existing suite ([ADR-0031](adr/ADR-0031-owner-verification-is-an-engine-reserved-completion-suite-check.md)).
- **Review and brief.** A Task that touches an owned family gets the `owner-map` packet section and the sixth reviewer ([ADR-0039](adr/ADR-0039-the-second-copy-lens-is-an-engine-issued-packet-section.md), [ADR-0047](adr/ADR-0047-the-wave-review-roster-is-derived-per-task-from-owner-map-presence.md)), and its implementation brief states its coverage and mutation duty ([ADR-0040](adr/ADR-0040-brief-duties-and-status-projection.md)). A standalone review builds no Wave packet, so it never carries an owner map.

Operator detail, status fields and remedies: [operations](verification.md#owner-verification-blocks-a-wave-gate). Plan grammar: `references/executable-models.md`. Mechanics and limits: [Executable models: enforcement](executable-models-enforcement.md).

## Security and failure posture

Loom’s default is refusal when authority is incomplete or ambiguous:

- guarded spawn routes fail closed on handler crashes;
- Pi runtime/CLI version skew is rejected before Run Directory or TaskGraph mutation;
- state and evidence paths are denied to arbitrary Bash writers;
- decisions that probe a path through `utils/path-presence.ts` treat it as absent only on ENOENT: "present but unreadable" is its own answer, so an unreadable routing config, rule, run marker or agent definition refuses instead of reading as missing (`helper family-sites` counts the raw `existsSync` checks that remain; see [operations](development.md#measuring-second-sites-the-family-site-metric));
- a test command counts as evidence only at a real top-level position: a runner inside `$(…)`/`<(…)` never owns the line's exit or output;
- Run Directory paths must be direct children and are accessed no-follow;
- model and Skill bindings are explicit;
- exact rosters reject missing, duplicate, foreign, and surplus results;
- publication is batch-atomic where partial visibility would alter authority;
- remediation excludes state/review evidence and installs only an audited temporary index;
- legacy formats are isolated in a read-only archive, not expanded in canonical parsers.

## Dependency direction

The intended dependency direction is:

```text
core domain values/reducers
        ↑
handlers and orchestration shell
        ↑
harness adapters and command runbooks
```

`engine/src/core/` must not depend on Pi or Claude APIs. Every non-test file under `engine/src/core`, `machine`, `linter` and `parsers` is held to `no-io-in-pure-modules` unless the project config declares it a shell with the I/O it does, and `machine-purity.test.ts` proves the whole declared core's import closure stays pure. `core/` never imports `config.ts`: env-derived facts (protected directories, the task graph's presence) are resolved by the shells and passed in as domain values. Non-empty lists are proven, never asserted: `nonEmptyOf(head, ...tail)` and `nonEmpty(values)` (a `NonEmpty<T> | null` narrowing, so the empty case is an explicit branch) in `core/orchestration-contract/identity.ts` replace every `as NonEmpty` cast. The anchored no-follow filesystem primitives live in `utils/no-follow-fs.ts`, the lowest shell layer, so the machine shell, the protected state writer, the CLI and the orchestration adapters all import them inward. `no-cross-boundary-imports` governs every `engine/src` directory and top-level file (`requireGovernance`): a file no boundary names is a violation, so a new module states its dependency direction before it can hold code.

## Guarantees and honest limits

Loom uses models for judgment and code for authority. A model may design, implement, review, or argue that a Finding is wrong. It may not decide whether an exact roster is complete, whether evidence belongs to a request, whether a Wave may advance, or which files enter a commit. Prompt-only coordination drifts in predictable ways; each row below is one of them and the mechanism that replaced it.

| Concern | Prompt-only failure | Deterministic authority |
|---|---|---|
| Task completion | Agent says “done” | Engine-derived proof obligations |
| Tests | Transcript text looks green | Provenance-preserving ledger/structured evidence |
| Review rerun | Old blocker omitted | Generation + packet + exact prior-id assessments |
| Panel | Caller swaps or skips verdicts | Exact slots and complete-roster parser |
| Retry | Parent improvises | Typed attempt-1/attempt-2 lifecycle |
| Workflow order | Markdown sequence | Reducer state/event algebra |
| Transcript persistence | Parent copies output | Harness captures exact bytes into fixed slots |
| State writes | Agent edits JSON | Guard + StateManager + typed commit effect |
| Run artifacts | Prompt chooses paths | Anchored fixed-layout RunDirHandle |
| Git staging | Broad `git add` | Audited temporary index and witness recheck |
| Security coverage | “We looked at everything” | Enumerated cells, settled ledger, refusals on publish |
| Invariant | Reviewer remembers | Checkable lint rule or honest advisory prose |
| Generated pipeline | Hand-wired drift | Fugue stamp + Loom integrity verification |

The last two rows are the executable-models policy: a model in a plan either executes or it does not exist. A lifecycle is an imported reducer, a pipeline is generated code with an integrity stamp, and an invariant is either a lint rule loaded fail-closed or prose that says it is advisory ([Executable models: enforcement](executable-models-enforcement.md)).

### Honest limits

Determinism is scoped to what Loom can observe and own:

- semantic design/review correctness still depends on models and user judgment;
- a tool call with no `agent_id` cannot be attributed in a contended session, so it is neither recorded nor gated; Pi children run without the live phase gate, because Pi cannot name a tool call’s caller;
- a legacy graph, whose Agents named no Task, may still attribute a result to the one executing Task (`inferSoleExecutingTask`), or on Pi to the first Task id in the parent's spawn prompt; such a guess settles only through the untrusted legacy resolution, which stores its evidence but leaves the Task pending for revalidation and reports the attribution as unproven, and it can never complete a Task, because completion requires engine-minted attempt authority;
- report artifacts remain in an Agent-writable environment, with documented same-call forgery residuals; likewise a security sandbox receipt's nonce binds it to its artifact path but does not authenticate it against a hunter that writes the artifact itself, and a security ballot is bound to its issued verifier spawn, but against a subagent that evades the shell-string guard (on either harness) a verification run's capture file stays writable (no capture attestation backs it, so neither harness imports or counts such a slot; see [Running a security audit](./security-audit.md#honest-limits));
- the shell guard judges command text, not an abstract Bash execution graph;
- Pi's Interactive Phase Transport supports standard relayed dialogs but not `ctx.ui.custom()` components inside RPC children;
- legacy readers remain for historical evidence but are frozen in `core/legacy-archive.ts`.

These are documented boundaries, not silent claims of enforcement. The evidence ledger's own limits, including what red-then-green does not prove, are in [Guarded Skill Machines](../machines/README.md#known-residual-limits).

## Where to continue

- User-visible lifecycle: [Workflows](workflows.md)
- Persistence and recovery: [Operations](operations.md)
- Pi: [Using Loom with Pi](pi-usage.md) and [Pi adapter](pi-adapter.md)
- Architectural rationale: [ADR-0004](adr/ADR-0004-engine-owned-orchestration-automation.md) and the [ADR index](adr/README.md)
