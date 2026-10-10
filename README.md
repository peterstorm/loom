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

- Linux or macOS 13+ for the existing runtime (`/proc/self/fd` descriptor-relative authority on Linux; `O_NOFOLLOW_ANY` on macOS, with older Darwin kernels refused at startup). **Strict critical-remediation report reset is Linux-only**; Darwin fails before check launch. Zero-critical remediation and Wave behavior are unchanged.
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

Fresh independent standalone/Wave registrations use Reviewer Protocol v2: one JSON
payload, engine-derived counts/IDs, and full critical Finding Basis under the
issued schema and impact rubric. Filled fields prove neither truth nor impact.
Malformed output is failed evidence, not a synthetic Finding. The same panel and
majority remain; a true assertion is not refuted because fixing it seems unimportant,
and surviving criticals block without a new severity override. Completed and
unfinished issued reviewer v1 runs keep their original protocol and packet-first
archived instructions. See [ADR-0009](docs/adr/ADR-0009-versioned-reviewer-protocol.md).
**P4 merged as `96153ed` on 2026-09-10; publication/reload were verified.**
P5 lineage is implemented on the feature worktree; final validation, registered
review and publication remain pending.

## Standalone quality workflows

### `/review-pr`

Freezes explicit files or the canonical changed-path union, selects the applicable reviewer roster, captures exact outputs, aggregates identified Findings, and automatically runs a Refutation Panel when criticals exist. It publishes authoritative `result.json` without touching the feature TaskGraph.

Aspects: `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all`.

`simplify` runs the `code-simplifier` reviewer (preloading the `distill` skill) on its own; under `all` it joins the roster automatically whenever the scope changes source or test files.

`architecture` runs the `architecture-tech-lead` reviewer (preloading the `deepen` skill in review mode) on its own; under `all` it always joins the roster, and it is auto-selected for >500 additions, >10 files, or new structure.

### `/review-and-fix`

Runs adjudicated standalone review, writes a remediation plan, accounts for every surviving critical, applies those dispositioned `repaired`, and validates the code before opening a registered remediation run. By default, the parent autonomously dispositions each advisory as accepted, deferred, or dismissed from the evidence and fixes accepted advisories; advisories remain outside critical repair groups. Refuted criticals are retained for audit and are never repaired.

Every new remediation start uses schema v2 and supplies `defectFamily`, including the explicit `{ "kind": "not-required" }` declaration when the source review has zero surviving criticals. Otherwise every original surviving-critical Finding ID is copied exactly into one disposition; repaired dispositions refer to separately named Declared Repair Groups, while unresolved or out-of-scope criticals and siblings are valid declarations that block installation. Grouping, root cause, invariant, sibling accounting, and Historical RED are `DECLARED`; only fresh repaired-state JUnit/Vitest results are `ENGINE_OBSERVED`. The resulting label is `repair-checked`, not proven closure, a `ResolvedFinding`, or a new Finding identity.

For critical checks, the engine first removes the exact old ignored/untracked regular report using no-follow, descriptor-relative unlink anchored to its Linux parent. The command must write a new report; touching old bytes cannot pass. Reports are capped at **8 MiB** and XML depth **128**; v2 event reads, append reconciliation/new appends, and inspection at **12 MiB per encoded event, 64 MiB per encoded journal, 1024 records**. An operator-owned fixed command can still fabricate a valid new report: fresh structured engine observations are not semantic proof. See [operations](docs/operations.md#enrolling-a-critical-repair-check) for scope and failures.

The engine binds those observations to unchanged candidate bytes and modes, audits dirty paths, stages literal paths in a temporary Git index, proves the staged set, and installs only versioned opaque authority under the real index lock. The external `done` outcome contains the actual installation receipt and Defect-Family Assessment; callers do not supply staging outcomes, receipts, manifests, report bytes, or Run JSON. Push is optional; force-push is forbidden. Completed v1 remediation is read-only `historical-unknown`, never authority to reinstall; unfinished v1 blocks and missing v2 fields never downgrade. Completed-v2 replay refuses malformed checkpoint audit paths explicitly.

P3's selected operator checks, fresh required reports and installation policy are
unchanged by the reviewer-wire major version. Published v1/v2 sources retain
original IDs/full basis and result authority; P5's deliberate v3 arm additionally
retains the complete exact lineage-bearing source JSON. Use canonical
`helper orchestration inspect` for engine-rendered emitted/admitted and
post-refutation counts from root `result.json`; do not author replacement tallies.
Subsequent review/install uses the actually admitted runtime, with reload/restart
after package installation. The earlier Skill 3.1 bootstrap is P3 history, not a
P4 recipe; see [runtime publication](docs/operations.md#remediation-and-git-safety).

### Explicit standalone lineage (P5)

On a matching P5 runtime, parent advisory triage publishes complete ordered
accepted/deferred/dismissed decisions immediately through the no-agent
`standalone-disposition` program, even without a fix or successor. Policy remains
DECLARED; corrections name exact earlier publications, imports are present-day
attestations, and unavailable history is explicit—not corrupt-current fallback.

An explicitly selected schema-3 successor retains predecessor scope/roles, original
Finding IDs/assertions/severity/evidence and full history. Every current reviewer
assesses every origin; resolution needs whole-roster repair judgments against frozen
bytes/modes. Only new criticals and evidence-bound reopening need a fresh panel.
New/inherited/current counts are engine-derived. P3 preserves exact full source
bytes and uses actual active criticals, with a full-current-critical-coverage guard;
its schema-2 checks/index policy is unchanged. Digests and formally phrased claims
are not semantic proof. No automatic predecessor, extra rerun roster, review reuse,
branch join, similarity merge, severity override or formal planning feature.

**Bootstrap restriction:** P5's own final registered review/remediation still uses
admitted main runtime `sha256:086c472e4e913376c07d69f5116c9ad9655546e22c91e40d28cba9fdd795bc79`
and Skill 5.0.0's ordinary Plan triage. It does not implement the P5 publisher.
Do not use a feature CLI against that loaded runtime, unset admission or retrofit
source review. New records can publish after merge/package publication/reload.
See [operations/input/bounds](docs/operations.md#standalone-lineage-p5) and
[ADR-0010](docs/adr/ADR-0010-standalone-finding-lineage.md).

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

Use Node **22.23.2**, the Bun release pinned in the repository-root `.bun-version` (CI installs it and `npm run verify` enforces it locally), npm, Git, jq, Bash **4+**, and GNU `timeout`. Install both existing lockfiles from the repository root; the Pi smoke requires the root-local locked Pi CLI, not a global/latest installation. Use a full-history Git checkout: the suite resolves the committed model-calibration corpus against historical revisions available through remote refs. Linux CI enforces this with `actions/checkout` `fetch-depth: 0`; a depth-1 checkout cannot run the mandatory full gate.

```bash
bun install --frozen-lockfile
(cd engine && bun install --frozen-lockfile)
npm run verify
```

`npm run verify` is the mandatory full gate for local development, Linux CI (PRs, branch pushes, and tags), and this repository's configured runtime Wave check. It delegates to `engine` prerequisites, then typecheck, then the entire existing Vitest suite and all six smoke commands, stopping on failure. Do not substitute selectors or focused tests for this gate.

The compiler checks all configured `engine/src`, `engine/tests`, `pi`, and `engine/scripts/typecheck.ts` roots. Only external raw-TypeScript unused diagnostics TS6133/6192/6196 may be excluded, and each exclusion is printed; ordinary dependency errors remain fatal. This does not claim every standalone root script as a compiler root.

For tests without the compiler gate, use `npm --prefix engine run test` (or `cd engine && bun run test`). **Bare `bun test` invokes Bun's built-in runner, not the package's Vitest + smoke script.** The suite includes unit, property, fault-injection, integration, cross-harness, runbook-contract, and smoke coverage. Report platform-dependent skips and not-run stages explicitly; Linux validation is not evidence of macOS validation.

The operator source `.loom/verification-manifest.json` selects `project:verify` (`npm run verify`, root cwd, Wave scope, 30-minute timeout) with required report `.loom/completion-reports/verify.junit.xml`. The user-approved 2026-09-09 idle enrollment keeps the fixed command unchanged: the existing Vitest invocation now emits default console output and JUnit into that Git-ignored, untracked root directory. JUnit describes only the Vitest suite, not compiler or smoke testcases; normal zero exit of the whole command also proves the compiler and all six smokes passed. A green report cannot override a later smoke failure. Population freezes the source; enrollment is neither a pass nor a completed live schema-v2 remediation. Critical P3 acceptance still requires fresh engine-observed execution and report facts. See [Verification manifest](docs/workflows.md#verification-manifest) for enrollment and coverage semantics.

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
