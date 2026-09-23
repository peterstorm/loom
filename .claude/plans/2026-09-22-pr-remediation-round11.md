# PR Remediation — Round 11

## Branch and scope

- Branch: `fix/abandoned-gate-terminal-outcome`
- Reviewed commit: `8b7a6361b88fd5f5333265b11e91fcec322a818d`
- Review kind: `all`
- Review scope: the exact frozen scope published by the Standalone Review Run; remediation may additionally touch only support paths declared at registered remediation start.
- Review Run Directory: `.claude/reviews/review-and-fix-runs/review-fix-20260922T191235Z-8b7a6361`
- Canonical result digest: `65b44b7c195eb0e65c5890e3cb1bf4804468dfc36aaf2bce7330a8d9872602b4`
- Inspection counts: 1 critical and 14 advisories emitted/admitted; after refutation, 1 surviving critical, 0 refuted criticals, and 14 advisories.

## Surviving-critical disposition

### `pr-test-analyzer-1` — repaired by `group.production-state-file-authority-regressions`

The custom-State-File regression test bypasses both production transport adapters, so reverting either adapter to ambient/default State File authority would leave the suite green.

- Status: `repaired`
- Declared Repair Group: `group.production-state-file-authority-regressions`
- Planned repair: add behavior-level regressions that enter both the Claude and Pi production adapter seams with a session-selected, in-repository custom State File and discriminate removal of exact path forwarding.

## Declared Repair Group

### `group.production-state-file-authority-regressions`

- Finding IDs: `pr-test-analyzer-1`
- Root cause — **DECLARED**: the prior regression asserted repository observation through the lower-level task-local helper, while settlement tests stubbed the observation seam and therefore never exercised either transport adapter's forwarding of the selected State File path.
- Invariant — **DECLARED**: every exact implementation settlement initiated by Claude or Pi supplies the session-selected authoritative State File path to repository observation; no ambient/default path may substitute for it.
- Sibling accounting — **DECLARED**:
  - `engine/tests/handlers/implementation-attempt-sidecar.test.ts`: `repaired`; the new behavior-level regression enters the Claude production adapter and discriminates exact custom State File forwarding.
  - `engine/tests/pi/subagent-result.test.ts`: `repaired`; the new behavior-level regression enters the Pi production adapter and discriminates exact custom State File forwarding.
- Selected fixed check: `project:verify`
- Historical RED — **DECLARED**: each new adapter-level assertion would fail if its production adapter stopped forwarding the custom State File path and reverted to ambient/default State File authority. No vulnerable historical snapshot execution is claimed.

## Advisory dispositions

1. `code-reviewer-1` — **accepted**. The required project boundary will be explicit across the in-scope Pi spec-check API and callers.
2. `silent-failure-hunter-1` — **accepted**. The ambient State File fallback will be removed by requiring exact store path authority.
3. `type-design-analyzer-1` — **accepted**. The document observation request will retain the parser-proven `TaskGraphProjectBoundary` rather than a bare string.
4. `type-design-analyzer-2` — **accepted**. `EscalationRemediationCommand.receipt` will be narrowed to `EscalationRemediatedSettlementReceipt`.
5. `type-design-analyzer-3` — **accepted**. The not-escalated error will retain the closed reachable retry-disposition union.
6. `comment-analyzer-1` — **accepted**. The abandonment tombstone comment will name successor supersession and explicit spec-trace retirement.
7. `comment-analyzer-2` — **accepted**. The retry comment will state that escalation is terminal only for automatic dispatch until explicit remediation.
8. `comment-analyzer-3` — **accepted**. Operations documentation will cover the protected-state stamp, completion-suite clearing, marker-only partial failure, and identical retry.
9. `comment-analyzer-4` — **accepted**. Findings-shape documentation will distinguish successful finalization from narrower incomplete-run retirement activation.
10. `architecture-tech-lead-1` — **deferred**. A unified live Wave Gate aggregate requires a persisted TaskGraph schema and transition migration; current parsing already rejects illegal combinations, so this should be a separately designed migration.
11. `architecture-tech-lead-2` — **accepted**. The Pi result environment will require parser-proven project and exact State File authority, eliminating ambient fallbacks and enabling production-seam tests.
12. `architecture-tech-lead-3` — **deferred**. Splitting repository observation from new-test policy is a cross-module interface redesign unrelated to the adapter authority defect; no divergent behavior was identified, so it needs a focused deepening with dedicated interface tests.
13. `architecture-tech-lead-4` — **deferred**. Extracting the TaskGraph codec and migrations from the approximately 2,400-line StateManager surface is a broad import/ownership migration with no identified current behavior defect and should be isolated behind its own green baseline.
14. `code-simplifier-1` — **accepted**. The behavior-identical completion-suite fixture will be centralized without weakening assertions.

No advisories were dismissed.

## Accepted-advisory implementation

- Replace optional Pi project/State File authority with required parser-proven inputs; update all production and test callers.
- Carry `TaskGraphProjectBoundary` through Wave spec-check document observation.
- Narrow implementation-lifecycle result and error types to reachable variants.
- Correct four lifecycle/operator comments and documents.
- Reuse one canonical accepted-completion-suite test fixture across both test modules.

## Refuted-critical audit

The canonical result contains no refuted critical findings. Nothing in this remediation is treated as refuted or repaired on that basis.

## Advisory policy publication

- Provenance: **DECLARED**
- Revision: initial
- Policy Run Directory: `.claude/reviews/review-and-fix-runs/policy-20260922T193000Z-8b7a6361`
- Publication digest: `66e48a45398a19fb88d550c2544f27901b11381b4f07012bddc2e630d5c54cbb`
- Complete ordered inventory: 11 accepted, 3 deferred, 0 dismissed.

## Planned support paths

The remediation start input will declare every touched path outside the frozen review scope, including:

- `.claude/plans/2026-09-22-pr-remediation-round11.md`
- any new shared test-fixture module created for the accepted completion-suite deduplication
- any new adapter-level regression test file, if the behavior-level tests cannot live in an existing reviewed test path

## Validation

Development validation (not registered evidence):

1. Run focused Vitest suites for Claude settlement, Pi settlement/spec-check, document observation, lifecycle types/behavior, StateManager, and orchestration helpers.
2. Run `cd engine && bun run typecheck`.
3. Run `npm run verify` from the repository root and require all checks and smokes to pass.
4. Run the mandatory `distill` apply-mode pass from a green baseline, one simplification move at a time, preserving interfaces and behavior.

Registered remediation evidence:

- Start a fresh schema-v2 remediation Run with exact support paths and `pr-test-analyzer-1` accounted once in `group.production-state-file-authority-regressions`.
- Execute selected fixed check `project:verify` under engine observation.
- Treat only the resulting check/report facts and index installation receipt as **ENGINE_OBSERVED**.
- Report the bounded outcome as `repair-checked`, never proven closure or a `ResolvedFinding`.
