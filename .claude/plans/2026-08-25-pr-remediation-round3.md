# Slice 3 Completion Oracle — PR Remediation Round 3

## Authority

- Reviewed HEAD: `8fd9029d54b53568111363137bc3c40f7e33f023`
- Review: `review-20260825T025405Z-deterministic-task-completion-oracle-final`
- Result digest: `373a4232420af795c66b20fd1bad6dc51d02134c727c75c1feb6d856c1a624c4`
- Surviving criticals: 4, unanimously upheld
- Refuted criticals: 0

## Mandatory criticals

1. Exact-attempt cumulative attribution uses only prior allowed paths plus parser paths whose bytes actually changed this attempt. A parser-reported no-op path cannot credit older proof bytes.
2. A modern Claude attempt with no resolvable transcript settles exact infrastructure-unavailable before complete-transcript parsing. Empty transcript is not valid modern completion authority.
3. Claude transcript content blocks use an explicit supported discriminant allowlist. Surplus fields within supported arms remain forward-compatible; unknown/misspelled block types fail closed. Move Claude-specific integrity parsing to a dedicated core anti-corruption module rather than the harness-neutral Oracle module.
4. Any Agent whose Guarded Skill Machine exists but whose Agent ID is missing/invalid blocks at SubagentStart. No machine-bearing role may run ungated on a swallowed stderr warning.

## Advisory dispositions

### Accepted

- Surface stale-cleanup diagnostics in SessionStart `systemMessage` while retaining best-effort cleanup.
- Add `store-test-evidence` regression proving revalidation-required Task evidence is untouched.
- Move pure evidence precedence and machine-completion capping rules from the Claude handler into neutral `core/implementation-evidence.ts`.
- Reduce Oracle seam coupling by moving Claude transcript integrity into `core/claude-transcript-integrity.ts`; defer further authority/suite/receipt physical splitting until a consumer-driven module checkpoint.
- Reuse the parsed attempt baseline from exact comparison; remove impossible reparsing throw.
- Return waiver evidence directly instead of sentinel empty diff and duplicate waiver classification.

### Deferred

- Wave advisory-status projection `null` redesign remains assigned to the planned atomic Wave Gate lifecycle/status interface slice.
- Further splitting of authority/suite/receipt internals is deferred until distinct external consumers earn those public seams; this round removes the actual transport-specific coupling.

## Constraints

- No Wave advisory-status projection work.
- No further authority/suite/receipt physical splitting.
- No Slice 4 retry or escalation dispatch.
- No Task/project subprocess was introduced into Task-local settlement.
- The working tree remains unstaged and uncommitted.

## Remediation outcome

Implemented all 4 surviving criticals and all 6 accepted advisory groups. Deferred items remain untouched. The remediation changes exactly 24 artifacts: 9 production TypeScript files, 13 test TypeScript files, 1 JSONL fixture, and this plan.

## Validation

Focused exact-attribution, missing-transcript, block allowlist, machine binding, stale-cleanup, evidence helper, and store-test regressions; typecheck/unused; full-tier lint; bounded full suite; all smoke gates; diff check; registered remediation; final rereview; PR.

## Final validation — 2026-08-25

1. Focused attribution/integrity/Claude/Pi/machine/evidence/stale-cleanup/store-test set: **14 files passed; 268 tests passed; 0 failed**.
2. Bounded full unit suite (`env -u PI_CODING_AGENT npm run test:unit`): **223 files passed; 5,500 tests passed; 1 skipped; 0 failed**.
3. Smoke suite (`env -u PI_CODING_AGENT npm run test:smoke`): **all gates passed** — panel mode 22/22, review panel 19/19, standalone review PASS, orchestration façades PASS, Pi resources PASS, validate-task-graph 23/23.
4. TypeScript (`npm run typecheck`): **PASS**, including the unused-local/parameter check. Standalone `npm run typecheck:unused`: **PASS**.
5. Full-tier lint over every changed production TypeScript file: **9 passed, 0 failed**.
6. Claude integrity property/examples: all 6 explicit supported block discriminants, real fallback variant, supported-arm surplus fields, empty transcript, unknown/misspelled types, malformed arms, and arbitrary unknown input: **PASS**.
7. Exact production settlement regressions: missing transcript, malformed tail/records, and unknown/misspelled blocks all produce non-consuming infrastructure receipts and never implementation: **PASS**.
8. Exact cumulative attribution: prior allowed paths plus exact-attempt changed parser paths only; no-op parser paths credit no older Proof bytes across Claude/Pi: **PASS**.
9. Guarded Skill Machine admission: missing/invalid Agent ID blocks before roster, binding, sidecar, or task-graph-pointer capability publication: **PASS**.
10. Distill apply-mode: one altitude rename applied after a green baseline; mandated duplicate baseline parse and waiver sentinel removed; no deferred seam split attempted; covering tests remained green.
11. `git diff --check`: **PASS**.
