# Loom documentation

This directory documents the shipped Loom 1.1 architecture. Operational command files under `commands/` and `skills/` remain the executable runbooks; these documents explain the system around them.

## Start here

| Document | Audience | Contents |
|---|---|---|
| [Project README](../README.md) | Everyone | Product overview, installation, quick start, capability map |
| [Architecture](architecture.md) | Contributors and operators | Layers, authority boundaries, state, reducers, adapters, persistence |
| [Workflows](workflows.md) | Users | Full `/loom` lifecycle, panels, Wave Gate, standalone review, remediation |
| [Operations](operations.md) | Operators and maintainers | Status, Run Directories, recovery, validation, development commands |
| [Model profiles and calibration](model-profiles-and-calibration.md) | Maintainers | Cross-harness model policy, generated Pi agents, calibration corpus |
| [Using Loom with Pi](pi-usage.md) | Pi users | Installation, resource rendering, write grants, harness limitations |
| [Deterministic core](deterministic-core.md) | Architects | Executable-model, evidence, lint, and fail-closed guarantees |
| [Guarded skill machines](../machines/README.md) | Engine contributors | Per-agent phase machines and evidence attribution |
| [Lint-rule authoring](../lint-rules/README.md) | Rule authors | Regex/programmatic rules and project configuration |

## Decisions

Architecture Decision Records preserve why the system has its current shape:

- [ADR-0001: Linter as a module within the engine](adr/ADR-0001-linter-module-within-engine.md)
- [ADR-0002: Defense-in-depth ReDoS protection](adr/ADR-0002-defense-in-depth-redos-protection.md)
- [ADR-0003: Fail-closed error handling](adr/ADR-0003-fail-closed-error-handling.md)
- [ADR-0004: Engine-owned orchestration automation](adr/ADR-0004-engine-owned-orchestration-automation.md)

## Harness and migration notes

- [Claude Code to Pi integration guide](migration-claude-code-to-pi.md) explains how the two adapters map onto one engine.
- [Pi Interactive Phase Transport](pi-phase-agent-interviews.md) documents the shipped parent-relayed RPC child, transport routing, safety boundaries, and tests.

## Design proposals

These documents evaluate possible future changes. They are not descriptions of shipped behavior or executable runbooks:

- [`/loom` prompt decomposition](loom-prompt-decomposition.md) — analysis and migration design for replacing the monolithic eager prompt with a compact dispatcher and mandatory just-in-time runbook references.
- [Deterministic implementation and verification](deterministic-implementation.md) — determinism ladder for replacing LLM review findings with machine-checkable gates (AST rules, architecture conformance, mutation testing, contracts, model checking) and for making the implementation phase itself deterministic (scaffolding, frozen types, compiler-in-the-loop, red-green proof obligations, SubagentStop gating).

## Historical design records

These explain how shipped architecture was derived; they are not current runbooks:

- [Transcript-driven orchestration automation](transcript-driven-orchestration-automation.md) — discovery evidence, decision, and shipped-result map.
- Files under `.claude/plans/`, `.claude/specs/`, and `.claude/reviews/` — run evidence and historical plans. They are intentionally not part of the product documentation set.

## Normative sources

When prose and code differ, use this precedence:

1. Parsed types, reducers, validators, and policy catalogs in `engine/src/core/`.
2. The orchestration façade and adapters in `engine/src/handlers/helpers/orchestration.ts` and `engine/src/orchestration/`.
3. User-facing runbooks in `commands/` and `skills/`.
4. Explanatory documents in `docs/` and the root README.
5. Historical plans, specs, transcripts, and review artifacts.

Tests pin important prose contracts (agent rosters, panel sizes/lenses, runbook commands, resource inventories), but documentation should still link to the executable source of truth instead of duplicating volatile details unnecessarily.
