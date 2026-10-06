# Loom documentation

This directory documents Loom 1.1 and P4 Reviewer Protocol v2 (merged `96153ed`, publication/reload verified). P5 standalone lineage is implemented on the feature worktree; final validation, registered review and publication remain pending. Existing P3 installation/report policy is unchanged. Operational command files under `commands/` and `skills/` remain the runbooks; their P5 bootstrap restrictions take precedence over new-feature examples.

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

## Reviewer protocol boundary

Fresh independent standalone/Wave registrations use one v2 JSON payload under independently issued
schema/rubric authority; counts/IDs and human summaries are engine-derived.
Critical basis is mandatory but not proof of truth or impact. Malformed current
evidence never becomes a synthetic Finding; the same panel/majority cannot refute
a true assertion merely because repair seems unimportant. Completed and unfinished
issued reviewer v1 runs keep original protocol/retry history and packet-first
archived instructions. Two lossless gzip goldens retain 90 exact logical files
(20,250,407 bytes; 3,395,759 stored bytes), checked against the unchanged inventory.
Semantic in-memory historical replay is separate from native disposable fixture
admission/P3 installation evidence. See [operations](operations.md#reviewer-protocol-v2).

## Standalone lineage boundary (P5)

P5 adds immediate no-agent immutable advisory publication and explicit schema-3
successor review. Parent policy remains DECLARED; exact published revisions, full
ordered origin coverage, whole-roster semantic resolution and evidence-bound
reopening retain original Findings/history. P3 uses actual active criticals and
refuses limited current critical coverage even when the active set is empty.
CLI/Claude/Pi capture, bounded context projection, durable receipts and current-only
Pi witnesses share the same authority. No review reuse, automatic predecessor,
branch join, similarity/severity override or formal planning feature is added.

**Bootstrap:** P5's own final registered review/remediation uses admitted main
runtime `sha256:086c472e4e913376c07d69f5116c9ad9655546e22c91e40d28cba9fdd795bc79`
and Skill 5.0.0 with existing Plan advisory triage—not the unsupported new publisher.
New P5 records may be published honestly after merge/publication/reload; never
retrofit source review or unset admission. See [exact operations and bounds](operations.md#standalone-lineage-p5)
and [ADR-0010](adr/ADR-0010-standalone-finding-lineage.md).

## P3 operating boundary

Critical remediation requires a **new** exact report after the engine removes the old ignored/untracked regular file using Linux no-follow, descriptor-relative unlink. Darwin fails before critical-check launch; zero-critical remediation and Wave behavior are unchanged. Reports are limited to **8 MiB / XML depth 128**; v2 journal reads, append reconciliation/new appends, and inspection to **12 MiB per encoded event / 64 MiB per encoded journal / 1024 records**. An operator-owned fixed command can still fabricate a valid new report: fresh structured observations are not semantic proof. See [Operations](operations.md#remediation-and-git-safety) for historical read-only receipts, checkpoint diagnostics, and runtime publication requirements. The earlier Skill 3.1 bootstrap is historical P3 context, not a P4 recipe. The user-approved 2026-09-09 idle follow-up now enrolls the unchanged root `project:verify` command with required report `.loom/completion-reports/verify.junit.xml`. The Git-ignored, untracked report contains only Vitest facts; whole-command normal zero exit additionally proves compiler and all six smoke success. Enrollment is not a completed live v2 run. See the [enrollment follow-up](../.claude/plans/2026-09-09-junit-verification-enrollment.md); historical P3 evidence is unchanged.

## Decisions

Architecture Decision Records preserve why the system has its current shape:

- [ADR-0001: Linter as a module within the engine](adr/ADR-0001-linter-module-within-engine.md)
- [ADR-0002: Defense-in-depth ReDoS protection](adr/ADR-0002-defense-in-depth-redos-protection.md)
- [ADR-0003: Fail-closed error handling](adr/ADR-0003-fail-closed-error-handling.md)
- [ADR-0004: Engine-owned orchestration automation](adr/ADR-0004-engine-owned-orchestration-automation.md)
- [ADR-0005: Per-program façade drivers](adr/ADR-0005-per-program-facade-drivers.md)
- [ADR-0006: LC-1 reaches production by projection](adr/ADR-0006-lc1-reaches-production-by-projection.md)
- [ADR-0007: Curated Public Surface](adr/ADR-0007-curated-public-surface.md)
- [ADR-0008: Versioned Defect-Family installation authority](adr/ADR-0008-versioned-defect-family-installation-authority.md)
- [ADR-0009: Versioned reviewer protocol](adr/ADR-0009-versioned-reviewer-protocol.md)
- [ADR-0010: Standalone Finding and disposition lineage](adr/ADR-0010-standalone-finding-lineage.md)
- [ADR-0011: Retain the selected type-driven FP approach and panel provenance](adr/ADR-0011-type-driven-fp-approach-and-panel-provenance.md)
- [ADR-0012: Preferred strict sampling, with exact-route qualification](adr/ADR-0012-preferred-strict-sampling-with-exact-route-qualification.md)
- [ADR-0013: Model-initiated emission, terminating success](adr/ADR-0013-model-initiated-emission-terminating-success.md)
- [ADR-0014: Child readiness is a launcher barrier, not a notification](adr/ADR-0014-child-readiness-is-a-launcher-barrier-not-a-notification.md)
- [ADR-0015: One frozen schema; explicit limits on its guarantees](adr/ADR-0015-one-frozen-schema-explicit-limits-on-its-guarantees.md)
- [ADR-0016: All three producer kinds remain in scope](adr/ADR-0016-all-three-producer-kinds-remain-in-scope.md)
- [ADR-0017: Issuance-aware instructions and honest degraded routes](adr/ADR-0017-issuance-aware-instructions-and-honest-degraded-routes.md)
- [ADR-0018: One observation/selection decision with per-path payload construction](adr/ADR-0018-one-observation-selection-decision-with-per-path-payload-construction.md)
- [ADR-0019: One existing request-slot budget; no same-spawn correction protocol](adr/ADR-0019-one-existing-request-slot-budget-no-same-spawn-correction-protocol.md)
- [ADR-0020: Acceptance and a real vertical slice before breadth](adr/ADR-0020-acceptance-and-a-real-vertical-slice-before-breadth.md)
- [ADR-0021: Measure useful acceptance, not only syntactic success](adr/ADR-0021-measure-useful-acceptance-not-only-syntactic-success.md)
- [ADR-0022: Admit a standalone reviewer only after the engine observed it read the whole frozen diff](adr/ADR-0022-engine-observed-standalone-read-coverage.md)

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
