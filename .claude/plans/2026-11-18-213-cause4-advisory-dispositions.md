# #213 Cause 4: advisory decisions are recorded on the TaskGraph at the pause

Historical record of the plan behind PR #224 ([ADR-0090](../../docs/adr/ADR-0090-advisory-decisions-are-recorded-on-the-taskgraph.md)). The implementation order below is done; the ADR and the code are the current description.

- Issue peterstorm/loom#213, Cause 4. Branch `fix/advisory-dispositions` from origin/main 9f360b10.
- Operator decision (2026-11-18): record at the pause and keep across abandon/reopen; approval requires every issued advisory to be dispositioned.
- Coordination: the `loom-review-identity` session was told this session owns Cause 4. PRs #220–#222 cover #199 Causes 4 and 5 and #213 Cause 1b.

## Problem

`decide` accepted only `{"kind":"approve"}`, and anything decided lived in the run. Abandoning the run to fix some advisories lost the decisions on the rest. Every later gate then issued each deferred advisory to every reviewer as a prior Finding, because a Review Run's priors were all of `task.findings` (at the Review Run install in `wave-review-issuance.ts` and the Review Packet in `wave-review-authority.ts`). In Wave 2 that meant 22 Findings at five gates.

## Design

**Record** (`core/advisory-disposition.ts`, shape in the leaf `advisory-disposition-shape.ts` so `types.ts` stays acyclic):
- `AdvisoryDisposition = {schemaVersion: 1, wave, taskId, findingId, decision, reason, target, anchor}`, a union on `decision`: `fixed` has neither anchor nor target, `deferred` has an anchor and an optional target, `dismissed` has an anchor and no target.
- `anchor` is a sha256 over the bytes the Finding anchors to: that file's bytes when its `file` is one of the Task's reviewed artifacts, otherwise the Task's whole reviewed artifact set (path and digest per artifact).
- One constructor serves both the operation and the State File parser.
- The TaskGraph gains `advisory_dispositions`, an append-only list where the latest record per Finding stands.

**Operation:** `helper orchestration disposition`, stdin `{"dispositions":[{"finding":"T3:code-reviewer-2","decision":"deferred","reason":"…","target":"Wave 5"}]}`.
- Refuses outside the execute phase, while a subagent is active, for anything but an advisory of a Task in the active Wave, and for a duplicate entry in one call.
- Allowed while the Wave Gate is paused or after it is abandoned.
- Anchors are computed by the shell from the bytes `observeReviewedWorkspace` reads before the lock; under the lock only the review scope is re-checked (a stale anchor stops matching, so the advisory is reissued).
- Parent-only and `handshake-required`, like the other plan edits.

**One Task set:** `advisoryDecisionTasks(graph, wave)` is read by the decision request, the approval refusal and the operation.

**One prior selector:** `waveReviewPriorFindings` (rule: `issuedPriorFindings`) leaves out a Finding whose latest disposition is `deferred` or `dismissed` and whose anchor still equals the current anchor. Every issuing site and the restart carry read it, so `prior_finding_ids`, the packet's `priorFindings` and the carry check agree. `finalizeReviewRun` resolves only the issued ids, so a suppressed Finding stays active.

**Approval:** for a registered Wave Gate, `decide {"kind":"approve"}` is refused, naming the advisories, while any issued advisory has no disposition.

**Retro:** `retro-facts` counts the dispositions per Wave.

## Implementation order (done)

1. Type: `advisory_dispositions` on the TaskGraph.
2. State File: parsed among the history fields, dropped on re-population.
3. Shell operation `handlers/helpers/advisory-disposition.ts`, registered in `orchestration-operations.ts` and dispatched from `orchestration.ts`.
4. One prior selector at every issuing site and in the restart carry.
5. Approval gate in `decideOperation`, before the event is appended.
6. Retro counts.
7. Tests: core tables, State File round-trip, the handler, issuance over an unchanged and a changed anchor, the restart carry, `decide` refusal, and the façade smoke recording a disposition for every advisory before approving.

## Docs

- ADR-0090.
- `commands/wave-gate.md`: classify-before-approve uses `orchestration disposition`.
- `docs/reference/recovery.md`, `docs/architecture.md`, `docs/operations.md`, the recovery runbook and the disposition wire example.
