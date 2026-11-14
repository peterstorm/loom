# Architecture Decision Records

One row per file in this directory. An ADR records why the system has its current shape; current behaviour is described in the documents the [documentation index](../README.md) lists.

**Writing a new ADR.** Start from [`references/adr-template.md`](../../references/adr-template.md).

- **Size.** Target 6KB; the hard cap is 10KB.
- **Status.** One line: a word from the template's vocabulary plus a date.
- **Changing a decision.** Write a new ADR that supersedes the old one, and add the one line "Superseded by ADR-NNNN" to the old one's Status. Do not amend the old ADR in place.
- **What stays out.** Implementation notes, review-round history, test counts and digests belong in the PR or the plan.

ADRs written before this norm (2026-11-12) are historical records and stay as they are, whatever their length.

The table is derived from the files: the title is the ADR's H1, the status is the leading word or phrase of its Status section (with the date when the ADR gives one), and the last column lists the ADRs that Status section says it amends, supersedes or resolves. No ADR in this directory is marked superseded; decisions have been changed by amendment. `engine/tests/docs/adr-index.test.ts` fails when a file is missing from the table or a row's status no longer matches its ADR.

| ADR | Decision | Status | Relation stated in Status |
|---|---|---|---|
| [ADR-0001](ADR-0001-linter-module-within-engine.md) | Linter as Module within Engine | Accepted | — |
| [ADR-0002](ADR-0002-defense-in-depth-redos-protection.md) | Defense-in-Depth ReDoS Protection | Accepted | — |
| [ADR-0003](ADR-0003-fail-closed-error-handling.md) | Fail-Closed Error Handling | Accepted | — |
| [ADR-0004](ADR-0004-engine-owned-orchestration-automation.md) | Engine-Owned Orchestration Automation | Accepted | — |
| [ADR-0005](ADR-0005-per-program-facade-drivers.md) | Program façade drivers stay per-program; no shared driver framework | Accepted | — |
| [ADR-0006](ADR-0006-lc1-reaches-production-by-projection.md) | LC-1 reaches production by projection, not by checkpoint | Accepted | — |
| [ADR-0007](ADR-0007-curated-public-surface.md) | A facade publishes a curated Public Surface, not the union of its volumes | Accepted | — |
| [ADR-0008](ADR-0008-versioned-defect-family-installation-authority.md) | Version Defect-Family evidence at the verified-index installation seam | Accepted | — |
| [ADR-0009](ADR-0009-versioned-reviewer-protocol.md) | Version reviewer evidence at issued protocol authority | Accepted (2026-09-10) | — |
| [ADR-0010](ADR-0010-standalone-finding-lineage.md) | Explicit standalone Finding and disposition lineage | Accepted (2026-09-10) | — |
| [ADR-0011](ADR-0011-type-driven-fp-approach-and-panel-provenance.md) | Retain the selected type-driven FP approach and panel provenance | Accepted | — |
| [ADR-0012](ADR-0012-preferred-strict-sampling-with-exact-route-qualification.md) | Preferred strict sampling, with exact-route qualification | Accepted | — |
| [ADR-0013](ADR-0013-model-initiated-emission-terminating-success.md) | Model-initiated emission, terminating success | Accepted | — |
| [ADR-0014](ADR-0014-child-readiness-is-a-launcher-barrier-not-a-notification.md) | Child readiness is a launcher barrier, not a notification | Accepted | — |
| [ADR-0015](ADR-0015-one-frozen-schema-explicit-limits-on-its-guarantees.md) | One frozen schema; explicit limits on its guarantees | Accepted | — |
| [ADR-0016](ADR-0016-all-three-producer-kinds-remain-in-scope.md) | All three producer kinds remain in scope | Accepted | — |
| [ADR-0017](ADR-0017-issuance-aware-instructions-and-honest-degraded-routes.md) | Issuance-aware instructions and honest degraded routes | Accepted | — |
| [ADR-0018](ADR-0018-one-observation-selection-decision-with-per-path-payload-construction.md) | One observation/selection decision with per-path payload construction | Accepted | — |
| [ADR-0019](ADR-0019-one-existing-request-slot-budget-no-same-spawn-correction-protocol.md) | One existing request-slot budget; no same-spawn correction protocol | Accepted | — |
| [ADR-0020](ADR-0020-acceptance-and-a-real-vertical-slice-before-breadth.md) | Acceptance and a real vertical slice before breadth | Accepted | — |
| [ADR-0021](ADR-0021-measure-useful-acceptance-not-only-syntactic-success.md) | Measure useful acceptance, not only syntactic success | Accepted | — |
| [ADR-0022](ADR-0022-engine-observed-standalone-read-coverage.md) | Admit a standalone reviewer only after the engine observed it read the whole frozen diff | Accepted | — |
| [ADR-0023](ADR-0023-pi-runs-local-only-and-releases-per-route.md) | Pi runs local models only, fails closed on an unreachable route, and releases emission per route | Accepted (2026-10-08) | — |
| [ADR-0024](ADR-0024-approach-1-facts-plus-two-pure-judges-behind-one-planner.md) | Approach 1: facts plus two pure judges behind one planner | Accepted | — |
| [ADR-0025](ADR-0025-the-i6-era-marker-is-the-frozen-test-file-classification.md) | The I6-era marker is the frozen test-file classification | Accepted | — |
| [ADR-0026](ADR-0026-i6-enters-proof-as-one-obligation-one-failure-variant-and-one-evidence-variant.md) | I6 enters proof as one obligation, one failure variant and one evidence variant | Accepted (2026-10-17) | — |
| [ADR-0027](ADR-0027-pi-ledger-capture-through-one-shared-minting-rule.md) | Pi ledger capture through one shared minting rule | Accepted (2026-10-17) | — |
| [ADR-0028](ADR-0028-one-stop-shell-runs-both-checks-sequence-lock-budget-and-counters.md) | One stop shell runs both checks: sequence, lock, budget and counters | Accepted (2026-10-17) | — |
| [ADR-0029](ADR-0029-program-durability-is-the-run-directory-journal.md) | Program durability is the Run Directory journal; Fugue leaves the engine | Accepted (2026-10-18) | amends ADR-0004 |
| [ADR-0030](ADR-0030-the-architecture-panel-has-one-durable-form.md) | The architecture panel has one durable form: the registered driver's journal | Accepted (2026-10-18) | resolves ADR-0029 |
| [ADR-0031](ADR-0031-owner-verification-is-an-engine-reserved-completion-suite-check.md) | Owner verification is an engine-reserved completion-suite check (approach B) | Accepted (2026-10-23) | — |
| [ADR-0032](ADR-0032-owner-obligations-stamped-at-population-gate-fails-closed-on-drift.md) | Owner Obligations are stamped at population; the gate re-reads the plan and fails closed on drift | Accepted (2026-10-23) | — |
| [ADR-0033](ADR-0033-exemption-grammar-one-field-two-new-problems.md) | Exemption grammar: one field, two new problems | Accepted (2026-10-23) | — |
| [ADR-0034](ADR-0034-family-scope-keeps-changesfamily-selection-has-one-owner.md) | Family scope keeps G5a's changesFamily; selection has one owner | Accepted (2026-10-23) | — |
| [ADR-0035](ADR-0035-sibling-coverage-is-direct-imports-closed-under-re-exports.md) | Sibling coverage is direct imports closed under re-exports | Accepted (2026-10-23) | — |
| [ADR-0036](ADR-0036-deterministic-mutation-plan-over-changed-owner-lines.md) | Deterministic mutation plan over changed owner lines | Accepted (2026-10-23) | — |
| [ADR-0037](ADR-0037-outcome-classification-reads-only-the-structured-report.md) | Outcome classification reads only the structured report | Accepted (2026-10-23) | — |
| [ADR-0038](ADR-0038-isolation-via-one-detached-worktree-per-invariant.md) | Isolation via one detached worktree per Invariant | Accepted (2026-10-23) | — |
| [ADR-0039](ADR-0039-the-second-copy-lens-is-an-engine-issued-packet-section.md) | The second-copy lens is an engine-issued packet section | Accepted (2026-10-23) | amended by ADR-0047 |
| [ADR-0040](ADR-0040-brief-duties-and-status-projection.md) | Brief duties and status projection | Accepted (2026-10-23) | — |
| [ADR-0041](ADR-0041-family-site-metric-one-pure-module-with-an-in-repo-baseline.md) | Family-site metric as one pure module with an in-repo baseline | Accepted (2026-10-23) | — |
| [ADR-0042](ADR-0042-the-typescript-compiler-api-enters-through-two-pure-seams.md) | The TypeScript compiler API enters through two pure seams | Accepted (2026-10-23) | — |
| [ADR-0043](ADR-0043-the-pure-core-is-enforced-by-the-purity-linter.md) | The pure core is enforced by the purity linter, not a project regex rule | Accepted (2026-10-23) | — |
| [ADR-0044](ADR-0044-the-acceptance-freeze-is-stamped-by-the-completion-commit.md) | The Acceptance Freeze is stamped by the completion commit, not at receipt installation | Accepted (2026-10-25) | — |
| [ADR-0045](ADR-0045-an-implemented-task-is-reopened-through-one-engine-operation.md) | An implemented Task is reopened through one engine operation that reuses the Contract Revision transition | Accepted (2026-10-25) | — |
| [ADR-0046](ADR-0046-the-direct-edit-guard-protects-only-the-orchestrated-repository.md) | The direct-edit guard protects only the Orchestrated Repository | Accepted (2026-10-25) | — |
| [ADR-0047](ADR-0047-the-wave-review-roster-is-derived-per-task-from-owner-map-presence.md) | The Wave review roster is derived per Task from owner-map presence | Accepted (2026-10-25) | amends ADR-0039 |
| [ADR-0048](ADR-0048-skeletons-materialize-per-task-inside-the-shared-spawn-reservation.md) | Skeletons materialize per Task inside the shared spawn reservation | Accepted (2026-11-07) | — |
| [ADR-0049](ADR-0049-skeletons-freeze-only-consumer-facing-signatures-and-adts.md) | Skeletons freeze only consumer-facing signatures and ADTs | Accepted (2026-11-07) | — |
| [ADR-0050](ADR-0050-binding-grammar-contract-qualified-export-bindings-list.md) | Binding grammar as a contract-qualified Export bindings list in File Structure | Accepted (2026-11-07) | — |
| [ADR-0051](ADR-0051-persistence-bindings-stamped-skeleton-records-content-addressed.md) | Export bindings are stamped at population, skeleton records carry engine digests, and an untouched skeleton is recognized by content | Accepted (2026-11-07) | — |
| [ADR-0052](ADR-0052-completion-refusals-ride-declared-artifact-changed.md) | Completion refusals ride the existing declared-artifact-changed obligation | Accepted (2026-11-07) | — |
| [ADR-0053](ADR-0053-typescript-surface-third-parse-only-compiler-seam.md) | TypeScript enters through a third parse-only compiler seam | Accepted (2026-11-07) | amends ADR-0042 |
| [ADR-0054](ADR-0054-java-restricted-lexer-frozen-holder-and-static-final-constant.md) | Java restricted lexer, frozen holder shape and typed static final constant per binding | Accepted (2026-11-07) | — |
| [ADR-0055](ADR-0055-canonical-skeleton-bytes-deterministic-and-unformatted.md) | Canonical skeleton bytes are deterministic and unformatted | Accepted (2026-11-07) | — |
| [ADR-0056](ADR-0056-contract-stubs-at-the-contract-task-stop.md) | Contract stubs are written at the contract Task's SubagentStop | Accepted (2026-11-07) | — |
| [ADR-0057](ADR-0057-contract-revision-refreshes-only-untouched-skeletons.md) | Contract Revision refreshes only untouched skeletons | Accepted (2026-11-07) | — |
| [ADR-0058](ADR-0058-conformance-rules-syntactic-all-violations-listed.md) | Conformance rules are syntactic, list all violations and are scoped by production file and contract | Accepted (2026-11-07) | — |
| [ADR-0059](ADR-0059-one-no-clobber-writer-behind-fixed-write-rules.md) | One no-clobber writer behind fixed write rules | Accepted (2026-11-07) | — |
| [ADR-0060](ADR-0060-one-skeleton-outcome-derivation-shown-in-brief-and-status.md) | One skeleton-outcome derivation shown in brief and status | Accepted (2026-11-07) | — |
| [ADR-0061](ADR-0061-one-supported-language-predicate-parsed-into-skeleton-target.md) | One supported-language predicate, parsed once into a SkeletonTarget | Accepted (2026-11-07) | — |
| [ADR-0062](ADR-0062-pure-core-domainresult-end-to-end-simplicity-axis.md) | Pure core, DomainResult end to end, simplicity axis | Accepted (2026-11-07) | amended by ADR-0053, ADR-0043 |
| [ADR-0063](ADR-0063-owner-verification-follows-the-family-schedule.md) | Owner verification follows the family schedule | Accepted (2026-11-03) | amends ADR-0034, ADR-0035 |
| [ADR-0064](ADR-0064-bun-reports-file-identity-and-console-collection-errors.md) | Bun reports — file identity from the `file` attribute, collection errors from the console | Accepted (2026-11-09) | — |
| [ADR-0065](ADR-0065-manifest-helper-compares-authority-and-replaces-before-population.md) | The manifest helper compares authority, not bytes, and replaces it only before population | Accepted (2026-11-10) | — |
| [ADR-0066](ADR-0066-security-audit-is-a-registered-program.md) | Security audit is a registered program, not a skill-side workflow | Accepted (2026-11-07) | — |
| [ADR-0067](ADR-0067-security-ballots-are-bound-to-issued-verifier-spawns.md) | Security ballots are bound to issued verifier spawns | Accepted (2026-11-09) | amends ADR-0066 |
| [ADR-0068](ADR-0068-the-distill-pass-is-an-engine-added-task-per-wave.md) | The distill pass is an engine-added Task per Wave | Accepted (2026-11-11) | — |
| [ADR-0069](ADR-0069-the-contract-task-wave-review-judges-the-contract-surface.md) | The Contract Task's Wave review judges the contract surface | Accepted (2026-11-12) | — |
| [ADR-0070](ADR-0070-the-plan-design-review-gates-decompose.md) | The plan design review gates decompose | Accepted (2026-11-12) | — |
| [ADR-0071](ADR-0071-the-task-mutation-check-names-surviving-mutants-before-the-stop.md) | The Task mutation check names surviving mutants before the stop | Accepted (2026-11-12) | — |
| [ADR-0072](ADR-0072-wire-output-typed-without-a-parse-is-refused-at-the-edit.md) | Wire output typed without a parse is refused at the edit | Accepted (2026-11-12) | — |
| [ADR-0073](ADR-0073-every-documented-wire-example-is-parsed-by-its-production-parser.md) | Every documented wire example is parsed by its production parser | Accepted (2026-11-12) | — |
| [ADR-0074](ADR-0074-every-doc-reference-resolves-against-the-project.md) | Every doc reference resolves against the project | Accepted (2026-11-14) | — |
