# G1 follow-up: deepen the Acceptance Contract modules

Branch `refactor/g1-acceptance-deepen`, cut from the PR #84 head (`11379669`).
It collects the advisories PR #84's three review rounds deferred to a deepen
session. Behavior is unchanged: every move is a seam, owner or interface
change, and the existing suites are the oracle.

## Moves

1. **Split `core/acceptance-contract.ts` (~1,090 lines, ~40 exports)** into
   `core/acceptance-contract/` behind a curated `index.ts`, as
   `orchestration-contract/` already is:
   - `model.ts` — plan and persisted shapes, id grammars;
   - `tasks.ts` — derivation over Tasks: frozen paths, the one writer rule,
     claimants, due Waves, red window, contract roles, population;
   - `gate.ts` — testcase attribution, the Wave Gate expectation, report
     facts and RED/GREEN judgment;
   - `freeze.ts` — stamping, frozen-path observations and drift;
   - `binding.ts` — plan-binding contract validation (move 4);
   - `wire.ts` — persisted-state parsers;
   - `kernel.ts` — the module-private result helpers.
   Importers keep `./acceptance-contract`; only the index is public.
2. **One contract role.** `contractRole(contracts, task, tasks)` names a
   Task's role in each contract — contract task, claimant (with the anchors
   it completes), red-window bystander, or none. The implementation brief
   reads it instead of sniffing the persisted regression-waiver reason, so a
   Task inside the window that authored its own waiver still gets the
   bystander note.
3. **One acceptance verdict.** `completion-suite.ts` judges and binds a
   recorded observation in one function (`recordedAcceptanceVerdict`): the
   excused checks, the failures and the unbound facts. The evaluator and the
   receipt parser both call it.
4. **Plan-binding contract validation in core.** `contractBindingErrors`
   moves from `handlers/helpers/validate-model-bindings.ts` to
   `acceptance-contract/binding.ts`, over a typed task view. The handler
   adapts raw records and delegates.
5. **Subagent-ledger seam.** `revise-contract` and `amend-spec-trace` take
   their active-subagent probe as a dependency (production default), so the
   pre-lock check and the in-lock re-check are tested through a fake instead
   of a module mock that counts calls.

## Declined

- **One shared wire-parse toolkit** across `acceptance-contract` and
  `completion-suite`. The two use different error contracts on purpose:
  `CompletionSuiteParseError` accumulates every error for its operator
  diagnostic, while the contract parsers stop at the first one. Unifying them
  would change both public error types for no behavioral gain.

## Validation

`npm --prefix engine run verify` after each move; full verify before the PR.
