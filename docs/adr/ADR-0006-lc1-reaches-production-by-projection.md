# ADR-0006: LC-1 reaches production by projection, not by checkpoint

## Status
Accepted

## Context

A deepen session (2026-08-18, branch `feat/architecture-panel-mode-plan`)
found that LC-1 — the Wave Gate lifecycle reducer declared in
`.claude/plans/2026-08-09-orchestration-automation.md` and implemented in
`engine/src/core/wave-gate-machine.ts` — was not merely unused in production.
It was **unreachable**.

`WaveGateState` can only be minted by `createWaveGateState`, and
`WaveGateNextAction` only by `proveWaveGateNextAction`. Neither was called from
any file in `src/`, `pi/`, or `hooks/`; both were referenced by exactly one test
file, at 45 call sites. Every production call site passed the two optional
lifecycle parameters as literal nulls:

- `deriveWaveReadiness(graph, waveGateDeps)` — twice in the Wave Gate façade
- `deriveLoomStatusFromParsedGraph(parsed, deps, null, null, runDirectory)` — in
  `orchestration status`

Outside the machine file, nothing in the engine mentioned `WaveGateState` or
`lifecycleCheckpoint` at all.

This is the odd one out among the three declared machines. LC-2
(`standalone-review-machine`) is driven 10 times from `programs/standalone.ts`
and LC-3 (`remediation-machine`) 6 times from `programs/remediation.ts`. Both
persist their state: LC-2 writes `serializeStandaloneReviewMachineState` at
seven points and rehydrates through `parseStandaloneReviewMachineState`.

LC-1 had no such pair. It has no serializer and no parser, and its states are
guarded by an in-process `WeakSet`, so a `WaveGateState` cannot survive a
process boundary at all. That absence is almost certainly *why* it was never
wired: the façade is a fresh CLI process at every boundary, so there was no way
to carry a state across one.

Meanwhile the Wave Gate façade reconstructs its position on every drive from a
conjunction of five sources — `wave_gate_history`, `active_wave_gate`,
`deriveWaveReadiness`, `readIssuedRequests()`, `readCapturedAttempts()` — with
predicates like:

```ts
const initialBatchMissingOrPartial = graph.wave_review_epoch === undefined &&
  graph.tasks.every((task) => !registration.taskIds.includes(task.id) || task.review_run === undefined);
```

"Missing **or** partial" is two LC-1 states (`preparing`,
`awaiting-review-results`) collapsed into one derived predicate.

The observable consequence was narrow but real. `deriveLoomStatusFromParsedGraph`
answers rich actions for the non-execute, terminal-blocked, committed, and
unstarted-wave cases before it reaches the readiness path. But once a Wave Gate
run is **in flight**, `deriveNextAction` could only take its `else` arm, so the
action was always the retryable `blocked` action carrying
`engine-resume-required`. Of the four actions LC-1 can prove, three are engine
work and "resume the engine" is adequate guidance for them. The fourth is not:
`advisory-decision-required` is waiting on a **person**, and telling the operator
to resume the engine names the one action that cannot unblock the run while
hiding the one that can.

## Options Considered

1. **Delete LC-1** — remove the reducer, the next-action authority, and the two
   optional parameters; drop the LC-1 declaration from the plan.
   - Pros: one model instead of two; ~450 lines and 45 test call sites gone; no
     second representation that can diverge from the **State File**
   - Cons: in-flight status permanently answers "resume the engine", including
     while a human decision is pending; discards a tested asset whose
     divergence-safety machinery (`snapshotActionProofIsExact`, binding every
     digest of the protected snapshot) is already built

2. **Checkpoint LC-1, as LC-2 does** — invent a `serializeWaveGateState` /
   `parseWaveGateState` pair, persist the state in the Run Directory, rehydrate
   on resume.
   - Pros: symmetric with LC-2/LC-3; the stage becomes durable
   - Cons: requires inventing a trust root for the most safety-critical state in
     the system (minting a `WaveGateState` is what lets you mint a
     `WaveGateNextAction`); requires a checkpoint format migration, because the
     checkpoint slot currently holds only the terminal `wave-gate-done` record;
     and it is redundant — the façade already reconstructs from durable evidence,
     so the checkpoint would be a second copy of a truth the State File holds

3. **Project LC-1 over durable evidence** — a pure function reduces the machine
   forward over facts the shell already reads, returning the stage.
   - Pros: no new trust root, no format migration, no second durable copy; the
     façade is *already* a replay, so this matches how the program actually
     works; one small interface with the whole stage decision behind it, usable
     by both the façade and `status`
   - Cons: the projection must be kept faithful to the façade's own ordering;
     status pays a second `deriveWaveReadiness` to bind the proven action

## Decision

**LC-1 reaches production by projection.** `projectWaveGateLifecycle(snapshot,
evidence)` in `engine/src/core/wave-gate-machine.ts` reduces LC-1 forward over a
`WaveGateLifecycleEvidence` record supplied by the shell, and every transition
goes through `reduceWaveGate` — so a combination of facts that no declared
transition admits is a rejection, not a stage nobody checked.

`orchestration status` uses it for the one stage where the previous answer was
wrong. When the projection reports `awaiting-advisory-decision`, status proves
the action with `deriveWaveAdvisoryNextAction` and reports the real `await-user`.
Every other stage falls through to the ordinary readiness path, where "resume the
engine" is the correct answer rather than a placeholder. A projection failure
returns `null` and degrades to the previous behaviour instead of replacing a
usable status with an error.

One evidence field, `advisoryApproved`, lives in the run's event log rather than
the protected graph, so the shell observes it and hands it to the core through
`ActiveRunDirectoryObservation` — the seam that already exists for exactly this
purpose. Absent or unreadable, it reads as "not approved", which keeps status
asking for a decision rather than reporting progress that has not happened.

The Wave Gate façade's drive function is **unchanged**. Its control flow is the
program (ADR-0005), and rewriting the commit path was not necessary to make LC-1
executable.

## Consequences

- LC-1 is an **Executable Model** as `CONTEXT.md` requires. The `Lifecycle
  Machine` entry now names both routes to production — checkpoint and projection
  — and which one applies depends on where the program's truth lives: a program
  outside the State File must checkpoint; one whose evidence is already durable
  may project.
- `loom status` reports a pending advisory decision instead of "resume the
  engine". Three tests in `tests/handlers/complete-wave-gate.test.ts` pin this
  through the real entry point, `deriveLoomStatusFromParsedGraph`; all three
  fail if the projection call is removed.
- The façade still infers its own stage from the five-source conjunction. That
  duplication is now *visible* rather than structural: `projectWaveGateLifecycle`
  is the named place the stage decision belongs, and moving the façade onto it is
  a follow-up that touches the commit path and deserves its own change.
- Anyone tempted to delete LC-1 as dead code should read this first: it is
  reachable, and the reachability is load-bearing for the advisory action.
