# PR Remediation Round 9 — deterministic Task completion authority

## Immutable review authority

- Source run: `review-20260828T082440Z-deterministic-task-completion-oracle-post-remediation-13`
- Reviewed revision: `33e332aa8fc940ebc30b9fe1aa25500863ebda7d`
- Result digest: `930fa161f4cb17331e3f17716433be84bd23895e3bd0d6f2c232a7b08ab1fafb`
- Frozen scope: the 142 paths recorded in the source result.

## Mandatory critical remediation

1. Keep the freshly observed repository baseline separate from the retained unresolved-change baseline. Use the fresh observation to decide whether stale-attempt evidence can survive, while preserving the retained baseline for exact-attempt settlement continuity.
2. Make SubagentStop TaskGraph-resolution failures errors for known Loom categories and unnameable agents. Preserve passthrough only for explicitly named unknown/custom agents.
3. Make direct `advance-phase` settlement failures return hook errors: TaskGraph authority, state reads, transcript reads, artifact persistence/discovery, and transition persistence. Keep passthrough only for legitimate no-transition/already-advanced outcomes.
4. Correct evidence-ledger documentation: corrupt/torn evidence fails closed; malformed binding rows are separately logged/skipped while keeping the binding file armed.
5. Correct harness-reported identity documentation to name `reportedRosterAgentId`, the helper that maps reserved grant-shaped reports to a non-authorizing placeholder.

## Regression obligations

- Abandoned modern attempt writes an undeclared repository path; replacement registration invalidates prior review/test/spec/Wave authority.
- Known Loom stop with absent or unreadable TaskGraph returns `error`; a named custom agent remains passthrough.
- Direct phase handler returns `error` for unavailable TaskGraph and transcript/artifact/transition failures.
- Existing exact-baseline preservation, malformed payload, and cleanup aggregation behavior remains green.

## Advisory disposition

- Fix the adjacent ledger comment inconsistency in this remediation.
- Grouped stale-cleanup and `env --null` test comments are documentation-only and may be corrected if they require no behavior churn.
- Pure config extraction, named StateManager aggregate commands, Wave Gate module decomposition, and pure Pi spawn-correlation planning are deferred as independent architecture slices.
- `findLast`, retry-task literal consolidation, and frozen JSON-byte helper are deferred behavior-preserving cleanups; this authority remediation minimizes unrelated production changes.

## Validation and release

1. Focused registration, dispatch, phase, machine-ledger, and evidence tests.
2. Typecheck and unused-symbol check.
3. Full bounded Vitest suite (`--maxWorkers=4 --minWorkers=1`).
4. Smoke suite, changed-production lint, and `git diff --check`.
5. Register immutable support paths and install the exact verified index.
6. Commit and push without force.
7. Run a fresh canonical standalone review and three-lens refutation; do not open a PR while any critical survives.
