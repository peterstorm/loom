# ADR-0101: The stale sweep keeps a session while its bound run is open

## Status
Accepted (2026-11-22).

## Context
The SessionStart sweep (`engine/src/handlers/session-start/cleanup-stale-subagents.ts`) deletes a session's
tracking files once the whole session group has been idle past `STALE_SUBAGENT_TTL_MS` (one hour). Until now
it kept a session for only two reasons: it is the session that is starting, or its `<session>.task_graph`
pointer names a TaskGraph that still exists.

The group includes `<session>.orchestration-runs.json`, the Session Run Binding registry. Every
`spawn-batch` the façade returns is published there first. Each subagent's capture hook resolves its issuing
run through it, and the run's `done` records its `result.json` digest into it. A standalone review,
disposition or remediation runs without a TaskGraph. So when its parent session sat idle for an hour (the
operator away, a long review slice), a SessionStart in any other session deleted the registry under the live
run. Every later capture and the run's completion then failed with "cannot bind completed result for
unregistered run". This happened during the PR #252 remediation: one slice's binding was swept, and the slice
was recovered only by `orchestration resume`.

Two facts limit what the sweep can know:

- Pi runs the sweep as a synchronous startup sweep (`PiStartupSweep.run: () => void`), so the sweep cannot
  await the handle's asynchronous reads.
- Not every run proves its end in a file a synchronous read can see. The architecture and refutation panels
  write no checkpoint: their end is derived by replaying the journal, which is read under the journal's
  append lock. A blocked run whose operator never returns proves nothing either.

## Options Considered

1. **Exempt every registry from the sweep.**
   - Pros: Trivial.
   - Cons: Registries accumulate forever, one per session that ever spawned a run.

2. **Record closure generically: mark a binding closed on every `done` action.**
   - Pros: One rule for every program; the sweep reads only the registry.
   - Cons: Changes the registry schema, so every existing registry needs a migration path, and a run that
     never reaches `done` (blocked, crashed) still has no closure. The sweep would still need a bound.

3. **Judge each bound run's liveness from its Run Directory, bounded by a grace period (chosen).**
   - Pros: No schema change. A run is finished on its own proof: a recorded result digest, an `abandoned.json`
     marker, or a checkpoint in one of its program's terminal states. The bound covers what no file proves.
   - Cons: The sweep learns each program's terminal checkpoint states, and panels are judged only by the bound.

## Decision
**A session whose Session Run Binding registry names an open run survives the sweep, for at most
`OPEN_RUN_GRACE_MS` (seven days) past the idle TTL.**

- **Liveness is pure.** `core/run-liveness.ts` `runLiveness(observation)` decides `open` or
  `finished(result-published | abandoned | terminal-state)` from facts already read. A run is finished only
  on its own proof; every other reading is open: an unregistered run, an unknown program, a panel, a
  resumable `recoverable-blocked` run. `TERMINAL_CHECKPOINT_STATES` lists each program's terminal states and
  reads them through `checkpointStateName`, the same reader run inspection uses.
- **Observation is a synchronous shell.** `orchestration/bound-run-liveness.ts` `observeBoundRun(binding)`
  answers `absent` (the Run Directory is gone, so the binding names nothing), `observed`, or `unreadable`
  (something is there but cannot be read). A recorded result digest needs no read.
  `orchestration/run-directory-handle.ts` gains the exported `readCheckpointNow(handle)`, a synchronous read
  over the same bytes the handle's `readCheckpoint` returns.
- **The sweep mirrors the pointer rules.** It reads a registry only when the idle TTL would sweep its session
  and the grace still covers it. Then: an unreadable registry protects its session and is reported (`read`); a
  malformed one binds nothing and is reported (`parse`); an unreadable run protects its session and is
  reported against the run directory; every binding is observed so each unreadable run is reported. The
  registry is parsed as whichever harness it names (`parsePublishedSessionRunBindingRegistry`), because one
  sweep serves both harnesses; authority readers still name their own harness.
- **The port grows one operation.** `StaleSessionOperations.observeBoundRun` lets the sweep's tests script
  run liveness without Run Directories.

## Consequences

**Positive:**
- A standalone run keeps its binding through any idle wait shorter than the grace, so captures and completion
  bind as they did before the session idled.
- No schema change, and no change to any writer or authority reader.
- Read failures surface in the SessionStart diagnostics instead of either deleting a live binding or keeping a
  dead one silently.

**Negative:**
- A finished panel run, or a run nobody finishes or abandons, keeps its session's files for up to seven days
  past the idle TTL: a few kilobytes per session.
- An open run idle for longer than the grace still loses its binding, as before, and needs
  `orchestration resume`.
- A new program kind must add its terminal states to `TERMINAL_CHECKPOINT_STATES`, or its finished runs are
  held for the grace. The table is typed by `InspectableProgram`, so a program added there does not compile
  without an entry.
