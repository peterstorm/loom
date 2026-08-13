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
      orchestration façade + Fugue operation DAGs
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

- **PreToolUse** — phase order, Wave/task order, prompt substitution, model/Skill policy, direct-edit policy, guarded machine tools, state-path Bash guard.
- **PostToolUse** — immediate lint, evidence recording, and orchestration-spawn correlation.
- **SubagentStart** — active-Agent tracking and guarded-machine epoch binding.
- **SubagentStop** — phase advancement, implementation proof reconciliation, review/spec evidence capture, orchestration transcript capture, cleanup.
- **SessionStart** — stale binding cleanup and post-`/clear` context restoration.

### Pi

`pi/extension.ts` maps Pi `tool_call`, `tool_result`, Agent lifecycle, and resource discovery events to the same core decisions. It also owns Pi-specific concerns:

- deriving package identity from `import.meta.url`;
- rendering resources through `pi/resources.ts`;
- adapting Pi messages through `pi/transcript-adapter.ts`;
- minting and consuming scoped write grants through `pi/write-grant.ts`;
- correlating native Pi batch-item identities to engine-issued request identities;
- capturing exact final result bytes into reserved Run Directory slots.

`pi/loom-bridge.ts` is a fail-closed legacy stub and is not registered by `package.json`.

## Layer 3: handler shell and parsing boundaries

`engine/src/handlers/` turns untrusted harness payloads and CLI arguments into calls to the core. Handler families mirror harness lifecycle events; `handlers/helpers/` exposes explicit operator/program operations.

Important parser boundaries include:

- `state-manager.ts` — parses the complete protected TaskGraph before use;
- `parsers/parse-phase-artifacts.ts` — derives phase artifacts from completed Agent output;
- `parsers/parse-plan-models.ts` — parses exact lifecycle, pipeline, and invariant declarations;
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
| Protected Bash policy | `guard-state-file.ts`, `shell-normalize.ts`, `shell-ansi-c.ts` | Detect guarded-path writes through shell syntax and fail closed |
| Completion evidence | `proof-obligations.ts`, `wave-gate-model.ts` | Derive whether a Task earned `implemented` |
| Finding lifecycle | `findings.ts`, `review-output.ts`, `review-packet.ts` | Stable identity, generations, packet-bound remediation verification |
| Architecture panel | `panel-kernel.ts`, `panel-contract.ts`, `panel-program.ts` | Lenses, exact candidates/criteria, verdict validation, ranking, retries |
| Refutation panel | `panel-kernel.ts`, `review-panel.ts`, `panel-program.ts` | Exact critical set, verifier lenses, majority tally, retained audit |
| Standalone review | `standalone-review.ts`, `standalone-review-machine.ts` | Frozen scope/roster, aggregation, optional refutation, authoritative result |
| Wave Gate | `wave-gate-machine.ts` | Review/refutation/advisory/completion lifecycle and canonical status |
| Remediation | `remediation-machine.ts` | Scope authority, excluded evidence paths, audit/stage/install lifecycle |
| Model policy | `model-profiles.ts`, `model-calibration.ts` | Explicit cross-harness bindings and deterministic calibration scoring |
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
start <architecture|refutation|standalone-review|wave-gate|remediation>
restart                 # exhausted Wave reviewer run only
resume
submit                   # compatibility/manual capture path
correlate                # harness-native id → request authority
complete                 # compatibility for old panel callers
decide                   # user decision
```

New registered standalone-review, Wave Gate, and remediation programs are driven by `handlers/helpers/programs/`. The façade materializes Context Packets and complete request authorities before returning an action. Harness adapters capture results directly; the parent does not rewrite transcripts.

### Fugue runtime and operation DAGs

Loom pins `@fuguejs/framework` 0.4.0. `orchestration/fugue-program-runtime.ts` drives Loom reducers with Fugue’s public state-machine APIs and persists append-only events plus a checkpoint projection.

Static operation DAGs under `orchestration/dags/` execute deterministic work for panels, standalone review, Wave Gate, and remediation. They are not a generic workflow DSL. Each domain retains its own state/event algebra.

Nodes receive only declared narrow capabilities:

- `runArtifacts` — publish a fixed artifact set into an anchored run;
- `protectedStateCommit` — the only operation-DAG seam that can delegate to `StateManager`;
- `gitIndex` — observe Git witnesses and install a verified index.

Pure validation/routing nodes receive no capability.

### Effects and idempotency

Reducers emit typed effect intents. `orchestration/effect-runner.ts` executes them and records receipts. On resume, an already-receipted effect is reconciled rather than run again. This separates “the domain authorizes this effect” from “the shell performed it.”

## Two persistence domains

### Protected TaskGraph

The active feature lifecycle lives at:

- Claude Code: `.claude/state/active_task_graph.json`
- Pi: `.pi/state/active_task_graph.json`

`StateManager` is the only general writer. It uses a lock, temporary-file/rename publication, and mode `0444` at rest. Hooks and a narrow helper allowlist mediate changes. The graph contains phase artifacts, skipped phases, Tasks/Waves, proof results, review generations/runs, Findings, Wave Gate records, and GitHub tracking metadata.

This graph is mutable protected state because a feature progresses over time.

### Immutable Run Directories

Review/panel/remediation evidence lives in fresh direct-child Run Directories. `orchestration/run-directory-handle.ts` anchors every access and exposes no arbitrary-path write API.

Canonical layout:

```text
run.<id>/
├── authority.json
├── program.json
├── checkpoint.json
├── progress.json
├── events/
├── requests/
│   └── correlators/
├── contexts/
├── transcripts/
├── receipts/
└── artifacts/
```

Authority, request, context, transcript, event, and receipt slots are immutable/exclusive. The handle verifies the direct-child relation, rejects unsafe identity/path shapes, and reopens path components with no-follow filesystem operations. Checkpoints are projections; append-only events and immutable evidence remain the audit history.

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

## Review authority model

A review Finding is identified by Agent plus emission ordinal, never by model-supplied id. A Task implementation write increments its Review Generation. A Review Packet binds that generation to exact base/head revisions, exact path scope, diffs, postimage bytes, plan context, and proof obligations.

A Review Run freezes:

- packet identity;
- exact reviewer roster;
- ordered active Finding ids;
- generation and repository revisions.

Every expected reviewer must assess every prior Finding exactly once before finalization. A `still_present` assessment keeps it active. A Finding becomes **resolved** only when the complete roster verifies remediation. A Finding becomes **refuted** only through adjudication (or an audited manual override); refutation is not resolution.

## Security and failure posture

Loom’s default is refusal when authority is incomplete or ambiguous:

- guarded spawn routes fail closed on handler crashes;
- state and evidence paths are denied to arbitrary Bash writers;
- Run Directory paths must be direct children and are accessed no-follow;
- model and Skill bindings are explicit;
- exact rosters reject missing, duplicate, foreign, and surplus results;
- publication is batch-atomic where partial visibility would alter authority;
- remediation excludes state/review evidence and installs only an audited temporary index;
- legacy formats are isolated in a read-only archive rather than expanded in canonical parsers.

Known limits are documented where they live: shell-text guarding cannot infer every multi-hop cwd construction; Claude’s evidence attribution stands down during ambiguous parallel activity; Pi’s headless children cannot yet relay interactive phase interviews.

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
