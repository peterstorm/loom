# ADR-0026: I6 enters proof as one obligation, one failure variant and one evidence variant

## Status
Accepted (2026-10-17). Records AD-6 of the G4 slice 2 oracle plan
(`.claude/plans/2026-10-16-g4-slice-2-oracle.md`).

## Context

I6 is the red-then-green rule. A Task that requires new tests must show, inside its attempt epoch, a
red run on its own test files, then its first write to an implementation file, then a green run over
every one of its test files. The judge, `judgeRedThenGreen` (AD-5), turns ordered ledger facts into a
`RedThenGreenObservation`. That is either `shown` with the three steps, or `unproven` with one
`RedThenGreenGap`: `no-test-files`, `implementation-write-missing`, `red-missing`,
`red-after-first-implementation-write`, `green-missing` or `ledger-unavailable`. Producing the verdict
was not the open problem. The open problem was how the verdict gets into Proof, the engine's single
place for deciding whether an implementation attempt completed, and from there into settlement and the
retry lineage.

Several forces apply. FR-009 says every I6 failure must be a distinct named proof failure, so a
retry brief and an operator can see which step is missing. FR-011 says I6 is decided at completion
only, never mid-attempt. Settlement already runs through one semantic path on both harnesses
(obligations, then evaluation, then `proofFailureKind`, then retry lineage `failureKinds`). Adding a
second judgment channel next to it would split the retry logic. The judge's input is the attempt
epoch's evidence ledger, which reaches settlement in different ways. On Claude Code it is the session
ledger that `update-task-status` already folds into the agent's epoch. On Pi it is the parent ledger,
read back under the child's grant epoch (AD-8). Either read can fail, and a
failed read is an infrastructure fact, not something the agent did wrong. Lastly,
`reconcileTaskFromStoredEvidence` re-evaluates proof from stored facts and has no ledger to read, so
it needs a defined answer that neither passes nor fails a Task by accident.

## Options Considered

1. **One new obligation, one failure variant and one evidence variant inside the existing Proof ADTs
   (chosen)**
   - Pros: each gap becomes its own named failure kind, `proof:red-then-green-unproven:<gap>` (FR-009).
     Retry runs through the existing semantic path with no new channel. The obligation is derived and
     frozen like every other obligation, so an I6-era Task carries it and a pre-I6 TaskGraph never
     acquires it. Evaluation is total: a missing observation still decides, as `ledger-unavailable`.
     The satisfied result records the red run, the write and the green run as evidence, so reconcile can
     carry it forward.
   - Cons: every Proof ADT (`ProofObligation`, `ProofFailure`, `ProofEvidence`,
     `ObservedProofEvidence`) and its State File wire parser grows a variant. Exact settlement on both
     harnesses must now be handed a `LedgerObservation`.

2. **Reuse the existing `new-tests-not-observed` failure for every I6 gap**
   - Pros: no new ADT variants. No State File wire change.
   - Cons: it cannot name the missing step, which breaks FR-009. A retry brief could not give the
     restore-then-red remedy (AD-7), because it could not tell a missing red from a missing green. It
     also merges two separate questions, whether new tests exist and whether they were shown red before
     implementation, so a fix for one hides the other.

3. **A separate I6 gate outside Proof, for example a stop-check block or a post-settlement verdict**
   - Pros: leaves the Proof ADTs untouched. It could run earlier, at subagent stop.
   - Cons: it is a second judgment channel with its own retry logic, and its decision could disagree
     with Proof's. Judging at stop rather than at completion breaks FR-011. It would also need its own
     handling of ledger-read failures and of reconcile, which the Proof path already has.

## Decision

**I6 enters Proof as exactly one obligation (`red-then-green`), one failure variant
(`red-then-green-unproven` carrying its gap) and one evidence variant (`red-then-green` carrying red,
implementation write and green), and its input arrives at exact settlement as a `LedgerObservation`.**

Types (in `engine/src/core/proof-obligations.ts`, gap and observation types in
`engine/src/core/red-then-green-types.ts`):

```
ProofObligation       += { kind: "red-then-green" }
ProofFailure          += { kind: "red-then-green-unproven"; gap: RedThenGreenGap }
ProofEvidence         += { kind: "red-then-green"; red: RunRef; implementationWrite: string; green: RunRef }
ObservedProofEvidence += redThenGreen?: RedThenGreenObservation
LedgerObservation      = { kind: "read"; events: readonly Evidence[] } | { kind: "unreadable"; reason: string }
```

Detail:

- **Derivation.** `deriveProofObligations` emits `red-then-green` only when the verification policy
  requires new tests and the TaskGraph's era is `owed-if-new-tests`. Only `redThenGreenEra(manifest)`
  mints the era (INV-6). It returns `owed-if-new-tests` exactly when the frozen verification manifest
  carries `testFiles`. Population (`task-graph-population.ts`), revalidation (`task-revalidation.ts`),
  the State File obligation-match check (`state-file-wire.ts`) and reconcile all call it, so a TaskGraph
  frozen before this feature is never newly obligated (FR-005).
- **Evaluation.** `evaluateRedThenGreen` maps a `shown` observation to a satisfied result whose evidence
  is the three steps, and an `unproven` observation to `red-then-green-unproven` with its gap. When the
  observation is absent, the default is `{ kind: "unproven", gap: { kind: "ledger-unavailable" } }`, so
  evaluation is total and fails closed.
- **Failure kind.** `proofFailureKind` (in `engine/src/core/implementation-completion.ts`) mints
  `proof:red-then-green-unproven:<gap.kind>`, typed as `RedThenGreenFailureKind`. That string goes into
  the retry lineage's `failureKinds`, where the brief's I6 retry remedy (AD-7) matches it.
- **Transport.** `ExactImplementationTransportFacts.ledger: LedgerObservation`
  (`engine/src/handlers/helpers/exact-implementation-settlement.ts`). Claude Code supplies the epoch
  events that `update-task-status` already folds. Pi supplies `piImplementationLedger` in
  `pi/subagent-settlement.ts`, the parent ledger read back under the child's grant epoch. A missing
  parent session, slot grant or agent epoch becomes `unreadable` with a reason.
- **Duty and unreadable ledgers.** Settlement consults the ledger only when `redThenGreenDuty(task,
  manifest)` is `owed` (`engine/src/core/implementation-application.ts`). An `unreadable` ledger, or a
  `classification-unfrozen` duty, settles as an `implementation-observation-unavailable` infrastructure
  failure. It never becomes a semantic retry, so it does not use up the retry budget.
- **Reconcile.** `reconcile-implementation-proof.ts` has no ledger. It carries forward a prior satisfied
  `red-then-green` result, the same way it carries forward `taskCompletionWasObserved`. With nothing to
  carry, it leaves the observation absent, and evaluation reads that as `ledger-unavailable`.
- **Timing.** The judgment runs once, at completion settlement, over the attempt epoch (FR-011). Each
  attempt is judged on its own epoch, never across attempts.
- **Wire.** The State File parser accepts the new obligation, the failure with each named gap, and the
  evidence variant. It rejects an unrecognized gap kind.

## Consequences

**Positive:**
- Every I6 failure has its own name (`proof:red-then-green-unproven:red-missing` and so on), so the
  retry brief can prescribe the exact repair and an operator can read the gap straight from lineage.
- I6 reuses the existing semantic retry path, receipts and State File wire on both harnesses. No second
  judgment channel exists to drift.
- Evaluation is total and fails closed. An absent observation is a named failure, never a silent pass.
- Ledger-read problems are classed as infrastructure. A Pi grant gap or an unreadable Claude ledger does
  not burn the agent's semantic attempts.
- Pre-I6 TaskGraphs keep exactly the obligations they were frozen with, because the era is derived from
  frozen manifest bytes by one owner.

**Negative:**
- Four Proof ADTs, their wire parsers and every exhaustive `switch` over them grow by one variant, which
  makes the proof surface wider for every future reader.
- Exact settlement now needs a `LedgerObservation` on both transports. A transport that cannot produce
  one turns every I6-owing Task into an infrastructure failure until it can.
- Reconcile cannot re-judge I6. A Task whose earlier settlement never satisfied I6 reconciles to
  `ledger-unavailable` even if the ledger, read live, would have shown the order. This conservative
  result is accepted.
- The gap name is a stable string in `failureKinds`. Renaming a gap variant later is a State File and
  lineage compatibility change, not a local refactor.
