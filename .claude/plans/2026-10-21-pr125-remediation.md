# PR #125 remediation

**Branch:** `feat/g4-repilot-ledger-epoch`

**Scope:** the PR's frozen diff, 10 files:
- the re-pilot plan;
- the ledger-epoch-view plan and spec;
- `docs/operations.md`;
- `engine/src/core/ledger-epoch-view.ts` and its test;
- `no-io-in-pure-modules.ts`;
- `engine/tests/scripts/ledger-epoch.test.ts`;
- `engine/tsconfig.json`;
- `scripts/ledger-epoch.ts`.

**Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261020-pr125`, result `2650a4bd…1420`. It captured 7 of 7 slots: 0 critical, 4 advisory, 0 refuted.

**Advisory policy:** `policy-20261020-pr125`, initial revision, disposition digest `b9ac8db0…68fb`, DECLARED.

## Surviving criticals

None. `defectFamily` is `{"kind":"not-required"}`.

## Refuted criticals

None.

## Advisory dispositions

| ID | Decision | Reason |
|---|---|---|
| type-design-analyzer-1 | dismissed | `LedgerEpochArguments` is the raw argv record. An operator can type `--agent` without `--type`, so that record has to be able to hold the half-set pair. `parseLedgerEpochQuery` is the parse step that refuses it, and its output union cannot represent it. |
| architecture-tech-lead-1 | accepted | Absent-versus-empty was split across `existsSync` and `readEvidence`, leaving a check-then-read window. It is now a typed boundary read in the engine. |
| architecture-tech-lead-2 | dismissed | The index refolds through `eventsForEpoch` on purpose, so its counts cannot disagree with I6 positions. Ledgers are small. The alternative would change settlement's I6 fold for a cost no one has observed. |
| code-simplifier-1 | accepted | Three assertions are implied by the exact positions assertion that follows them. |

## Accepted fixes

- **`engine/src/machine/ledger.ts`:**
  - new `EvidenceLedgerRead` (`absent` with a path, `refused` with a message, or `records`) and `readEvidenceLedger(sessionId)`;
  - `readEvidence` is re-expressed through it with an exhaustive switch. Its behavior and messages are unchanged, and the unreachable re-throw is gone.
- **`engine/src/machine/index.ts`:** exports `readEvidenceLedger` and `EvidenceLedgerRead`.
- **`scripts/ledger-epoch.ts`:**
  - `readLedger` matches on `readEvidenceLedger`, with no `existsSync` and no try/catch;
  - every refusal string and exit code is unchanged;
  - the header comment is updated.
- **`engine/tests/machine/ledger.test.ts`:** 5 new tests for the read outcome:
  - an absent ledger names its path and the read creates nothing;
  - an empty file is read as records, not as absent;
  - records come back in order;
  - a corrupt line gives a message equal to the one `readEvidence` throws;
  - an unreadable ledger (ELOOP) is refused.
- **`engine/tests/core/ledger-epoch-view.test.ts`:** the three redundant assertions are dropped, leaving the exact positions assertion.
- **`.claude/plans/2026-10-20-ledger-epoch-view.md`:** amendment notes on the missing-ledger decision and the shell flow.

## Support paths (outside the frozen scope)

- `engine/src/machine/ledger.ts`
- `engine/src/machine/index.ts`
- `engine/tests/machine/ledger.test.ts`
- `.claude/plans/2026-10-21-pr125-remediation.md`

## Validation

- `bun scripts/typecheck.ts` (engine): exit 0.
- Focused run of the four affected test files: `npx vitest run tests/machine/ledger.test.ts tests/scripts/ledger-epoch.test.ts tests/core/ledger-epoch-view.test.ts tests/linter/programmatic/machine-purity.test.ts`. 4 files, 712 passed.
- `npx vitest run` (engine): 551 files, 13,528 passed, 1 skipped.
