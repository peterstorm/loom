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

- `commands/` — slash-command runbooks. `/loom`, `/wave-gate`, `/review-pr`, and `/review-and-fix` are the principal operational surfaces.
- `commands/templates/` — parameterized prompts for sequential phases, implementation Tasks, architecture-panel roles, and refutation verification.
- `agents/` — 28 Loom-owned Agent definitions with explicit semantic model profiles and, where needed, preloaded Skills.
- `skills/` — reusable architecture, implementation, testing, security, frontend, lint, review/remediation, deepening, and domain-language knowledge.
- `rules/` — architecture and language guidance supplied to implementation/review Agents.
- `references/` — plan/spec/ADR templates plus design and refutation lens catalogs.
- `lint-rules/` and `machines/` — executable policy rather than prompt guidance.

These resources are shared source. Claude Code consumes them from the plugin. Pi renders commands, skills, references, and rules into a content-addressed cache and renders Agent definitions into the user Agent directory.

## Layer 2: harness adapters

### Claude Code

`hooks/hooks.json` binds Claude Code lifecycle events to small shell shims under `hooks/scripts/`. Every shim delegates to:

```bash
bun engine/src/cli.ts <hook-type> <handler> [arguments]
```

`engine/src/handler-routes.ts` is the closed routing table. Spawn and state guards are marked fail-closed so a top-level import or stdin failure exits with blocking polarity rather than accidentally allowing a call.

Claude Code lifecycle coverage:

- **PreToolUse** — phase order, Wave/task order, prompt substitution, model/Skill policy, direct-edit policy, guarded machine tools, state-path Bash guard. An implementation brief marker (`LOOM_IMPLEMENTATION_BRIEF: T5`, optionally followed by `LOOM_OPERATOR_NOTE: <text>` lines that become the brief's Operator Note section) is expanded here: `validate-task-execution` renders the brief, runs every spawn veto and the reservation on it, and returns it as the call's `updatedInput`, so the parent sends only the marker. Its sibling gates expand the marker themselves, because hooks on one matcher see only the original input (`engine/src/handlers/pre-tool-use/implementation-brief-marker.ts`).
- **PostToolUse** — immediate lint, evidence recording, and orchestration-spawn correlation. Evidence recording (`handlers/post-tool-use/record-evidence.ts`) attributes the call to an agent epoch, normalizes the hook payload with `claudeToolCall`, and hands it to the shared minting shell (see [Evidence ledger: one minting rule](#evidence-ledger-one-minting-rule)).
- **PostToolUseFailure** (Bash) — evidence recording for a failed call. Claude Code fires PostToolUse only when a tool call succeeded; a Bash command that exits non-zero is a failed call, so a failing test run reaches the ledger only through this event.
- **SubagentStart** — active-Agent tracking and guarded-machine epoch binding.
- **SubagentStop** — the stop checks (the Acceptance Stop Check, then the Affected-Test Stop Check, run by `handlers/subagent-stop/stop-checks.ts` from the one planner `planStopChecks`), then phase advancement, implementation proof reconciliation (including the I6 red-then-green judgment over the agent's epoch), review/spec evidence capture, orchestration transcript capture, cleanup.
- **SessionStart** — stale binding cleanup and post-`/clear` context restoration.

### Pi

`pi/extension.ts` is the Pi registration shell: it maps Pi `tool_call`, `tool_result`, Agent lifecycle, and resource discovery events to the same core decisions, and owns the per-process session state those handlers share. Pi-specific concerns live in adapter modules beside it:

- deriving package identity from `import.meta.url` and capturing a content-addressed **Runtime Revision** published to child CLI processes (`pi/extension.ts`);
- preparing each spawn batch through one ordered pipeline — observe its governing task graph, expand implementation brief markers, then run the Spawn Admission core (`pi/spawn-preparation.ts`, `pi/implementation-brief-expansion.ts`, `pi/spawn-graph.ts`);
- reading and rewriting Pi tool-call payloads and deriving per-slot roster identities (`pi/tool-input.ts`);
- reserving an admitted batch's lifecycle — roster rows, pointer lease, request correlators, review and spec-check authorities, write grants, task execution — before Pi may dispatch it (`pi/spawn-lifecycle.ts`), recording every capability it takes in the batch's claims ledger, whose pure rollback plan, release executors over injected ports and remaining-debt derivation `pi/spawn-claims.ts` owns, while its production release ports and the parent-session release orchestrators settlement and shutdown share live in the thin shell `pi/spawn-claim-shell.ts`;
- rendering resources through `pi/resources.ts`, and resolving the Pi user agent directory the spawn definition port reads through the one pure rule the routing loader and the PreToolUse model guard share (`engine/src/core/pi-agent-directory.ts`);
- adapting Pi messages through `pi/transcript-adapter.ts`;
- settling finished subagent results: `pi/subagent-result-batch.ts` parses the harness batch, `pi/reserved-slot.ts` parses each slot's role claims into one role authority at the spawn producer (the reservation stores only that parsed slot), `pi/subagent-settlement.ts` holds the pure locked reducers, and `pi/subagent-result.ts` is the shell that observes evidence and runs them under the TaskGraph lock;
- minting and consuming scoped write grants through `pi/write-grant.ts`. Each grant also carries the parent's evidence ledger address (`evidenceLedger`: parent session and agent type);
- recording a child's tool calls into the parent's evidence ledger (`pi/evidence-recorder.ts`). The recorder registers before every other `tool_result` handler, normalizes the event with `piToolCall`, and calls the shared minting shell under the epoch of the child's grant. The pure `piEvidenceTarget` decides from the grant state alone whether the child may record. The parent reads a child's epoch back with `piChildEvidence` for I6 settlement and the report-only stop checks;
- correlating native Pi batch-item identities to engine-issued request identities, and the one issued-review-request authentication spawn admission and capture share (`pi/review-run-authority.ts`); witnessing captured standalone review transcripts in the per-factory Trusted Review Witness Aggregate (`pi/trusted-review-witness.ts`);
- capturing exact final result bytes into reserved Run Directory slots (`pi/review-capture.ts`);
- staging emission-enabled launches with the installed subagent launcher (`pi/emission-launch-bridge.ts`), whose readiness verifier runs the one launcher step sequence (`pi/emission-readiness-sequence.ts`) and is decided by the launcher's pure readiness and route gate (`pi/emission-readiness-gate.ts`), over the readiness protocol (command, entry type, report shape) both sides import from `pi/emission-readiness-protocol.ts`;
- holding each parent session's spawn reservations and cleanup debt (`pi/spawn-reservation.ts`), and settling a completed batch against its reservation through the SubagentStop dispatcher, its pure per-result routing (`pi/subagent-result-route.ts`) and its per-concern appliers (`pi/subagent-stop.ts`, `pi/subagent-result.ts`, `pi/reserved-results.ts`);
- activating a child's write grant and keeping a rejected child's direct edits blocked (`pi/child-write-grant.ts`), and releasing every capability a session still holds at shutdown — its child binding included, as a claims ledger of its own (`pi/session-shutdown.ts`);
- holding an emission-enabled child behind its launcher readiness barrier (`pi/emission-readiness.ts`, over the pure child surface in `pi/emission-tool.ts`);
- running interactive phase Agents as RPC children and relaying their standard dialogs to the parent TUI.

The legacy `pi/loom-bridge.ts` bridge was removed; `pi/extension.ts` is the only Pi state adapter, and the Pi package manifest pins the bridge's absence.

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
| Protected Bash policy | `guard-state-file.ts`, `shell-normalize.ts`, `shell-ansi-c.ts`, `shell-substitution.ts` (the one substitution-span scanner, shared with test-run classification in `machine/extract-evidence.ts`) | Detect guarded-path writes through shell syntax and fail closed |
| Completion evidence | `proof-obligations.ts`, `wave-gate-model.ts` | Derive whether a Task earned `implemented` |
| Finding lifecycle | `findings.ts`, `review-output.ts`, `review-packet.ts` | Stable identity, generations, packet-bound remediation verification |
| Architecture panel | `panel-kernel.ts`, `panel-contract.ts`, `panel-program.ts` | Lenses, exact candidates/criteria, verdict validation, ranking, retries |
| Refutation panel | `panel-kernel.ts`, `review-panel.ts`, `panel-program.ts` | Exact critical set, verifier lenses, majority tally, retained audit |
| Standalone review | `standalone-review.ts` — the cohesive aggregate owner: source/disposition/successor preparation, issued admission, roster aggregation, the LC-2 reducer and its private publication/lineage custody share one owner, and callers import the reducer and lineage preparation from it directly. `standalone-successor-reviewer.ts` is the one remaining consumed named entry surface into that owner, not an independent implementation | Frozen scope/roster, successor admission, aggregation, current refutation work, authoritative result |
| Standalone lineage (P5) | `standalone-lineage-contract.ts` (wire contract below the aggregate) plus the `standalone-review.ts` cohesive owner; `standalone-successor-reviewer.ts` is a consumed named entry surface | Original identity/history, explicit policy/source joins, complete current assessment and canonical projections |
| Advisory publication (P5) | `standalone-disposition-machine.ts` | No-agent immutable DECLARED publication and exact effect reconciliation |
| Wave Gate | `wave-gate-machine.ts` (LC-1 reducer, proof-carrying readiness snapshot, next-action proof, completion commit), `wave-gate-checks.ts` (gate evaluation), `wave-completion-suite-readiness.ts`, `wave-gate-preparation.ts` (refutation/advisory actions), `wave-gate-registration.ts` (admission, install with abandoned-run supersession, review-authority reset), `wave-status-facts.ts`, `loom-status.ts` (canonical status read model), `task-implementation-dispatch.ts` | Review/refutation/advisory/completion lifecycle and canonical status |
| Acceptance Contracts | `acceptance-contract/` behind one curated `index.ts`: `kernel.ts` (private result helpers), `model.ts` (shapes), `tasks.ts` (writer rule, claimants, red window, contract roles, population), `binding.ts` (plan-binding validation, with the transitive-dependency rule from `task-dependencies.ts`), `gate.ts` (Wave Gate expectation, attribution, RED/GREEN judgment, the recorded observation and its verdict), `freeze.ts` (Acceptance Freeze, drift), `wire.ts` (persisted parsers); `contract-revision.ts` (operator Contract Revision) | Contracts before code: frozen acceptance tests observed red, then green by Requirement |
| Owner verification (G5b) | `owner-verification/` (pure; INV-2 purity-linted; the directory is the full list): `types.ts` (CT-1 declarations) and `parse.ts` (their wire parsers); `obligations.ts` (the one owner of which Owner Obligations a Wave or Task owes, over the opaque `OwnerScope`); `suite-authority.ts` (`authorizeGraphCompletionSuite`, the one authorize-from-TaskGraph function the gate and readiness share); `plan-integrity.ts` (the gate's plan-against-stamp drift check); `owed-verification.ts` (the gate's owner-observation decision and the runner's per-obligation run plan, decided before anything runs); `import-graph.ts` and `mutation-plan.ts` (the only two modules allowed to import `typescript`, parsing already-read text); `coverage.ts`, `repo-path.ts` (the one repository-path rule coverage and `tsconfig-paths.ts` share) and `tsconfig-paths.ts` (the matrix test's `paths` aliases); `wave-base.ts` (which commit the owner is diffed against), `ls-tree.ts` (what `git ls-tree` says about the owner at that base) and `status-paths.ts` (the worktree overlay's path set from `git status`); `outcome.ts`, `verdict.ts`, `owner-map.ts`, `status.ts` (the one status projection both `helper orchestration status` renderers serialize); beside it, `core/family-sites.ts` (the family-site metric, not part of `owner-verification/`) | Sibling coverage, deterministic mutation plans, report-only outcome classification, per-Invariant verdicts, the reviewer owner map |
| Remediation | `remediation-machine.ts` | Scope authority, excluded evidence paths, audit/stage/install lifecycle |
| Model policy | `model-profiles.ts` (profile and Agent Catalog, resolution, issuance eligibility), `agent-catalog-projections.ts` (derived agent sets, phase map, producer kinds), `pi-spawn-input.ts` (Pi `subagent` input parse), `model-calibration.ts` | Explicit cross-harness bindings, catalog-derived dispatch sets, and deterministic calibration scoring |
| Compatibility | `legacy-archive.ts` | Read-only parsers for historical artifacts; never new domain behavior |

### Algebraic state machines

The Wave Gate, standalone review, refutation/architecture panels, and remediation are represented as closed state/event unions. Terminal and illegal transitions are explicit. Examples:

- Wave Gate: `preparing → awaiting-review-results → awaiting-refutation? → awaiting-advisory-decision? → ready-to-complete → done`.
- A malformed semantic result gets one retry; an attempt-2 semantic rejection reaches a typed terminal block.
- Infrastructure-effect failures preserve the predecessor and expected effect so a receipt can reconcile the operation without replaying semantic work.
- Complete rosters are parser-produced values; aggregation cannot accept a partial roster.

The public action algebra is deliberately small:

- `spawn-batch` — execute exact engine-issued Agent requests;
- `await-user` — obtain one explicit decision;
- `blocked` — stop with typed diagnostics;
- `done` — report an authoritative completion receipt.

## Layer 5: orchestration shell

`engine/src/orchestration/` is the imperative shell around the reducers.

### One façade

`engine/src/handlers/helpers/orchestration.ts` is the parent-facing interface:

```text
status
start <architecture|refutation|standalone-review|standalone-disposition|wave-gate|remediation>
restart                 # exhausted Wave reviewer run only
resume
submit                   # compatibility/manual capture path
correlate                # harness-native id → request authority
complete                 # compatibility for old panel callers
decide                   # user decision
```

Registered standalone-review, Wave Gate, remediation and P5 standalone-disposition
programs are driven by `handlers/helpers/programs/`. The façade materializes Context
Packets and complete request authorities for Agent work; disposition publication has
no Agents. Harness adapters capture results directly; the parent never rewrites transcripts.
P5 commands require a matching admitted runtime; see the [bootstrap restriction](operations.md#standalone-lineage-p5).

### Program durability

Each program persists in its Run Directory (ADR-0029). Durable history is an append-only journal of dedup-keyed events (the record format and its parser in `orchestration/program-journal.ts`; `RunDirHandle` owns the append, read and checkpoint operations). A checkpoint is only a projection beside it.

Panels persist in one of two forms:

- **Registered panels**, including every architecture panel, append `spawn-outcome` and `engine-outcome` events and rebuild by replaying them on resume (ADR-0030).
- **Refutation panels** inside a review persist as a checkpoint whose event prefix must replay exactly to its recorded state, and that state is re-proved on every read. The persistent panel program in `core/persistent-panel` is this panel's alone.

Because an append is idempotent on its dedup key, a crash between publishing an artifact and journalling its event resumes by republishing the same bytes and journalling the event once.

Each program's drive function is plain shell code over this journal and the pure reducers (ADR-0005). There is no workflow runtime or DSL; each domain retains its own state/event algebra.

### Effects and idempotency

Reducers emit typed effect intents. `orchestration/effect-runner.ts` executes them and records receipts. On resume, an already-receipted effect is reconciled rather than run again. This separates “the domain authorizes this effect” from “the shell performed it.”

## Two persistence domains

### Protected TaskGraph

The active feature lifecycle lives at:

- Claude Code: `.claude/state/active_task_graph.json`
- Pi: `.pi/state/active_task_graph.json`

`StateManager` is the only general writer. It uses a lock, temporary-file/rename publication, and mode `0444` at rest. Hooks and a narrow helper allowlist mediate changes. The graph contains phase artifacts, skipped phases, Tasks/Waves, proof results, review generations/runs, Findings, Wave Gate records, Acceptance Contracts with their freeze and revisions, and GitHub tracking metadata.

Under Pi, the extension hashes `engine/src/`, `pi/`, and runtime package metadata when it loads. Mutating CLI routes hash the checkout again before dynamic import, while `StateManager` repeats the check immediately before any chmod/lock/write. A missing or unequal Runtime Revision refuses the operation with a `/reload`/restart diagnostic. Status remains available during skew. This prevents a fresh CLI writer from emitting state that the stale in-memory extension cannot parse.

This graph is mutable protected state because a feature progresses over time.

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

Authority, abandonment, request, context, section-blob, transcript, event, and receipt slots are immutable/exclusive.

Context Packet digests cover section identity (label, length, digest), not an inline byte encoding, so a packet file lists its sections and their bytes live once in `blobs/<section-digest>`. A frozen Wave source shared by a Task's five reviewers and their retries is one blob rather than a JSON byte array copied into every packet (a 34 MB Wave Gate run stores 1.9 MB). Every read restores section bytes through one resolver and re-hashes each section; packet files written before blob storage carry inline bytes and remain readable. The handle verifies the direct-child relation, rejects unsafe identity/path shapes, and reopens path components with no-follow filesystem operations. Checkpoints are projections; append-only events and immutable evidence remain the audit history.

A Run Directory is never deleted, so `abandoned.json` is how a retired run says so: it records the operator's terminal decision and, optionally, the run that replaced it. It is written once and never removes anything. Afterwards `helper orchestration inspect` still reads the run's evidence, but every operation that would advance the run refuses it, and no recovery can adopt it as a pristine replacement. It is deliberately not a program event — the event log is folded by each program's machine on every replay, and this is metadata about the run rather than a transition within it.

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

### Evidence ledger: one minting rule

The evidence ledger (`<session>.evidence.jsonl`) holds facts only: `FileRead`, `FileWrite` and `TestRun`, each stamped with an agent epoch. Judgments such as trusted, passed or red-then-green are computed from those facts when they are read. Both harnesses mint facts through one rule (INV-4):

```text
Claude PostToolUse/PostToolUseFailure payload ─ claudeToolCall ─┐
                                                                ├─ HarnessToolCall ─ recordToolEvidence ─ extractEvidence (pure) ─ ledger append
Pi child tool_result event ─ piToolCall ────────────────────────┘
```

- **Pure parts.** `core/harness-tool-call.ts` holds the two pure adapters. They reduce each harness's event to one `HarnessToolCall`: the tool, its input, its outcome (failed, exit, stdout, interrupted), the call id and the cwd. Claude Code's current Bash payloads carry no exit field. A PostToolUse Bash success is exit 0, unless the harness reinterpreted a non-zero exit (`returnCodeInterpretation`, as for a `grep` that matched nothing) or the call ran in the background; an explicit exit field is honoured when present. A PostToolUseFailure `error` starts `Exit code N`, and a timeout or an interrupt is a kill. Pi uses `details.exitCode` when it is an integer, and otherwise reads `isError` as exit 1 or 0. `machine/extract-evidence.ts` turns that call into facts. Its rules cover command classification and exit ownership. The shell write targets it mints come from `core/shell-write-targets.ts`, the evidence twin of the guard's redirect scanner: redirects, `tee`, and the destinations of a literal `mv`, `git mv` or `cp`. A device stream (`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/<n>`) is never a target, so `cmd 2>/dev/null` mints no FileWrite (`isDeviceStreamPath`; absolute paths only, normalized lexically; other paths under `/dev` such as `/dev/shm` stay targets).
- **The shell.** `machine/tool-evidence-recorder.ts` is the only production caller of `extractEvidence` and of the ledger append. It does three things:
  - it runs report discovery, which applies the call-start freshness stamp and the agent-authored-artifact veto;
  - it resolves `FileWrite` paths against the call's cwd;
  - it appends to the target ledger under the target epoch.
- **Per-file results.** A `TestRun` report summary (`TestReportSummary`) always carries the per-file results its structured report lists, `unrecorded` for a pre-feature line. `parseReportSummary` is the only constructor of a summary (INV-8), and it reconciles those results with the counts. When a ledger record's per-file data is malformed, the whole report reads as untrusted. The strict byte parser behind completion checks and remediation yields `ReportCounts` instead, counts alone from `parseReportCounts`, so it can never stand as a TestRun report.
- **Targets.** Claude Code records into its own session ledger under the epoch that attribution resolves. A Pi child records into the parent session's ledger under `epochOf(grant agent id, agent type)`, the address its parent-issued grant carries. One child process is one agent, so attribution on Pi is exact by construction.

A matrix test feeds the same tool-call fixtures through both adapters and asserts identical records. Consumers read the ledger only through epoch folds:
- the SubagentStop test-result resolver;
- I6 settlement (`judgeRedThenGreen`, whose classification also names the implementation files the Task creates by its first `artifact_baseline`, `createdImplementationFiles`, so a test that cannot yet load a module the Task creates is red: FR-007a);
- the stop checks' changed files (`changedFilesAtStop`, INV-7);
- `helper stop-check-plan`.

## Review authority model

A review Finding is identified by Agent plus emission ordinal, never by model-supplied id. A Task implementation write increments its Review Generation. A Review Packet binds that generation to exact base/head revisions, exact path scope, diffs, postimage bytes, plan context, and proof obligations. Artifacts are files: a scoped directory is reviewed through its Git-visible leaves at either revision (deleted leaves included, ignored files excluded, symlinks by target), and every scoped path must cover at least one artifact.

A Review Run freezes:

- packet identity;
- exact reviewer roster;
- ordered active Finding ids;
- generation and repository revisions.

Every expected reviewer must assess every prior Finding exactly once before finalization. A `still_present` assessment keeps it active. A Finding becomes **resolved** only when the complete roster verifies remediation. A Finding becomes **refuted** only through adjudication (or an audited manual override); refutation is not resolution.

## Standalone lineage and publication (P5)

P4 merged/reloaded; P5 is feature-worktree implementation with final validation,
registered review and publication pending. [ADR-0010](adr/ADR-0010-standalone-finding-lineage.md)
records the selected design and [operations](operations.md#standalone-lineage-p5)
provides exact input, limits and the admitted-main bootstrap restriction.

The pure core separates prepared data, issued request membership, admitted evidence,
complete roster proof and published result authority, concentrated in the cohesive
`standalone-review.ts` aggregate owner. Self-hashes never substitute
for independent publication. Shell shared computation has three named lower owners:
`program-result.ts` owns the ProgramParse/FacadeDriveResult vocabulary and the closed
`FacadeAction` union every driver emits (type-only imports, never a driver or parser),
`standalone-evidence.ts` owns checkpoint-independent evidence, source observation and
refutation replay, and `standalone-disposition-source.ts` owns bounded published
advisory revision authentication. `standalone-source.ts`, `standalone.ts` and
`standalone-disposition.ts` retain the per-program drivers and source authentication
and consume those lower volumes instead of importing each other upward. Per-program
drivers remain distinct (ADR-0005), and the
façade exports real parent operations rather than every internal parser (ADR-0007).

A no-agent publisher records the full ordered advisory policy immediately, with
DECLARED provenance and immutable correction/import history. An explicit successor
joins one exact predecessor result and policy revision, preserves scope/roles,
freezes source bytes/modes/absence, and conserves every original Finding Origin.
Historical unknown observations remain unknown; missing current publication refuses.
Current origins bind Run/request/transcript/ordinal and acquire their original result
identity from enclosing publication downstream, avoiding a self-digest cycle.

The existing LC-2 reducer—not a second successor lifecycle—admits v3 ordered
assessments from every current reviewer. All must identify repair/relevant changes
for resolution. Refuted/resolved/policy-retired origins remain assessment obligations.
Only new criticals and explicit evidence-bound critical reopening reach a fresh
bound full panel; unchanged upheld blockers remain active without re-adjudication.
Old IDs, high-water, assertion/severity/evidence and votes/reasons remain exact.
Canonical counts distinguish new, inherited and current state; no fresh-panel-count
or Repair-Checked shortcut can erase a blocker or critical coverage limitation.

Claude/Pi native capture records real durable capture receipts; current replay cannot
invent missing provenance. Pi adds current-only process witnesses with no older-Run
fallback. Bounded reader projection and Read-only panel views expose frozen data,
not independent authority. Fresh predecessor packet references retain exact original
files rather than recursive copies; original bytes remain mandatory. Checkpoint-
independent replay derives canonical JSON; published-source admission additionally
requires the actual result bytes/receipt. P3 retains this **full exact v3 source**
through unchanged schema-2 checks, candidate witnesses and guarded index installation.

Independent standalone/Wave issuance stays v2. Issued v1/v2 initial/resume/retry and
packet/result/receipt bytes remain under their original contracts. Pre-B4 development-
only v3 panel transport changes are not historical v1/v2 migration. Resource limits
are simultaneous boundary budgets, not an all-reads or whole-process heap proof.
Formal wording/digests do not prove semantics; no formal planning tool, automatic
previousRun, fork merge, similarity matching, severity override or review reuse is added.

## Owner verification in the completion suite (G5b)

Plan ownership declarations (G5a) become Wave Gate obligations through the existing Wave completion suite, not a new gate stage:

```text
plan ─parsePlanModels─► obligationsFromInvariants (ownerObligationOf) ─► owner_obligations (stamped at population, [] included)
Wave Gate ─ ensureWaveCompletionSuite ─ authorizeGraphCompletionSuite(graph, workspaceDigest)   (readiness calls the same)
  ownerCheckAuthority(ownerScopeOf(graph), wave) ── null (no stamp: pre-G5b graph) ──► suite roster and digest unchanged
        │ non-null
        ▼
  authorizeWaveCompletionSuite(…, authority) ─► loom:owner-verification { obligationsDigest, owed }
  re-read plan_file ─► planModelsIntegrityFailure (stampAgreement) ─► blocked on unreadable / malformed / drifted plan
  owed = [] ─► verified, no verdicts
  owed ≠ [] ─► runOwnerVerification (shell, outside the StateManager lock)
                 coverage: read the matrix test's import frontier ─► coverageOverFiles
                 mutation: Wave base ─► changedHeadLines ─► mutationPlan ─► detached worktree:
                           baseline, then each mutant via the frozen affectedRunner ─► classify*
                 invariantVerdict per owed obligation; real-workspace digest before = after
  result.ownerVerification ─► evaluateWaveCompletionSuite ─► receipt or rejection
```

- **One selection owner.** `core/owner-verification/obligations.ts` decides the Wave scope (owner or sibling changed, G5a's `changesFamily`), the touch scope (any role, for review packets and brief duties), the check authority, the drift check and which obligations owe mutation (`verifyOwed`). Callers never hold the raw stamp: they receive the opaque `OwnerScope` that `ownerScopeOf(graph)` builds, so the absent-versus-empty distinction cannot be re-encoded inline. An Owner Obligation is built only by `ownerObligationOf`, which the plan derivation and the State File parser share, and its Invariant is a branded `InvariantId`. Every caller is a declared INV-3 sibling with a row in `engine/tests/core/owner-obligations.matrix.test.ts`: `core/owner-verification/suite-authority.ts` (the one authorize-from-TaskGraph function, which the gate helper and readiness both call), `handlers/helpers/wave-completion-suite.ts` (the owed obligations the runner gets), `core/wave-completion-suite-readiness.ts`, `core/owner-verification/plan-integrity.ts` (`stampAgreement`), `state-file-wire.ts`, `orchestration/owner-verification-runner.ts` (through `verificationRuns` in `core/owner-verification/owed-verification.ts`) and `core/task-graph-population.ts` (`verifyOwed`), `core/wave-review-authority.ts` and `core/implementation-brief.ts` (`obligationsTouchedBy`). The State File wire parse re-derives the check authority from the stamp on purpose, so a persisted receipt never certifies its own roster; the runner receives the `OwedVerification` the gate decided (`ownerObservationDecision`: the owed obligations with the authorized digest) instead of re-deriving it. `verification-manifest.ts` makes no ownership decision: its `owner` parameter is required, and it injects the check exactly when `suite-authority.ts` or the State File wire passes a non-null authority.
- **Functional core, imperative shell.** Coverage, the mutation plan, outcome classification, the verdict, the plan-integrity check and the decision of what an owner check runs (`owed-verification.ts`) are pure functions in `core/owner-verification/`. All effects live in `orchestration/owner-verification-runner.ts` (file reads, tsconfig `paths` via `jsonc-parser`, Git base resolution, runner execution) and `orchestration/owner-mutation-workspace.ts` (worktree create, overlay of the reviewed workspace, `node_modules` symlinks, per-mutant rewrite and restore, removal in `finally`). The command is always the frozen `affectedRunner`'s, formed by `affectedRunnerCheck` with the matrix test as its only file; no command text comes from the plan.
- **Fail closed.** `runOwnerVerification` never throws, by construction: every repository read is total (a file the filesystem refuses is `repository-file-unreadable`, never a missing sibling), the workspace observer and the obligation runs are guarded, and a throw that still escapes a step is the named `unexpected-error`, after which the real-workspace digest is still compared. The suite shell keeps a last-resort catch for the injected runner port with the same `unexpected-error` kind, and its own post-check digest comparison runs whatever the owner check returned. A throw from inside the isolated worktree (a failed owner restore, a runner step that throws) is rethrown by `withMutationWorkspace` (`orchestration/owner-mutation-workspace.ts`) after it removes the worktree; when the removal fails too, the rethrown error also names the leftover path. The runner's `mutationEvidence` catches that rethrow and turns it into the Invariant's `worktree-failed` infrastructure verdict, so the leftover path reaches the operator as data; only a throw that escapes every guarded step becomes `unexpected-error`. Every ambiguous observation (no report, unparseable report, nothing collected, an exit the report does not explain, a baseline timeout, a missing Wave base, a changed real workspace, an owner with syntax errors (`owner-unparseable`), a run whose every mutant only failed to collect (`no-valid-mutants`)) is infrastructure and never a kill. The pure verdict returns results that are not the plan's mutants as `plan-drift` data rather than throwing. A result whose only infrastructure failures are the owner check's is published as an attempt record beside the result slot, so a retry at the same workspace runs the check again.
- **Receipt semantics unchanged.** The check is part of the suite digest, so receipt reuse, workspace binding, replay and status come from the existing suite. `checkWaveCompletionSuite` (`wave-gate-checks.ts`, run by `complete-wave-gate`) blocks on it without new code; both harnesses reach it through `programs/wave-gate.ts`.
- **Review and brief.** `wave-review-authority.ts` appends the `owner-map` fixed section (`owner-map.ts`) to schema-2 code-reviewer and architecture-tech-lead packets of a Task that touches an owned family; it is inside the packet digest, and every other packet is byte-identical. `core/implementation-brief.ts` adds the coverage and mutation duty (or the exemption) to the ownership section of each touched Task's brief. Standalone review builds no wave packet, so it never carries an owner map.

Operator detail, status fields and remedies: [Operations — Owner verification](operations.md#owner-verification-blocks-a-wave-gate-g5b). Plan grammar and limits: `references/executable-models.md`.

## Security and failure posture

Loom’s default is refusal when authority is incomplete or ambiguous:

- guarded spawn routes fail closed on handler crashes;
- Pi runtime/CLI version skew is rejected before Run Directory or TaskGraph mutation;
- state and evidence paths are denied to arbitrary Bash writers;
- decisions that probe a path through `utils/path-presence.ts` treat it as absent only on ENOENT: "present but unreadable" is its own answer, so an unreadable routing config, rule, run marker or agent definition refuses instead of reading as missing (moving the remaining raw `existsSync` checks onto it, with a lint ban, is tracked as G5a INV-1; `helper family-sites` counts what remains — 124 raw sites at the G5b base `626db7fb`, see [Operations](operations.md#measuring-second-sites-the-family-site-metric));
- a test command counts as evidence only at a real top-level position: a runner inside `$(…)`/`<(…)` never owns the line's exit or output;
- Run Directory paths must be direct children and are accessed no-follow;
- model and Skill bindings are explicit;
- exact rosters reject missing, duplicate, foreign, and surplus results;
- publication is batch-atomic where partial visibility would alter authority;
- remediation excludes state/review evidence and installs only an audited temporary index;
- legacy formats are isolated in a read-only archive rather than expanded in canonical parsers.

Known limits are documented where they live: shell-text guarding cannot infer every multi-hop cwd construction; ledger-derived proof (I6) covers logged facts only, so a write that emits no ledger event, such as one by an interpreter, a generator or an unseen tool, is a silent hole, and shell writes are logged but cannot be vetoed ([Deterministic implementation, I6](deterministic-implementation.md#during-the-loop--put-the-oracle-inside-the-agents-iteration)); Claude’s evidence attribution stands down during ambiguous parallel activity; Pi RPC children support standard dialogs but not custom TUI components.

## Dependency direction

The intended dependency direction is:

```text
core domain values/reducers
        ↑
handlers and orchestration shell
        ↑
harness adapters and command runbooks
```

`engine/src/core/` must not depend on Pi or Claude APIs. The machine pure core is additionally protected by `no-io-in-pure-modules`, and `no-cross-boundary-imports` checks orchestration boundaries at the full lint tier.

## Where to continue

- User-visible lifecycle: [Workflows](workflows.md)
- Persistence and recovery: [Operations](operations.md)
- Enforcement details: [Deterministic core](deterministic-core.md)
- Pi adapter: [Using Loom with Pi](pi-usage.md)
- Architectural rationale: [ADR-0004](adr/ADR-0004-engine-owned-orchestration-automation.md)
