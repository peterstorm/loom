# ADR-0044: The Acceptance Freeze is stamped by the completion commit, not at receipt installation

## Status
Accepted (2026-10-25). Fixes a defect between the engine and its docs; branch
`fix/wave-advisory-remediation`.

## Context
A contract Wave's Wave Gate observes the contract's acceptance tests failing and then stamps the
**Acceptance Freeze**: the sha256 of every frozen path and the roster of testcases it saw red. After the
freeze, only a Contract Revision can change those bytes.

The docs (`commands/wave-gate.md`, `commands/loom.md`, `docs/operations.md`,
`references/executable-models.md`, `CONTEXT.md`) said the stamp lands when the gate completes, after the
advisory decision. They also said `helper orchestration status` names the advisories on frozen paths at that
pause (`acceptance-freeze-pending`), so the operator can fix them before approving.

The engine did something else. `driveWaveGate` runs `ensureWaveCompletionSuite` as the first step of every
drive, and its `installAcceptedReceipt` wrote the receipt and the stamped contracts in one locked update.
So the freeze was already `frozen` by the time the gate reached the advisory pause, and three things broke:

- `pendingFreezeAdvisories` keeps only contracts still `awaiting-red`, so it returned nothing and the
  `acceptance-freeze-pending` reason never appeared.
- Abandoning the run did not undo the freeze. Once the operator fixed the contract files and started a fresh
  gate, `frozenPathDrift` blocked it.
- The only escape left was `populate-task-graph --force`, which throws away every settled Task.

## Options Considered

1. **Revert the freeze on abandon**
   - Pros: A small change to the abandon transition.
   - Cons: The freeze would still exist at the pause, so the status notice stays dead. Abandon would gain a
     second job (rolling back contract state) on top of terminalizing a run. A crash between the freeze and
     the abandon still leaves a frozen contract with no gate behind it.

2. **Stamp at receipt installation, but read "pending" from the receipt instead of the freeze state**
   - Pros: No change to when anything is written.
   - Cons: The docs and the glossary would still be false: approval would not be what freezes. Drift after
     abandon stays. Two notions of "frozen" (persisted state vs. the receipt) that readers must reconcile.

3. **Install only the receipt; stamp inside the locked completion commit (chosen)**
   - Pros: Makes the docs true as written. The pause sees `awaiting-red`, so the notice fires. An abandoned
     run freezes nothing, so a fresh gate over fixed files sees no drift. The stamp joins the one atomic
     completion write that already archives the receipt into history, so it can never exist without a
     completed Wave.
   - Cons: `commitWaveGateCompletion` gains a parameter: the shell's observation of the frozen paths.
     Every caller has to supply it (the legacy `complete-wave-gate` passes an empty map, since a legacy
     graph has no suite receipt).

## Decision
**When the completion suite accepts, `installAcceptedReceipt` writes only `active_wave_completion_suite`.
The pure `commitWaveGateCompletion(snapshot, frozenPaths)` stamps the Acceptance Freeze from the archived
receipt's acceptance expectation and facts, in the same locked update that writes the completed-Wave
history entry.**

Concretely:

- `engine/src/core/wave-gate-machine.ts`: `completionAcceptanceFreezes` runs `stampAcceptanceFreezes` over
  the locked graph's contracts using the active receipt's `acceptance` (when there is one). A stamp it cannot
  make, such as an unreadable or unobserved frozen path, refuses the completion as
  `Acceptance Freeze refused: …`.
- `engine/src/handlers/helpers/wave-completion-suite.ts`: `observeCompletionFrozenPaths(graph, start)`
  digests every frozen path in the Run Directory's repository. When the repository cannot be resolved, every
  path comes back unreadable, so a stamp that needs one is refused.
- `engine/src/handlers/helpers/programs/wave-gate.ts`: inside `commitActiveWaveGateCompletion` the shell
  observes the frozen paths first and then derives readiness. Readiness re-observes the workspace and
  requires it to equal the receipt's `workspaceDigest`. Since that digest covers the frozen paths, a byte
  that changed between the two reads fails readiness instead of being frozen.

Nothing read the freeze between receipt installation and completion in a way this changes:

- **`acceptanceExpectation`** treats the contract Wave as `red` whatever the freeze state. A revised
  contract stays `revised` until completion, which keeps the expectation the receipt was judged under
  (green with roster `null`). So `reusableReceipt` and the readiness check that compares the receipt's
  expectation with the graph's still agree on resume.
- **The receipt's workspace digest** still pins the contract bytes for reuse, and `frozenPathDrift` still
  guards contracts frozen in earlier Waves.
- **Readers outside the gate** (the stop check, the implementation brief, red-then-green scope, contract
  status, Contract Revision) run during implementation or on completed Waves. Contract Revision refuses
  while a gate is live.
- **Later Waves' green expectations** read the freeze only after completion has stamped it.

Persisted compatibility: a graph frozen at receipt installation by an older engine still parses. At its
completion, `stampAcceptanceFreezes` finds an identical freeze (same bytes, pinned by the workspace digest,
and same roster, from the same receipt facts) and leaves it unchanged. A contract a Contract Revision moved to
`frozen` at this Wave is also left alone in the green phase. Neither is re-stamped or rejected.

## Consequences

**Positive:**
- `acceptance-freeze-pending` appears at a contract Wave's advisory pause, as the docs describe.
- Abandoning a contract Wave's gate leaves the contract `awaiting-red`. The contract Task can be
  reopened (`helper orchestration reopen-task`, ADR-0045), the files fixed, and a fresh gate runs with no drift.
- A freeze exists only alongside a completed-Wave history entry written in the same update.

**Negative:**
- Completion now reads files under the TaskGraph lock: the frozen paths, a handful of small files beside the
  workspace observation readiness already makes there.
- `commitWaveGateCompletion` has one more required argument, so tests that call it pass an observation (an
  empty map where no contract is owed).
- `engine/tests/handlers/helpers/wave-completion-suite.test.ts` now pins `awaiting-red` after `ensure()` and
  `frozen` only after the completion commit. Its drift test uses a contract that is already frozen.
