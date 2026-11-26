# ADR-0104: A contract writer may hold frozen bytes

## Status
Accepted (2026-11-26).

## Context
An Acceptance Contract has one contract Task: the Task whose `file_list` holds every frozen path (the types
file and each acceptance file, `frozenPaths` in `engine/src/core/acceptance-contract/tasks.ts`). Population
derives that Task's Proof like any other `changed` Task: one `declared-artifact-changed` obligation per
`file_list` entry (`scopeObligations` in `engine/src/core/proof-obligations.ts`). The obligation is satisfied
only when the artifact's bytes changed.

That holds when the contract Task first writes the contract. It does not hold when a plan revises a contract
and the contract Task re-freezes it. The revision may change the types file and leave some acceptance files
correct as they are. The brief then tells the writer to re-freeze those files with their bytes unchanged.
Each of them fails `declared-artifact-not-changed`, so the Task can never pass. `rescope-task` cannot drop
the files either: it refuses because a contract's frozen paths must stay with its contract Task.

A real run hit this. Task T1 of the alert-bridge Phase 1 plan failed attempt 1 with exactly
`proof:declared-artifact-not-changed` on five byte-identical re-frozen acceptance files, and its retry is
its final attempt.

The Proof is not the only thing that judges these bytes. The contract's Wave Gate stamps an `awaiting-red`
contract's frozen paths and refuses to stamp a path it cannot read (`frozenPathDigests`). For a frozen or
revised contract it reports every frozen path that is missing, unreadable or changed as drift
(`frozenPathDrift`). Both are in `engine/src/core/acceptance-contract/freeze.ts`.

## Options Considered

1. **Exempt a contract writer's frozen paths when obligations are derived.**
   - Pros: The writer owes no byte change on those paths at all; the evaluator stays as it is.
   - Cons: It changes the derived obligations. The State File load re-derives each Task's obligations and
     requires an exact match (`state-file-wire.ts`, the obligation-match check), so every persisted graph with
     a contract writer would stop loading or would need a migration. T1's stored failed Proof keeps the old
     obligations, so its retry would still be evaluated against `declared-artifact-changed` and stay stuck.

2. **Hold any frozen path of the writer, whether or not it exists.**
   - Pros: The simplest rule: a frozen path of a contract the Task writes never fails as unchanged.
   - Cons: A writer that never creates an acceptance file would pass its Proof on a file that is not there.
     The Proof would then claim work the freeze has not seen.

3. **Let a present frozen file satisfy the existing obligation as held for the freeze (chosen).**
   - Pros: Obligation derivation is unchanged, so every persisted graph and T1's stored Proof load as they
     are, and T1's retry re-evaluates the same obligations. Only a file that is there is held. The contract's
     freeze remains the one judge of the frozen bytes. Evidence written before this change reads unchanged.
   - Cons: For these paths the Proof proves only presence; the byte judgment is the freeze's.

## Decision
**A `declared-artifact-changed` obligation on a frozen path of a contract the Task writes is satisfied
when the bytes changed, or when the path holds a regular file at settlement. The second case is recorded as
held for the freeze, naming the contract.**

- `ObservedProofFacts` carries a required `heldForFreeze`: the frozen paths of the contracts whose
  `contractTask` is the settling Task (`writerFrozenPaths`) that hold a regular file. It is required in the
  same way as `contractConformance`, so no settlement path can drop it by leaving it out.
- `observeHeldForFreeze` in `engine/src/orchestration/freeze-hold-observation.ts` is the shell. It reads each
  writer frozen path without following a link (`readRepositoryLeafNoFollow`). A regular file is held. An
  absent path, or one that holds a link, directory or other kind, is not held, so the obligation fails as
  `declared-artifact-not-changed` and the freeze refuses the path at the gate. Any other read error is an
  infrastructure failure: settlement is `infrastructure-blocked` and reconcile refuses without changing
  state. Both the exact settlement (`observeAttemptEvidence`) and `reconcile-implementation-proof` observe
  it next to contract conformance.
- `evaluateDeclaredArtifactChanged` judges in this order: a conformance violation fails as
  `declared-artifact-contract-violated`; a changed artifact is satisfied with plain evidence; an unchanged
  held artifact is satisfied with `basis: { kind: "held-for-freeze", contract }`; anything else fails as
  `declared-artifact-not-changed`. A held artifact is matched to the Task's `file_list` entry by the same
  plan-path rule (`samePlanPath`) that `contractWriterTask` uses.
- On the wire, `basis` is left out of changed evidence, so earlier records stay byte-identical. It is present
  only for a hold, and the evidence parser accepts it only on `declared-artifact-changed`, with that exact
  shape.

## Consequences

**Positive:**
- A contract writer can re-freeze a revised contract and leave correct acceptance files untouched. T1's
  retry settles `implemented` once its other obligations are met.
- No obligation, persisted graph or stored Proof changes shape. Earlier `declared-artifact-changed` evidence
  parses exactly as before.
- A Task that writes no contract is not affected: its `heldForFreeze` is empty and the changed test applies
  as before.

**Negative:**
- For a held path the Proof records presence, not a byte change. If the contract Wave Gate never ran, nothing
  checks those bytes before the next gate; the freeze checks them there.
- The settlement shell reads each writer frozen path once more per settlement.
