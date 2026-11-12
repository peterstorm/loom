# Loom documentation

Documentation for Loom 1.1. Runbooks live in `commands/` and `skills/`; these documents explain them.

## Using Loom

| Document | Read it for |
|---|---|
| [Project README](../README.md) | What Loom is, installation, the commands |
| [Workflows](workflows.md) | What each command does: the `/loom` lifecycle, panels, the Wave Gate, standalone review, remediation |
| [Using Loom with Pi](pi-usage.md) | Installing and operating on Pi: write grants, the route gate, emission readiness, troubleshooting |
| [Running a security audit](security-audit.md) | The `security-audit` program: operations, run directory, blockers, sandbox receipts, limits |

## Operating Loom

| Document | Read it for |
|---|---|
| [Operations](operations.md) | Prerequisites, status, Run Directories, protected state, operating states and recovery |
| [Verification](verification.md) | The verification manifest, stop checks, owner verification, the distill pass, Acceptance Contracts and skeletons |
| [Standalone review](standalone-review.md) | The reviewer protocol, read coverage, standalone lineage, the plan design review, remediation |
| [Read-only helpers](reference/helpers.md) | The helpers that print what the engine knows |
| [Recovery operations](reference/recovery.md) | The commands that change protected state to recover a run: remediation, reopening a Task or a completed Wave, upgrading or amending the spec trace |
| [Model profiles and calibration](model-profiles-and-calibration.md) | Model policy per Agent, emission route classes and qualification, the calibration corpus |

## Understanding and changing Loom

| Document | Read it for |
|---|---|
| [Architecture](architecture.md) | Layers, authority boundaries, persistence, and what the system does and does not guarantee |
| [Loom Agents](agents.md) | The inventory of Agent definitions |
| [Pi adapter](pi-adapter.md) | How the Pi adapter maps onto the engine; the checklist for adding shared behaviour |
| [Executable models: enforcement](executable-models-enforcement.md) | How the engine enforces a plan's lifecycle, invariant and contract declarations, and what it cannot see |
| [Guarded Skill Machines](../machines/README.md) | Per-agent phase machines, the evidence ledger and attribution |
| [Lint rules](../lint-rules/README.md) | Regex and programmatic rules, project configuration |
| [Development](development.md) | Validating a change to Loom, test hermeticity, the repository map |

- [`/loom` prompt layout](loom-prompt-decomposition.md) — what `commands/loom.md` holds, the four on-demand runbooks under `references/loom/`, and the tests that pin them.
- [Architecture Decision Records](adr/README.md) — why the system has its current shape, with each decision's status.
- `family-sites.baseline.json` — the recorded baseline of the family-site metric; see [Development](development.md).
- [`contexts/`](../CONTEXT-MAP.md) — the per-area glossaries listed by `CONTEXT-MAP.md`. The core vocabulary is the root [`CONTEXT.md`](../CONTEXT.md).

## Proposals and design notes

These are not descriptions of shipped behaviour.

- [Roadmap](roadmap.md) — unshipped proposals for deterministic verification and implementation, and where each shipped item is now documented.
- [Functional evaluator](design-functional-evaluator.md) — an unimplemented design note.

## Historical and evidence records

- [Transcript-driven orchestration automation](transcript-driven-orchestration-automation.md) — the discovery evidence and decision behind engine-owned orchestration.
- [Standalone successor native context and workload](standalone-successor-context.md) — the delivery contract and measured workload of successor review.
- [`probes/emission-qualification/`](../probes/emission-qualification/README.md) and [`probes/emission-readiness/`](../probes/emission-readiness/README.md) — frozen probe evidence for the Pi emission route.
- [`calibration/grammar-constrained-decoding/`](../calibration/grammar-constrained-decoding/README.md) — the emission calibration policy and its [window log](../calibration/grammar-constrained-decoding/WINDOWS.md).
- Files under `.claude/plans/`, `.claude/specs/` and `.claude/reviews/` are run evidence and historical plans. They are not part of the product documentation.

## Normative sources

When prose and code differ, use this precedence:

1. Parsed types, reducers, validators, and policy catalogs in `engine/src/core/`.
2. The orchestration façade and adapters in `engine/src/handlers/helpers/orchestration.ts` and `engine/src/orchestration/`.
3. User-facing runbooks in `commands/` and `skills/`.
4. Explanatory documents in `docs/` and the root README.
5. Historical plans, specs, transcripts, and review artifacts.

Tests pin important prose contracts (agent rosters, panel sizes/lenses, runbook commands, resource inventories), but documentation should still link to the executable source of truth instead of duplicating volatile details unnecessarily.
