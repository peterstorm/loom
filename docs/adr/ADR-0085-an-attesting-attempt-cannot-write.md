# ADR-0085: An attesting attempt cannot write

## Status
Accepted (2026-11-18). Implements loom#199, Cause 6.

## Context
`helper orchestration attest` arms a Task whose implementation is already judged: its next attempt verifies and
changes nothing, and its Proof is a set of attested obligations. Until now "change nothing" was an instruction to
the dispatched Agent. In the fugue-dags host-memory run, Agents dispatched in attestation mode edited files anyway.
Each edit failed the attestation scope obligation and became terminal drift, discovered only after the attempt.
The fixes then went after the drift (#193, #194, `remediate`), not after the write.

The edit guard (`block-direct-edits`) already decides every Edit and Write during orchestration, and on Claude
Code it already knows the calling implementation Agent's exact bound attempt, hence its Task. Pi binds
implementation authority at spawn: each child session holds a write grant that names its Task and TaskGraph.

## Options Considered

1. **Refuse the write in the edit guard (chosen).** Once a write is admitted, the guard asks for the calling
   implementation Agent's Task write mode and refuses an attesting Task's write.
   - Pros: the refusal happens at the moment of the edit, with a message telling the Agent to report instead of
     editing. It is one rule (`core/attestation-writes.ts`) on both harnesses.
   - Cons: the guard now reads the TaskGraph for a bound implementation caller's write.
2. **Mint no write capability for an attesting dispatch.**
   - Cons: Claude Code has no spawn-time capability to withhold, since its binding is lazy. On Pi a roster row of
     an implementation role still admits by role.
3. **Keep the instruction and the drift backstop.**
   - Cons: this is what failed.

## Decision
- `core/attestation-writes.ts` holds the rule. `taskWriteMode(tasks, taskId)` returns:
  - `attesting` for a Task with `implementation_attestation`;
  - `implementing` for any other Task the graph holds;
  - `unobservable` when the graph cannot be read or does not hold the Task.
- `shouldBlockDirectEdit` takes a `callerWriteMode` port. It is consulted only after a write placed inside the
  orchestrated repository is admitted. `callerWriteModeVerdict` refuses `attesting`, naming the Task and telling
  the Agent to report rather than edit. It refuses `unobservable` too: the guard fails closed. A caller with no
  bound implementation attempt answers `undefined` and is unaffected.
- Claude Code: the caller's bound attempt names the Task. Its mode is read from the session's recorded TaskGraph,
  the one the attempt binding reads.
- Pi: the child's active write grant now keeps the Task and TaskGraph path it was bound to. Phase grants, and a
  grant activated before this change, carry no implementation Task and are unaffected.
- Drift detection stays as the backstop: any byte an attesting attempt still moves fails its scope obligation.

## Consequences
- An attesting Agent's Edit or Write is refused at the call, before it can become drift.
- An implementation write now costs one TaskGraph read on the decision path.
- A bound implementation Agent whose TaskGraph cannot be read can no longer write. That is the fail-closed choice
  the guard makes everywhere else.
