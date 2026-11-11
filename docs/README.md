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
| [Running a security audit](security-audit.md) | Security auditors | The registered `security-audit` program: the authoritative operations table, owner ids, run directory, blockers, sandbox receipts, handoff, calibration, honest limits |
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

- [ADR-0001: Linter as Module within Engine](adr/ADR-0001-linter-module-within-engine.md)
- [ADR-0002: Defense-in-Depth ReDoS Protection](adr/ADR-0002-defense-in-depth-redos-protection.md)
- [ADR-0003: Fail-Closed Error Handling](adr/ADR-0003-fail-closed-error-handling.md)
- [ADR-0004: Engine-Owned Orchestration Automation](adr/ADR-0004-engine-owned-orchestration-automation.md)
- [ADR-0005: Program façade drivers stay per-program; no shared driver framework](adr/ADR-0005-per-program-facade-drivers.md)
- [ADR-0006: LC-1 reaches production by projection, not by checkpoint](adr/ADR-0006-lc1-reaches-production-by-projection.md)
- [ADR-0007: A facade publishes a curated Public Surface, not the union of its volumes](adr/ADR-0007-curated-public-surface.md)
- [ADR-0008: Version Defect-Family evidence at the verified-index installation seam](adr/ADR-0008-versioned-defect-family-installation-authority.md)
- [ADR-0009: Version reviewer evidence at issued protocol authority](adr/ADR-0009-versioned-reviewer-protocol.md)
- [ADR-0010: Explicit standalone Finding and disposition lineage](adr/ADR-0010-standalone-finding-lineage.md)
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
- [ADR-0023: Pi runs local models only, fails closed on an unreachable route, and releases emission per route](adr/ADR-0023-pi-runs-local-only-and-releases-per-route.md)
- [ADR-0024: Approach 1: facts plus two pure judges behind one planner](adr/ADR-0024-approach-1-facts-plus-two-pure-judges-behind-one-planner.md)
- [ADR-0025: The I6-era marker is the frozen test-file classification](adr/ADR-0025-the-i6-era-marker-is-the-frozen-test-file-classification.md)
- [ADR-0026: I6 enters proof as one obligation, one failure variant and one evidence variant](adr/ADR-0026-i6-enters-proof-as-one-obligation-one-failure-variant-and-one-evidence-variant.md)
- [ADR-0027: Pi ledger capture through one shared minting rule](adr/ADR-0027-pi-ledger-capture-through-one-shared-minting-rule.md)
- [ADR-0028: One stop shell runs both checks: sequence, lock, budget and counters](adr/ADR-0028-one-stop-shell-runs-both-checks-sequence-lock-budget-and-counters.md)
- [ADR-0029: Program durability is the Run Directory journal; Fugue leaves the engine](adr/ADR-0029-program-durability-is-the-run-directory-journal.md)
- [ADR-0030: The architecture panel has one durable form: the registered driver's journal](adr/ADR-0030-the-architecture-panel-has-one-durable-form.md)
- [ADR-0031: Owner verification is an engine-reserved completion-suite check (approach B)](adr/ADR-0031-owner-verification-is-an-engine-reserved-completion-suite-check.md)
- [ADR-0032: Owner Obligations are stamped at population; the gate re-reads the plan and fails closed on drift](adr/ADR-0032-owner-obligations-stamped-at-population-gate-fails-closed-on-drift.md)
- [ADR-0033: Exemption grammar: one field, two new problems](adr/ADR-0033-exemption-grammar-one-field-two-new-problems.md)
- [ADR-0034: Family scope keeps G5a's changesFamily; selection has one owner](adr/ADR-0034-family-scope-keeps-changesfamily-selection-has-one-owner.md)
- [ADR-0035: Sibling coverage is direct imports closed under re-exports](adr/ADR-0035-sibling-coverage-is-direct-imports-closed-under-re-exports.md)
- [ADR-0036: Deterministic mutation plan over changed owner lines](adr/ADR-0036-deterministic-mutation-plan-over-changed-owner-lines.md)
- [ADR-0037: Outcome classification reads only the structured report](adr/ADR-0037-outcome-classification-reads-only-the-structured-report.md)
- [ADR-0038: Isolation via one detached worktree per Invariant](adr/ADR-0038-isolation-via-one-detached-worktree-per-invariant.md)
- [ADR-0039: The second-copy lens is an engine-issued packet section](adr/ADR-0039-the-second-copy-lens-is-an-engine-issued-packet-section.md)
- [ADR-0040: Brief duties and status projection](adr/ADR-0040-brief-duties-and-status-projection.md)
- [ADR-0041: Family-site metric as one pure module with an in-repo baseline](adr/ADR-0041-family-site-metric-one-pure-module-with-an-in-repo-baseline.md)
- [ADR-0042: The TypeScript compiler API enters through two pure seams](adr/ADR-0042-the-typescript-compiler-api-enters-through-two-pure-seams.md)
- [ADR-0043: The pure core is enforced by the purity linter, not a project regex rule](adr/ADR-0043-the-pure-core-is-enforced-by-the-purity-linter.md)
- [ADR-0044: The Acceptance Freeze is stamped by the completion commit, not at receipt installation](adr/ADR-0044-the-acceptance-freeze-is-stamped-by-the-completion-commit.md)
- [ADR-0045: An implemented Task is reopened through one engine operation that reuses the Contract Revision transition](adr/ADR-0045-an-implemented-task-is-reopened-through-one-engine-operation.md)
- [ADR-0046: The direct-edit guard protects only the Orchestrated Repository](adr/ADR-0046-the-direct-edit-guard-protects-only-the-orchestrated-repository.md)
- [ADR-0047: The Wave review roster is derived per Task from owner-map presence](adr/ADR-0047-the-wave-review-roster-is-derived-per-task-from-owner-map-presence.md)
- [ADR-0048: Skeletons materialize per Task inside the shared spawn reservation](adr/ADR-0048-skeletons-materialize-per-task-inside-the-shared-spawn-reservation.md)
- [ADR-0049: Skeletons freeze only consumer-facing signatures and ADTs](adr/ADR-0049-skeletons-freeze-only-consumer-facing-signatures-and-adts.md)
- [ADR-0050: Binding grammar as a contract-qualified Export bindings list in File Structure](adr/ADR-0050-binding-grammar-contract-qualified-export-bindings-list.md)
- [ADR-0051: Export bindings are stamped at population, skeleton records carry engine digests, and an untouched skeleton is recognized by content](adr/ADR-0051-persistence-bindings-stamped-skeleton-records-content-addressed.md)
- [ADR-0052: Completion refusals ride the existing declared-artifact-changed obligation](adr/ADR-0052-completion-refusals-ride-declared-artifact-changed.md)
- [ADR-0053: TypeScript enters through a third parse-only compiler seam](adr/ADR-0053-typescript-surface-third-parse-only-compiler-seam.md)
- [ADR-0054: Java restricted lexer, frozen holder shape and typed static final constant per binding](adr/ADR-0054-java-restricted-lexer-frozen-holder-and-static-final-constant.md)
- [ADR-0055: Canonical skeleton bytes are deterministic and unformatted](adr/ADR-0055-canonical-skeleton-bytes-deterministic-and-unformatted.md)
- [ADR-0056: Contract stubs are written at the contract Task's SubagentStop](adr/ADR-0056-contract-stubs-at-the-contract-task-stop.md)
- [ADR-0057: Contract Revision refreshes only untouched skeletons](adr/ADR-0057-contract-revision-refreshes-only-untouched-skeletons.md)
- [ADR-0058: Conformance rules are syntactic, list all violations and are scoped by production file and contract](adr/ADR-0058-conformance-rules-syntactic-all-violations-listed.md)
- [ADR-0059: One no-clobber writer behind fixed write rules](adr/ADR-0059-one-no-clobber-writer-behind-fixed-write-rules.md)
- [ADR-0060: One skeleton-outcome derivation shown in brief and status](adr/ADR-0060-one-skeleton-outcome-derivation-shown-in-brief-and-status.md)
- [ADR-0061: One supported-language predicate, parsed once into a SkeletonTarget](adr/ADR-0061-one-supported-language-predicate-parsed-into-skeleton-target.md)
- [ADR-0062: Pure core, DomainResult end to end, simplicity axis](adr/ADR-0062-pure-core-domainresult-end-to-end-simplicity-axis.md)
- [ADR-0063: Owner verification follows the family schedule](adr/ADR-0063-owner-verification-follows-the-family-schedule.md)
- [ADR-0064: Bun reports — file identity from the `file` attribute, collection errors from the console](adr/ADR-0064-bun-reports-file-identity-and-console-collection-errors.md)
- [ADR-0066: Security audit is a registered program, not a skill-side workflow](adr/ADR-0066-security-audit-is-a-registered-program.md)
- [ADR-0067: Security ballots are bound to issued verifier spawns](adr/ADR-0067-security-ballots-are-bound-to-issued-verifier-spawns.md)
- [ADR-0068: The distill pass is an engine-added Task per Wave](adr/ADR-0068-the-distill-pass-is-an-engine-added-task-per-wave.md)

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
