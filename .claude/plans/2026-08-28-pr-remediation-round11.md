# PR Remediation Round 11 — parsed Pi reserved-result arrival

## Immutable review authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Source run: `review-20260828T095612Z-deterministic-task-completion-oracle-post-remediation-15`
- Reviewed revision: `26db69eec02391988281b449915665a7148a71b3`
- Result digest: `642ac201bf212cfa65425dc68fed3a452b6a0f795c971d1b006d175f96f99851`
- Frozen scope: the 144 paths recorded in the source result.
- Surviving criticals: 1; refuted criticals: 0.

## Mandatory remediation

1. Make reserved-result arrival consume `PiSubagentResultEntry`, the same parsed envelope ADT used by downstream Pi result dispatch.
2. Treat missing or rejected positional entries as absent even when their raw object carried the expected `agent` string.
3. Preserve namespace normalization and positional slot identity for valid parsed envelopes.
4. Add direct pure regressions for every parser-rejected matching-agent envelope field: missing/non-string task, missing/non-number exit code, missing messages, and invalid optional stop reason.
5. Add Pi extension integration proof that a malformed matching reviewer envelope durably replaces prior review authority with `evidence_capture_failed`.

## Advisory disposition

- **Accepted — stale spec-check comment:** Correct the production and regression comments that claim absent spec-check data passes vacuously or refer to obsolete Wave Gate check 4. Current behavior fails generic missing evidence; `EVIDENCE_CAPTURE_FAILED` preserves the concrete capture cause.
- **Deferred — mixed phase-policy/config seam:** Sound, but splitting policy from runtime configuration is an independent architecture change beyond this evidence-loss remediation.
- **Deferred — TaskGraph parser/persistence split:** Sound, but a large module-boundary refactor with unrelated migration risk.
- **Deferred — Wave Gate public-surface decomposition:** Sound, but requires a focused deepening slice rather than an evidence-boundary patch.
- **Deferred — repeated agent-alias membership helper:** Small but unrelated cleanup; avoid widening a correctness remediation.
- **Deferred — duplicated smoke harness:** Sound cleanup, but extracting shared shell infrastructure is unrelated and should be independently reviewed.

## Validation and release

1. Focused reserved-result unit and Pi extension integration tests.
2. Typecheck and unused-symbol check.
3. Full bounded Vitest suite (`--maxWorkers=4 --minWorkers=1`).
4. Smoke suite, changed-production lint, and `git diff --check`.
5. Register the plan as the only support path and install the exact verified index.
6. Commit and push without force.
7. Run a fresh canonical standalone review and three-lens refutation; do not open a PR while any critical survives.
