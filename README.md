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

## Quick start

### Prerequisites

- Linux or macOS 13+ (older Darwin kernels are refused at startup)
- [Bun](https://bun.sh/)
- Git
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Pi](https://github.com/earendil-works/pi-coding-agent)
- GitHub CLI for full `/loom` issue tracking and optional push operations

### Claude Code

The repository is its own plugin marketplace (`.claude-plugin/marketplace.json` lists one plugin, `loom`, sourced from the repository root). Add the marketplace, then install the plugin from it:

```text
/plugin marketplace add /absolute/path/to/loom
/plugin install loom@loom
```

`/plugin marketplace add` also accepts a GitHub repository (`peterstorm/loom`).

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
/security-audit

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
/loom --skip-plan-design-review "..."   # no design review of the plan before decompose
```

`/loom --complete` and `--abort` are not implemented lifecycle flags. After the final Wave Gate, `helper complete-orchestration` archives the TaskGraph and lifts the guards. The guarded cleanup helper is only for deliberately abandoning an unfinished run. See [Operations](docs/operations.md).

## Full feature flow

```text
Feature request
     |
     v
Brainstorm → Spec → Clarify? → Architecture → Plan alignment → Plan design review → Decompose
                                  |                                                     |
                                  | --panel                                             v
                                  | interview → designers                           TaskGraph
                                  |            → judges                                 |
                                  |            → user choice                            v
                                  +------------------------------------------------ Wave 1 Tasks
                                                                                        |
                                                                                   /wave-gate
                                                                                        |
                                                                                Wave 2 ... done
```

| Phase | Agent | Primary artifact |
|---|---|---|
| Brainstorm | `brainstorm-agent` | `.claude/specs/<slug>/brainstorm.md` |
| Specify | `specify-agent` | `.claude/specs/<slug>/spec.md` |
| Clarify | `clarify-agent` | updated spec + clarification log |
| Architecture | `architecture-agent` | `.claude/plans/<slug>.md` |
| Plan alignment | `plan-alignment-agent` | `.claude/specs/<slug>/plan-alignment.md` |
| Plan design review (a gate, not a phase) | `code-reviewer`, `type-design-analyzer`, `architecture-tech-lead` | `plan_design_review` in protected state, bound to the plan's SHA-256 |
| Decompose | `decompose-agent` | validated Tasks/Waves installed in protected state |

The State File (the protected record of the run, also called the TaskGraph) is created before planning starts, so hooks enforce phase order and artifact prerequisites throughout. Each phase is described in [Workflows](docs/workflows.md).

### Architecture panel

`/loom --panel` changes the architecture phase only. The default panel uses **3 designers** and **3 judges**, and the catalog contains **5 lenses**: `simplicity-first`, `type-driven-fp`, `risk-security-first`, `performance-first`, and `codebase-conventionist`. Designers each produce one candidate through one lens, judges score every candidate against one criterion, and the engine aggregates the scores. The ranking is advice: the user chooses, and one normal architecture plan comes out.

### Execution Waves

Decompose produces dependency-ordered Tasks grouped into Waves. Tasks in one Wave run in parallel; Waves advance one at a time. A Task reaches `implemented` only when the engine's proof obligations for it are satisfied: Agent completion, regression tests, new tests and changed declared artifacts, as its policy requires. While a run is active the parent session cannot edit files directly; changes go through attributed Agents so the evidence stays meaningful.

## Wave Gate

`/wave-gate` is a registered, resumable program. It creates an immutable Review Packet per Task, issues the reviewers, runs one Wave-level spec check, routes critical Findings to a Refutation Panel, asks the user to dispose of advisories, runs the project's frozen checks and full-tier lint, and then advances the Wave in one protected write.

Each Task is reviewed by `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer` and `comment-analyzer`. `architecture-tech-lead` joins for a Task that touches an owned Invariant's family or writes an Acceptance Contract's types file.

Reviewers return one JSON object. The engine assigns Finding ids and counts; a critical must state its evidence. Malformed output is recorded as a failed review, never as a Finding. Runs started under the older protocol finish under it. Details: [operations → Reviewer Protocol v2](docs/standalone-review.md#reviewer-protocol-v2).

Critical Findings are adjudicated by a Refutation Panel. **Default panel size is 3.** Every verifier applies one assigned lens to every critical. The refutation-lens catalog is `reproduction`, `intent`, `blast-radius`, `security`, and `test-coverage`; baseline selection always includes reproduction and intent. A strict majority must refute; ties keep the Finding. A clean rerun cannot erase an old blocker by omission: every reviewer must assess every earlier Finding before it can be resolved.

## Standalone workflows

| Command | What it does |
|---|---|
| `/review-pr [aspect]` | Freezes the changed files, runs the applicable reviewers, refutes criticals, and publishes `result.json`. Aspects: `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all`. It does not touch a feature TaskGraph. |
| `/review-and-fix` | Runs that review, accounts for every surviving critical, fixes what it dispositions as repaired, and installs exactly the verified changes into the Git index. Push is optional; force-push is forbidden. |
| `/security-audit` | Runs a coverage-accounted security audit: hunters per coverage unit, independent verification, and a report that refuses to publish over unsettled coverage. See [Running a security audit](docs/security-audit.md). |
| `/brainstorming`, `/specify`, `/clarify` | Idea exploration, WHAT/WHY requirements, and ambiguity resolution, without starting a full run. |
| `/spec-check` | Read-only audit of the implementation against each requirement. |
| `/lint-project` | Sets up and runs the linter over a project. |

Loom's linter runs regex rules after every edit and structural rules at the Wave Gate; both tiers fail closed. Rules and configuration: [Lint rules](lint-rules/README.md).

## Documentation

- [Documentation index](docs/README.md)
- [Workflows](docs/workflows.md): what each command does
- [Architecture](docs/architecture.md): layers, authority, persistence, guarantees and limits
- [Operations](docs/operations.md): status, recovery, validation
- [Using Loom with Pi](docs/pi-usage.md)
- [Running a security audit](docs/security-audit.md)
- [Loom Agents](docs/agents.md)
- [Model profiles and calibration](docs/model-profiles-and-calibration.md)
- [Lint rules](lint-rules/README.md)
- [Guarded Skill Machines](machines/README.md)
- [Architecture Decision Records](docs/adr/README.md)

## Development

Use Node **22.23.2**, the Bun release pinned in the repository-root `.bun-version`, npm, Git, jq, Bash **4+** and GNU `timeout`, in a full-history checkout.

```bash
bun install --frozen-lockfile
(cd engine && bun install --frozen-lockfile)
npm run verify
```

`npm run verify` is the full gate: typecheck, then lint, then the whole test script (the Vitest suite and the smoke commands). CI runs it on Linux and macOS for pull requests, branch pushes and tags. Bare `bun test` invokes Bun's built-in runner, not this gate. Details, focused iteration and the repository map: [Operations](docs/development.md#development-validation).

## License

MIT
