# PR Remediation Round 8 — feat/grammar-constrained-decoding (PR #59)

**Branch:** `feat/grammar-constrained-decoding` (HEAD at review: `6f4a1452`, PR #59, base `main` @ `3ff10118`)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-fix-20260924T115711Z-6f4a1452`
**Review scope (frozen):** 65 paths — the PR diff `git diff 3ff10118...6f4a1452` (grammar wave-1 work, the main merge resolutions, and the CI arming fix).
**Reviewer waves:** 3+3+1 (code-reviewer, silent-failure-hunter, pr-test-analyzer / type-design-analyzer, comment-analyzer, architecture-tech-lead / code-simplifier). 7/7 captured, 0 rejected.

## Result of record

- Emitted/admitted: **0 critical; 32 advisory. After refutation: 0 surviving critical; 0 refuted critical; 32 advisory.**
- Canonical `result.json` digest: `47c6ce03c934f71a53912141bc31d830ed94c0f1eeb4b2c80584ff19dc7e18ad` (112,389 bytes).
- No Refutation Panel was routed (zero non-empty critical sets).

## Surviving-critical dispositions

None — zero surviving criticals. No Declared Repair Groups, no selected operator checks, no Historical RED declarations.

## Advisory dispositions (parent policy, published)

Published via the engine's no-agent P5 publisher **before** implementation:

- **Policy Run Directory:** `.claude/reviews/review-and-fix-runs/policy-20260924T123223Z-r8`
- **Publication:** `artifacts/disposition.json`, schemaVersion 1, `revision: {"kind":"initial"}`, 32 entries — **28 accepted / 4 deferred / 0 dismissed**.
- **Receipt:** `effect:standalone-disposition:4822cf936875472d0712749af2d54122299dd0131581d5735df56b858dd54463.json`
- Source locator/runId/resultDigest copied unchanged from `inspect --lineage` (`47c6ce03…`).

### Accepted (28) — fixes to implement

1. `code-reviewer-1` — feasibility.md §2.4/§2.5 conformity wording corrected; discrepancy named under §2.6 (006/011 string-typed forced-call args).
2. `code-reviewer-2` — gen-fixtures.mts violation detector hardened: shape-check emitted args against the frozen schema, not key presence.
3. `code-reviewer-3` — feasibility §2.3: 003-wire-params.json relabeled as v3 frozen bytes (byte-identity claimed for v3).
4. `code-reviewer-4` — emission-ingestion.ts header: enforcement claim corrected to state the invariant without the false linter attribution.
5. `silent-failure-hunter-1` — Claude handler `panelWriteTargetPaths`: announce the Git-probe cause on stderr before failing closed (mirror activeRosterProbe).
6. `silent-failure-hunter-2` — Pi `panelGuardTargets`: same cause announcement, same convention.
7. `silent-failure-hunter-3` — probe.mjs upstream-error arm records infrastructure unavailability, never route-verdict vocabulary.
8. `silent-failure-hunter-4` — probe.mjs watcher interval cleared in a finally block; errored runs exit after reporting.
9. `silent-failure-hunter-5` — probe.mjs re-runs stage analysis over final records before writing the report (kills the attachment race class).
10. `pr-test-analyzer-1` — export Pi `panelGuardTargets`; executable pins: in-scope admit, outside-repo block, unresolvable-root fail-closed.
11. `pr-test-analyzer-2` — emission-tool mint: typed refusal for out-of-vocabulary kind + negative matrix case.
12. `pr-test-analyzer-3` — panel-judge profile uniqueness asserted (implemented as the load-time assertion below).
13. `type-design-analyzer-1` — split the extraction arm: extraction-verbatim (no refusal field) vs extraction-over-refused (REQUIRED refusal).
14. `type-design-analyzer-2` — `EmissionToolSpec.schemaVersions` keyed by the closed `EmissionSchemaVersion` vocabulary.
15. `type-design-analyzer-3` — load-time module assertion: exactly one catalog agent carries the panel-judge profile.
16. `comment-analyzer-1` — EmissionParseFailureCode doc provenance corrected (invalid-schema minted by verdict parsers; invalid-json subsumed).
17. `comment-analyzer-2` — JUDGE_VERDICT_SCHEMA_V1 comment: drop the enum claim the bytes do not carry.
18. `comment-analyzer-3` — model-profiles comment: implementation profile binds six (seven is the impl kind).
19. `comment-analyzer-4` — EmissionToolCapability doc: design-intent wording; "revision proof" defined/pointed, distinct from FR-008.
20. `comment-analyzer-5` — feasibility §2.5: FR-018 → FR-012 (dangling citation).
21. `comment-analyzer-6` — probes README:44: same citation fix.
22. `architecture-tech-lead-1` — verdictArgsParser refusal aggregates the bounded schema-issue set at the single minting point.
23. `architecture-tech-lead-3` — `shouldBlockDirectEdit` requires the `taskGraphExists` port (default removed); callers/tests updated.
24. `code-simplifier-1` — observeEmissionCalls: Map alone (first-observed order); parallel array deleted.
25. `code-simplifier-2` — one shared locked-review-evidence reducer parameterized by `resolutionFor`.
26. `code-simplifier-3` — artifact-write-scope: one phase→scope map; writer set derived from keys.
27. `code-simplifier-4` — ELOOP roster test cases: shared fixture; second case keeps only its distinguishing regex assertion.
28. `code-simplifier-5` — one shared write-target key projection for pi/extension.ts + pi/subagent-result.ts.

### Deferred (4) — no code change, reason retained in the published record

1. `type-design-analyzer-4` — marker branding through identity parsers: threads branded types across the spawn/result boundary that T6/T7 rewire; field-to-field comparisons against issued authority are correct at head.
2. `architecture-tech-lead-2` — catalog-declared producer kinds + validation: deeper redesign of the scoping seam, lands with the T6/T7 emission wiring; load-time assertion (13) is the interim impossibility.
3. `architecture-tech-lead-4` — structural tool_call guard attribution: live-shell refactor deserving its own task with dedicated review; all present steps stamp correctly.
4. `code-simplifier-6` — probe bus/sleep dedup: committed evidence scripts are referenced by exact commands; share the bus at wave 4 (T4) per the finding's own prescription.

## Refuted-finding audit

None — zero findings were refuted; the refutation panel was not routed.

## Defect family

`defectFamily: {"kind":"not-required"}` — zero surviving criticals.

## Support paths (remediation start input)

- `.claude/plans/2026-09-24-pr-remediation-round-8.md` (this plan; outside review scope)

## Validation

- `npm run verify` (engine): typecheck + lint + full Vitest + six smoke checks; must be green with a fresh `.loom/completion-reports/verify.junit.xml`.
- CI (PR #59): both `verify` legs (ubuntu-24.04, macos-15) must pass after push.

## Execution notes

- Engine mutations ran in operator-approved standalone mode (`env -u PI_CODING_AGENT`) anchored at the grammar worktree; reviewer spawns/capture flowed through the main-rooted Pi runtime with cwd = grammar worktree, and the session-run binding was registered via the engine's own `registerSessionRunBinding` writer.
- Remediation edits happen in this worktree on this branch; the verified index install and commit/push are engine-driven in the same mode.
