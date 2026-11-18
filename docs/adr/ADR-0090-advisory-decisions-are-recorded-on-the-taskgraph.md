# ADR-0090: Advisory decisions are recorded on the TaskGraph and suppress reissue while their bytes hold

## Status
Accepted (2026-11-18). Issue #213, Cause 4.

## Context
At a Wave Gate's advisory pause the only decision `decide` accepted was `{"kind":"approve"}`, and
whatever the operator decided about each advisory lived in the gate run. Abandoning the run to fix some
advisories (the one procedure for acting on a Finding) lost the decisions on the rest. Every later gate
then issued each deferred advisory to every reviewer as a prior Finding, because a Review Run's priors
were all of `task.findings`. In the Wave behind #213 that meant 22 Findings re-assessed at five gates,
each one already decided.

## Options Considered

1. **Richer `decide` payload** (per-advisory decisions inside the approval event)
   - Pros: one operation.
   - Cons: the decision stays in the run journal, so abandoning the run still loses it, and later gates
     cannot read it without reading old Run Directories.

2. **Resolve a deferred or dismissed advisory** (move it to `resolved_findings`)
   - Pros: reviewers stop seeing it at once.
   - Cons: a resolution is the reviewers' verdict over a complete roster. An operator writing one would
     fake that authority, and the advisory could never come back when its code changes.

3. **An append-only record on the TaskGraph, anchored to bytes**
   - Pros: survives abandon and reopen. The advisory stays active and owned by its reviewer. It is
     suppressed only while the bytes it was decided over are unchanged.
   - Cons: a new State File field and an operation; every site that builds a Review Run's priors must
     read the same selector.

## Decision
**Option 3.**

- **The record.** The TaskGraph gains `advisory_dispositions`, an append-only list of
  `{schemaVersion: 1, wave, taskId, findingId, decision, reason, target, anchor}`. `decision` is
  `fixed`, `deferred` or `dismissed`, always with a reason. `target` (a Wave or Task a deferral points
  at) is allowed only for `deferred`. `anchor` is a sha256 over the reviewed bytes the advisory anchors
  to: its own file when that file is one of the Task's reviewed artifacts, otherwise the Task's whole
  reviewed artifact set. A `fixed` record has no anchor. The latest record per advisory is its standing
  decision. One constructor builds a record for the operation and for the State File parser.
  Re-population drops the list with the Tasks it named.
- **The operation.** `helper orchestration disposition` reads
  `{"dispositions":[{"finding":"<task>:<finding-id>","decision":…,"reason":…,"target":…}]}` on stdin.
  It refuses outside the execute Phase, while a subagent is active, for an advisory the active Wave's
  decision request would not issue, for a duplicate entry, and when a Task's reviewed workspace changed
  between observation and commit. It is allowed while the Wave Gate is paused on its advisories and after
  the run is abandoned. The shell computes anchors with the same reviewed-workspace observer the gate uses
  and commits under the TaskGraph lock. A repeated request appends nothing. Parent-only and
  handshake-required, like the other plan edits.
- **One prior selector.** `issuedPriorFindings` decides the priors a fresh review of a Task is issued: every
  active Finding, less an advisory whose standing decision is `deferred` or `dismissed` and whose anchor
  equals the anchor of the bytes now reviewed. The Review Packet's priors, the Review Run's
  `prior_finding_ids` and the batch epoch all read it, and a Wave Gate restart's carry check (ADR-0089)
  compares a carried run's priors against it. A suppressed advisory stays on the Task, because a run
  resolves only the priors it issued. The State File admits a run whose prior IDs are an ordered
  selection of the active Findings that leaves out only advisories.
- **Approval requires a decision on every advisory.** For a registered Wave Gate, `decide
  {"kind":"approve"}` is refused, naming each advisory, while any advisory the pending decision request
  issues has no standing disposition. The check reads the same Task set and the same advisory derivation
  as the request, and runs before the decision event is appended.
- **Retro.** The friction digest counts each Wave's standing decisions by kind.

## Consequences
- Decisions survive abandon and reopen. A later gate stops re-issuing a deferred or dismissed advisory
  while its bytes hold, and re-issues it when they change.
- A `fixed` decision never suppresses: reviewers keep assessing the advisory until its owner resolves it.
- Every advisory must be decided once before a gate can be approved; a decision from an earlier gate run
  keeps counting.
- The decision request still lists every active advisory, including suppressed ones, so the operator sees
  what was decided before.
- State Files without the field load unchanged, and a run issued before this change keeps its full prior
  set.
