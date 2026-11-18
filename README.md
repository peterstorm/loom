# Loom

**Loom is an orchestration engine for AI coding agents.** You give it a feature request; it runs a phase pipeline to an architecture, decomposes the work into dependency-ordered Waves of parallel agents, and refuses to advance a Wave until evidence — not claims — says the work is done. It ships as a Claude Code plugin and a native Pi package over one harness-neutral TypeScript engine.

Agents do semantic work. The engine owns deterministic mechanics: state, scope, request identity, model and Skill routing, retries, transcripts, aggregation, state transitions, Git staging, publication — all code-owned and auditable. Users make the real choices.

## Why Loom exists

A multi-agent coding session left to its own devices fails in familiar ways. Each failure below is answered by a mechanism, not a plea in a prompt:

| What goes wrong | What Loom does instead |
|---|---|
| The agent grades its own homework — runs its own tests, reports green | Where the plan requires it, only tests the **engine itself executed** count as proof: `helper run-tests` runs the frozen manifest's runner and issues a receipt bound to the repository root and the manifest's digest. The agent names files; the engine owns execution and the receipt's slot. |
| Run state lives in the chat — a `/clear`, a crash or a restart loses it | The **State File** (also called the TaskGraph) is the protected record of the run, written by the engine in atomic transitions. Harness hooks make the guards unavoidable: they run before, after and around every tool call. |
| Nobody can say who wrote what | During a run the parent session **cannot edit files directly**; changes go through attributed Agents, and every fact in the evidence ledger carries its origin. |
| "Done" is prose | A Task reaches `implemented` only when the engine's **proof obligations** for it are satisfied — completion, regression, new tests, changed declared artifacts, red-then-green test-first evidence where the plan owes it. |
| Reviewers are re-issued wholesale for one-line fixes, so humans bypass review | A fresh Wave Gate **carries unchanged Tasks' accepted reviews** and issues a changed Task only the reviewers its change needs — a comment fix gets one reviewer, a code change the full roster. |
| Late or duplicate evidence silently overwrites outcomes | Settlement is exactly one outcome in one atomic transition; late evidence for older bytes settles nothing, and decided questions stay decided until their bytes change. |

Under all of it sits a **fail-closed** rule: when the engine cannot tell whether a gate ran — a crash, a missing runtime, an unobservable state — it blocks, it does not pass.

## The idea, in four rules

1. **One protected state.** The State File is created before planning starts, so phase order and artifact prerequisites are enforced from the first hook. Agents never write it; the engine's transitions do.
2. **Evidence over claims.** Every test run, file write and review lands in an append-only ledger with provable origin. What cannot be evidenced is not proof.
3. **Judgment stays with agents, choice stays with you.** Agents decide *how*; the engine decides *what counts*; the user decides *what the architecture is* and *what happens to each advisory Finding*.
4. **Everything auditable.** Guards, gates, reviews, mutations and recoveries are engine code with recorded decisions — see the [Feature & Guard Map](docs/feature-guard-map.md), which maps every mechanism to its enforcement and names what honestly remains open.

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

### First run

```text
/loom "Add email/password authentication"
```

That one command drives the whole pipeline below. `/loom --status` shows where a run stands; `/retro` writes its retrospective at the end.

## A run, end to end

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

Each phase is described in [Workflows](docs/workflows.md).

### The architecture phase, with or without a panel

The default architecture phase is one architect agent producing one plan. `/loom --panel` replaces it with a competition: **3 designers** each produce one candidate through one of the catalog's **5 lenses** (`simplicity-first`, `type-driven-fp`, `risk-security-first`, `performance-first`, `codebase-conventionist`), **3 judges** score every candidate against one criterion each, and the engine aggregates. The ranking is advice; the user chooses, and one normal architecture plan comes out.

### Execution: Waves

Decompose produces dependency-ordered Tasks grouped into Waves. Tasks in one Wave run in parallel; Waves advance one at a time. Three things shape an agent's life inside a Wave:

- **Proof, not assertion.** Besides the proof obligations above, stop checks run when an agent tries to stop with contract obligations open, and an attempt that fails gets exactly one retry before terminal escalation — there is no attempt 3.
- **Engine-run test evidence.** When the run's frozen Verification Manifest declares an affected runner, only tests the engine executed count as proof (see [Why Loom exists](#why-loom-exists)).
- **The Distill Task.** Every Wave with implementation files carries one engine-added Distill Task: once every other Task has settled, a fresh `distill-agent` simplifies the Wave's implemented code. The Wave Gate cannot start before it runs. It is itself exempt from review; the other Tasks' Review Packets read the distilled bytes.

A plan may declare **Acceptance Contracts**. Each contract's Task writes a declarations-only types file and acceptance tests, which freeze the moment they are observed failing (red), every test named after the Requirement it decides; the frozen files change only through an audited Contract Revision. Acceptance tests must run through the runtime seams the contract declares — the freeze is refused while an acceptance file does not reference a declared seam — so an acceptance suite cannot pass on a path production never takes.

## The Wave Gate

`/wave-gate` is a registered, resumable program — the gate a Wave passes before the next one opens. In one pass it:

1. creates an **immutable Review Packet per Task** — the exact bytes, plan context and Requirement trace the reviewers will see;
2. issues the reviewers and collects their verdicts;
3. runs one **Wave-level spec check** against the requirements;
4. routes critical Findings to a **Refutation Panel**;
5. pauses for the user to dispose of advisory Findings — every decision recorded on the TaskGraph, anchored to the reviewed bytes;
6. runs the project's frozen checks and full-tier lint;
7. advances the Wave in **one protected write**.

Each Task is reviewed by `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer` and `comment-analyzer`; `architecture-tech-lead` joins for a Task that touches an owned Invariant's family or writes an Acceptance Contract's types file. A re-reviewed Task is issued only the reviewers its change needs, judged against its last accepted review ([Feature & Guard Map](docs/feature-guard-map.md) §4.9).

Reviewers return one JSON object. The engine assigns Finding ids and counts; a critical must state its evidence. Malformed output is recorded as a failed review, never as a Finding. The reviewer protocol is versioned and machine-stamped into the reviewer definitions: a Wave Gate registered now issues protocol v4, in which the engine itself binds the Review Packet ID and Review Generation (a mistyped hash can no longer exhaust a final attempt); a fresh standalone review admits protocol v2 bytes; a run started under an older protocol finishes under it. Details: [standalone review → Reviewer Protocol v2](docs/standalone-review.md#reviewer-protocol-v2).

**The Refutation Panel** adjudicates critical Findings. Default panel size is 3; every verifier applies one assigned lens to every critical. The refutation-lens catalog is `reproduction`, `intent`, `blast-radius`, `security`, and `test-coverage`; baseline selection always includes reproduction and intent. A strict majority must refute; ties keep the Finding. A clean rerun cannot erase an old blocker by omission: every reviewer must assess every earlier Finding before it can be resolved.

**Decisions survive the gate.** The advisory pause records fixed, deferred or dismissed — always with a reason — on the TaskGraph, so abandoning the gate run to act on one advisory loses nothing, and a decided advisory returns to reviewers only when its bytes change. A restarted or fresh Wave Gate carries unchanged Tasks' accepted reviews instead of re-issuing the full roster; a fresh start binds the carry to a Subject Digest sealed into each acceptance, and `start wave-gate --fresh-review` forces a full re-review.

## Finishing a run

After the final Wave Gate, `/retro` reads what the engine recorded — gate runs, reopenings, retries, escalations, Findings — and writes the run's retrospective into the project's retros directory under .claude (created on first write); a retro never blocks, it improves the environment the next run works in. `helper complete-orchestration` archives the TaskGraph and lifts the guards. `/loom --complete` and `--abort` are **not** implemented lifecycle flags; the guarded cleanup helper is only for deliberately abandoning an unfinished run. See [Operations](docs/operations.md).

Skip flags exist for explicit lifecycle bypasses:

```text
/loom --skip-brainstorm "..."
/loom --skip-specify "..."          # requires an existing spec
/loom --skip-clarify "..."
/loom --skip-plan-alignment "..."
/loom --skip-plan-design-review "..."   # no design review of the plan before decompose
```

## Standalone workflows

| Command | What it does |
|---|---|
| `/review-pr [aspect]` | Freezes the changed files, runs the applicable reviewers, refutes criticals, and publishes `result.json`. Aspects: `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all`. It does not touch a feature TaskGraph. |
| `/review-and-fix` | Runs that review, accounts for every surviving critical, fixes what it dispositions as repaired, and installs exactly the verified changes into the Git index. Push is optional; force-push is forbidden. |
| `/security-audit` | Runs a coverage-accounted security audit: hunters per coverage unit, independent verification, and a report that refuses to publish over unsettled coverage. See [Running a security audit](docs/security-audit.md). |
| `/brainstorming`, `/specify`, `/clarify` | Idea exploration, WHAT/WHY requirements, and ambiguity resolution, without starting a full run. |
| `/spec-check` | Read-only audit of the implementation against each requirement. |
| `/lint-project` | Sets up and runs the linter over a project. |
| `/retro [--wave N]` | Retrospective of one Wave, a whole run, or any session, inside or outside Loom. |

Loom's linter runs regex rules after every edit and structural rules at the Wave Gate; both tiers fail closed. Rules and configuration: [Lint rules](lint-rules/README.md).

## What Loom does not claim

The [Feature & Guard Map](docs/feature-guard-map.md) §8 keeps the honest residuals; the short form:

- The **parent session is trusted** at the boundary that starts and stops a run — Loom hardens everything inside the run, not the harness around it.
- **Report artifacts live in an agent-writable environment**: a runner's JUnit XML can be edited after the fact by anything the agent could reach; engine-run evidence closes this at the receipt, not the file.
- **Coverage is only as good as the seeded cells** — a spec check proves what the requirement trace names, nothing else.
- **Attribution has gaps in contended sessions**: evidence attributes by harness events, and two agents writing the same file in one window can blur it.
- **I6 test-first proof reads the logged history** — an unlogged write (an interpreter, a generator) is invisible to it.
- Legacy graphs that predate engine-run evidence keep the older agent-command residuals by design.

## Documentation

- [Documentation index](docs/README.md)
- [Workflows](docs/workflows.md): what each command does
- [Architecture](docs/architecture.md): layers, authority, persistence, guarantees and limits
- [Feature & Guard Map](docs/feature-guard-map.md): the mechanism-level map — every feature, guardrail and determinism device, and the verified residuals
- [Operations](docs/operations.md): status, protected state, operating states and recovery
- [Verification](docs/verification.md): the verification manifest, stop checks, owner verification, the distill pass, Acceptance Contracts and skeletons
- [Using Loom with Pi](docs/pi-usage.md)
- [Running a security audit](docs/security-audit.md)
- [Loom Agents](docs/agents.md)
- [Model profiles and calibration](docs/model-profiles-and-calibration.md)
- [Lint rules](lint-rules/README.md)
- [Guarded Skill Machines](machines/README.md)
- [Hooks](hooks/README.md)
- [Architecture Decision Records](docs/adr/README.md)

## Development

Use Node **22.23.2**, the Bun release pinned in the repository-root `.bun-version`, npm, Git, jq, Bash **4+** and GNU `timeout` (Linux), in a full-history checkout.

```bash
bun install --frozen-lockfile
(cd engine && bun install --frozen-lockfile)
npm run verify
```

`npm run verify` is the full gate: typecheck, then lint, then the whole test script (the Vitest suite and the smoke commands). CI runs it on Linux and macOS for pull requests, pushes to `main` and manual dispatch. Bare `bun test` invokes Bun's built-in runner, not this gate. Details, focused iteration and the repository map: [Development](docs/development.md#development-validation).

## License

MIT
