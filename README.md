# Loom

Loom is a Claude Code plugin and native Pi package for delivering complex software through explicit requirements, architecture, parallel implementation Waves, and evidence-backed quality gates.

It combines:

- a full feature pipeline — **brainstorm → specify → clarify → architecture → plan alignment → decompose → execute**;
- opt-in architecture panels with competing design lenses and adversarial judges;
- Wave Gates that require proof, tests, spec alignment, multi-Agent review, critical-Finding adjudication, advisory disposition, and full lint;
- standalone PR review and end-to-end review/remediation workflows;
- reusable architecture, implementation, test, security, frontend, and lint Skills;
- a two-tier fail-closed linter;
- one harness-neutral TypeScript engine with Claude Code and Pi adapters.

The engine owns deterministic mechanics. Agents do semantic work; users make real choices. Scope, request identity, model/Skill routing, retries, transcripts, rosters, aggregation, state transitions, Git staging, and publication are code-owned and auditable.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Workflows](docs/workflows.md)
- [Operations and development](docs/operations.md)
- [Using Loom with Pi](docs/pi-usage.md)
- [Deterministic core](docs/deterministic-core.md)
- [Model profiles and calibration](docs/model-profiles-and-calibration.md)
- [Lint-rule authoring](lint-rules/README.md)
- [Guarded skill machines](machines/README.md)

## Quick start

### Prerequisites

- Linux (`/proc/self/fd` descriptor-relative filesystem authority is required)
- [Bun](https://bun.sh/)
- Git
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Pi](https://github.com/earendil-works/pi-coding-agent)
- GitHub CLI for full `/loom` issue tracking and optional push operations

### Claude Code

```bash
claude plugin add /absolute/path/to/loom
```

### Pi

```bash
pi install /absolute/path/to/loom
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
```

Then run `/reload` in Pi. Git and npm install forms are documented in [Using Loom with Pi](docs/pi-usage.md).

### Common commands

```text
/loom "Add email/password authentication"
/loom --panel "Redesign the ingestion pipeline"
/loom --panel=4 "Add multi-tenant authorization"
/loom --status

/wave-gate
/review-pr
/review-pr tests
/review-and-fix --no-push

/brainstorming
/specify "Feature description"
/clarify path/to/spec.md
/spec-check
/lint-project
```

Skip flags exist for explicit lifecycle bypasses:

```text
/loom --skip-brainstorm "..."
/loom --skip-specify "..."          # requires an existing spec
/loom --skip-clarify "..."
/loom --skip-plan-alignment "..."
```

`/loom --complete` and `--abort` are not implemented lifecycle flags. Use the guarded cleanup helper only for deliberate operator teardown; see [Operations](docs/operations.md).

## Full feature flow

```text
Feature request
     |
     v
Brainstorm → Spec → Clarify? → Architecture → Plan alignment → Decompose
                                  |                               |
                                  | --panel                       v
                                  | interview → designers     TaskGraph
                                  |            → judges           |
                                  |            → user choice      v
                                  +--------------------------  Wave 1 Tasks
                                                                  |
                                                             /wave-gate
                                                                  |
                                                          Wave 2 ... done
```

### Planning phases

| Phase | Agent | Primary artifact |
|---|---|---|
| Brainstorm | `brainstorm-agent` | `.claude/specs/<slug>/brainstorm.md` |
| Specify | `specify-agent` | `.claude/specs/<slug>/spec.md` |
| Clarify | `clarify-agent` | updated spec + clarification log |
| Architecture | `architecture-agent` | `.claude/plans/<slug>.md` |
| Plan alignment | `plan-alignment-agent` | `.claude/specs/<slug>/plan-alignment.md` |
| Decompose | `decompose-agent` | validated Tasks/Waves installed in protected state |

The state file is created before planning starts, so hooks enforce phase order and artifact prerequisites throughout the lifecycle.

### Architecture panel

`/loom --panel` changes Phase 3 only. The default architecture panel uses **3 designers**, **3 judges**, and the catalog contains **5 lenses**: `simplicity-first`, `type-driven-fp`, `risk-security-first`, `performance-first`, and `codebase-conventionist`.

1. interview once and validate the labeled digest;
2. run 2–5 designers in parallel, each with one distinct design lens;
3. run three judges in parallel, each scoring every exact manifest candidate against one criterion;
4. aggregate scores deterministically;
5. present the top approaches and let the user choose;
6. synthesize one normal architecture plan with an auditable decision record.

The ranking is advice, not authority. The user may choose a lower-ranked candidate. Candidates and verdicts remain in a fresh Run Directory; downstream phases still consume exactly one plan.

Pi runs the panel interviewer and other live-question phase roles through `loom_interactive_subagent`: a parent-relayed RPC child whose `AskUserQuestion` calls appear in the parent TUI without losing child context. The normal `subagent` transport remains headless and refuses interactive roles. See [Pi Interactive Phase Transport](docs/pi-phase-agent-interviews.md).

### Execution Waves

Decompose produces dependency-ordered Tasks grouped into Waves. Tasks in one Wave run in parallel; Waves advance sequentially.

Every implementation Task receives exact plan/spec context, required Skill, files, and project rules. A Task reaches `implemented` only after engine-derived proof obligations are satisfied. Depending on declared policy, proof covers Agent completion, regression tests, new tests, and changed declared artifacts.

Direct parent edits are blocked during active orchestration. Changes flow through attributed Agents so evidence and review generations remain meaningful.

## Wave Gate

`/wave-gate` is a registered, resumable program. It owns:

1. protected state and proof readiness;
2. immutable Review Packet creation for every Wave Task;
3. exact reviewer/model/Skill request publication;
4. one Wave-level spec check;
5. exact transcript capture and roster completion;
6. critical-Finding Refutation Panel routing;
7. advisory user disposition;
8. full-tier lint;
9. atomic protected-state advancement.

Each Task is reviewed by:

- `code-reviewer` — correctness, project rules, maintainability;
- `silent-failure-hunter` — swallowed errors and unsafe fallback behavior;
- `pr-test-analyzer` — test quality and missing regressions;
- `type-design-analyzer` — invariants and illegal states;
- `comment-analyzer` — inaccurate or decaying documentation.

### Finding lifecycle

Findings have engine-derived identity. Implementation changes increment a Task’s Review Generation and require a new immutable Review Packet. Every reviewer in the exact roster must assess every prior Finding before it can be resolved.

Critical Findings are adjudicated by a Refutation Panel. **Default panel size is 3.** Every verifier applies one assigned lens to every critical. The refutation-lens catalog is `reproduction`, `intent`, `blast-radius`, `security`, and `test-coverage`; baseline selection always includes reproduction and intent. A strict majority must refute; ties keep the Finding. Refuted Findings retain votes and reasoning as audit data. In a Wave Gate, advisories bypass refutation and require an explicit operator disposition.

A clean rerun cannot erase an old blocker by omission.

## Standalone quality workflows

### `/review-pr`

Freezes explicit files or the canonical changed-path union, selects the applicable reviewer roster, captures exact outputs, aggregates identified Findings, and automatically runs a Refutation Panel when criticals exist. It publishes authoritative `result.json` without touching the feature TaskGraph.

Aspects: `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all`.

`simplify` runs the `code-simplifier` reviewer (preloading the `distill` skill) on its own; under `all` it joins the roster automatically whenever the scope changes source or test files.

`architecture` runs the `architecture-tech-lead` reviewer (preloading the `deepen` skill in review mode) on its own; under `all` it always joins the roster, and it is auto-selected for >500 additions, >10 files, or new structure.

### `/review-and-fix`

Runs adjudicated standalone review, writes a remediation plan, applies every surviving critical, and validates the code before opening a registered remediation run. By default, the parent autonomously dispositions each advisory as accepted, deferred, or dismissed from the evidence and fixes accepted advisories; it does not ask the operator to choose IDs unless explicitly requested. The engine audits dirty paths, excludes Loom evidence, stages literal paths in a temporary Git index, proves the staged set, rechecks repository witnesses, and atomically installs the verified index before commit. Push is optional; force-push is forbidden.

### Requirements and drift

- `/brainstorming` — idea exploration only.
- `/specify` — WHAT/WHY requirements only.
- `/clarify` — systematic ambiguity resolution.
- `/spec-check` — read-only per-requirement alignment audit, distinct from code review.

## Engine architecture

```text
engine/src/
├── cli.ts, handler-routes.ts       closed CLI dispatch
├── config.ts, types.ts             policy views and persisted types
├── state-manager.ts                protected TaskGraph parser/writer
├── core/                           harness-neutral parsers and reducers
│   ├── orchestration-contract/     identity, rosters, actions, effects, receipts
│   ├── *-machine.ts                Wave Gate, standalone, remediation lifecycles
│   ├── panel-*.ts                  architecture/refutation policy
│   ├── findings.ts                 Finding identity and invariants
│   ├── review-packet.ts            immutable scoped code evidence
│   └── model-*.ts                  model policy and calibration
├── orchestration/                  imperative shell
│   ├── run-directory-handle.ts     anchored fixed-layout persistence
│   ├── no-follow-fs.ts             descriptor/no-follow filesystem operations
│   ├── context-packets.ts          immutable spawn context
│   ├── effect-runner.ts            effect intent/receipt reconciliation
│   ├── fugue-program-runtime.ts     event journal + checkpoint runtime
│   ├── dags/                        static operation DAGs
│   └── git-remediation.ts           verified-index installation
├── handlers/                       harness and helper boundaries
├── machine/                        guarded per-Agent phase machines/evidence
├── linter/                         immediate and full-tier lint
└── parsers/                        transcript, test, artifact, plan parsers
```

Read [Architecture](docs/architecture.md) for authority and dependency boundaries.

## State and Run Directories

Loom uses two different persistence models:

### Protected TaskGraph

```text
.claude/state/active_task_graph.json
.pi/state/active_task_graph.json
```

This mutable protected state tracks feature progress. It is mode `0444` at rest and written only by `StateManager` through locks and atomic rename. Hooks and narrow helper policy guard it from direct Agent writes.

### Immutable Run Directories

Standalone reviews, panels, Wave Gates, and remediation use fresh `run.*` directories. A `RunDirHandle` requires a direct child of the declared root and exposes fixed operations only. It persists:

- run/program authority;
- append-only events and checkpoints;
- exact request authorities and native correlators;
- content-addressed Context Packets;
- byte-exact transcript attempts;
- effect receipts;
- canonical result artifacts.

No arbitrary output path is accepted. Symlink/path drift and duplicate publication fail closed.

## Evidence and deterministic enforcement

Loom turns load-bearing prose into executable checks:

- **Proof obligations** derive implementation completion.
- **Review Packets/Runs** bind review to exact bytes, generation, scope, and roster.
- **Executable lifecycles** are imported typed reducers/statecharts, not duplicate diagrams.
- **Fugue-generated pipelines** carry an integrity stamp checked at full lint.
- **Checkable invariants** are project lint rules; uncheckable ones are honestly advisory.
- **Guarded skill machines** enforce tool order when evidence attribution is unambiguous.
- **State-path guarding** rejects shell writes through many quoting, substitution, brace, glob, and heredoc forms.
- **Typed orchestration reducers** make retries, terminal blocks, and user decisions explicit.

See [Deterministic Core](docs/deterministic-core.md) and [Executable Models](references/executable-models.md).

## Linter

Loom’s linter is automatic and fail-closed.

| Tier | When | Rules |
|---|---|---|
| Immediate | after Edit/Write | project/default regex rules; per-file deadline |
| Full | Wave Gate or explicit scan | regex plus programmatic structural rules |

Bundled programmatic rules enforce bounded-context imports, I/O-free pure modules, maximum function length, and Fugue generated-structure integrity. Project configuration lives under `.claude/linter/` or `.pi/linter/`.

```bash
bun scripts/lint-project.ts <path>
```

See [Lint Rules](lint-rules/README.md).

## Explicit model policy

Every Loom Agent maps to one semantic LLM profile with complete Claude Code and Pi bindings. Registered spawn requests carry both bindings, required Skill, Context Packet digest, and output slot. Missing policy blocks rather than inheriting implicitly.

Pi Agent definitions are rendered and integrity-stamped:

```bash
bash scripts/sync-pi-agents.sh
```

Live model calibration uses a committed vulnerable/fixed corpus and requires explicit opt-in. See [Model profiles and calibration](docs/model-profiles-and-calibration.md).

## Pi support

The native Pi package registers `pi/extension.ts`. It:

- renders shared resources from the active package root;
- validates generated user-level Agent definitions;
- maps Pi tool events to the shared engine;
- issues one-time implementation or scoped artifact write grants;
- binds Pi batch items to engine request authority;
- captures result bytes into immutable slots;
- relays interactive phase-Agent questions from RPC children to the parent TUI.

The legacy `loom-bridge` extension no longer exists in the package; do not load a cached copy alongside the native extension — both would process `subagent` completion and duplicate state transitions.

Interactive phase interviews use the dedicated RPC transport; non-interactive registered review, Wave Gate, remediation, guards, lint, and execution machinery continue through the shared engine and headless subagent path. Read [Using Loom with Pi](docs/pi-usage.md) for the exact support contract.

## Development

```bash
cd engine
bun run typecheck
bun run test:unit
bun run test:smoke
# unit + smoke
bun test
```

The suite includes unit, property, fault-injection, integration, cross-harness, runbook-contract, and smoke coverage.

Useful package operations:

```bash
bun engine/src/cli.ts helper orchestration status
bun engine/src/cli.ts helper model-profiles validate
bash scripts/sync-pi-agents.sh
bun scripts/lint-project.ts engine/src
```

See [Operations](docs/operations.md) for recovery and focused validation.

## License

MIT
