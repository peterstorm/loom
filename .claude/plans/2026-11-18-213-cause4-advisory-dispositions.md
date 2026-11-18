# #213 Cause 4: advisory decisions are recorded on the TaskGraph at the pause

- Issue peterstorm/loom#213, Cause 4. Worktree `../loom-advisory-dispositions`, branch `fix/advisory-dispositions` from origin/main 9f360b10.
- Operator decision (2026-11-18): record at the pause and keep across abandon/reopen; approval requires every issued advisory to be dispositioned.
- Coordination: the `loom-review-identity` session was told this session owns Cause 4. Open PRs touch other causes: #220–#222 cover #199 Causes 4 and 5 and #213 Cause 1b.

## Problem

`decide` accepts only `{"kind":"approve"}`, and anything decided lives in the run. Abandoning the run to fix some advisories loses the decisions on the rest. Every later gate then issues each deferred advisory to every reviewer as a prior finding, because priors are `task.findings` (`wave-review-issuance.ts:206`, `wave-review-authority.ts:1224`). In Wave 2 that meant 22 findings at five gates.

## Design

**Record** (`core/advisory-disposition.ts`):
- `AdvisoryDisposition = {schemaVersion: 1, wave, taskId, findingId, decision: fixed|deferred|dismissed, reason, target, anchor}`.
- `target` is a Wave or Task the deferral points at; it is null for anything but `deferred`.
- `anchor` is a sha256 over the bytes the finding anchors to, or null for `fixed`. If the finding's `file` is one of the Task's reviewed artifacts, the anchor is that file's bytes; otherwise it is the Task's whole reviewed artifact set (path and digest per artifact).
- One constructor serves both the operation and the State File parser.
- The TaskGraph gains `advisory_dispositions`, an append-only list where the latest record per finding wins.

**Operation:** `helper orchestration disposition`, stdin `{"dispositions":[{"finding":"T3:code-reviewer-2","decision":"deferred","reason":"…","target":"Wave 5"}]}`.
- Refuses outside the execute phase, while a subagent is active, for a finding that is not a current advisory of a Task in the active Wave, and for a duplicate entry in one call.
- Allowed while the Wave Gate is paused or after it is abandoned.
- Anchors are computed by the shell with the same `observeReviewedWorkspace` the gate uses.
- Parent-only and `handshake-required`, like the other plan edits.

**Issuing priors:** `issuedPriorFindings(task, dispositions, workspace)`.
- It leaves out a finding whose latest disposition is `deferred` or `dismissed` and whose anchor still equals the current anchor. Any other finding is still issued.
- It is used at both issuance sites, so `prior_finding_ids` and the packet's `priorFindings` agree.
- `finalizeReviewRun` already resolves only the issued ids, so a suppressed finding stays active and is not refused.

**Approval:** for a registered Wave Gate, `decide {"kind":"approve"}` is refused, naming the findings, while any issued advisory has no disposition.

**Retro:** `retro-facts` reads the dispositions per Wave.

## Tests (red first)

- The constructor and parser.
- The operation: refusals, idempotent repeat, latest wins, anchors.
- `issuedPriorFindings`: suppressed while the anchor holds, reissued when the bytes change; `fixed` is never suppressed.
- An issuance integration test.
- `decide` refuses approval while an advisory is undispositioned.
- Existing approve fixtures record their dispositions first.

## Status (2026-11-18)

Steps 1–7 and the Docs are implemented, uncommitted, in this worktree (ADR-0090). Typecheck and `lint-project` are clean; the covering suites pass except the Node 20 `markAsUncloneable` environment failures.

Refinements made while wiring:
- The record's shape lives in the leaf `advisory-disposition-shape.ts`, so `types.ts` stays acyclic.
- `waveAdvisories` is the one advisory derivation: the decision request, the approval refusal (`waveAdvisoryApprovalRefusal`, same Task set as `waveGateDecisionMismatch`) and the operation read it, legacy `legacy-advisory-<n>` claims included.
- `recordAdvisoryDispositions` takes minted workspace observations and re-admits them against the locked Task's review scope.
- `waveReviewPriorFindings` (wave-review-authority) keeps an installed run's issued priors and otherwise reads `issuedPriorFindings`; the epoch, packet and install all use it. The restart carry (ADR-0089) compares a carried run's priors with `issuedPriorFindings` (`CarryTerms.priorFindingIds`).
- The State File run invariant is now "an ordered selection of the active Findings that leaves out only advisories".

## Remaining work, in order

1. **Type:** `types.ts` gets `advisory_dispositions?: readonly AdvisoryDisposition[]` next to `retro_records`.
2. **State File:**
   - `state-file-wire.ts` parses the field with `parseAdvisoryDispositions` among the history fields (follow `retro_records` and `wave_plan_edits` through `parseTaskGraphHistoryFields` and `historyGraphFields`).
   - `task-graph-population.ts` (around line 732) drops it on re-population.
   - Grep `retro_records` for any other key list.
3. **Shell op:** `handlers/helpers/advisory-disposition.ts`, modelled on `add-dependency.ts`:
   - parse stdin, refuse while a subagent is active (quiescence);
   - `observeReviewedWorkspace(tasks)` gives taskId → artifacts;
   - `recordAdvisoryDispositions` runs under `StateManager.updateAndReturn` with `assertQuiescentUnderLock`.

   Register `disposition` in `orchestration-operations.ts` (input from stdin as `decide` does; `handshake-required`; `parent-only`), and in the dispatch and usage of `orchestration.ts`.
4. **One prior selector:** `issuedPriorFindings` replaces `task.findings` at both issue sites:
   - `wave-review-issuance.ts:206` (`prior_finding_ids`, artifacts from `workspaceByTask`);
   - `wave-review-authority.ts:1224` (`priorFindings`, artifacts from `admitted`).

   Grep `prior_finding_ids`, `priorFindings`, `waveRunRosterProblem`, `review-output.ts` and `findings.ts` for any check against all of `task.findings`. Check that restart and replacement paths use the same selector.
5. **Approval gate:** `decideOperation` refuses approval for a registered Wave Gate while `undispositionedAdvisories` is non-empty. It uses the same Task set as `deriveWaveAdvisoryDecisionRequest`, before the event is appended.
6. **Retro:** `retro-facts.ts` counts dispositions by decision per Wave.
7. **Tests:**
   - core tables for both modules;
   - State File round-trip;
   - the handler, in the style of the `add-dependency` tests;
   - issuance with an unchanged versus a changed anchor;
   - `decide` refusal and acceptance;
   - update the ~6 test files that approve with advisories present (grep `"approve"`).

## Docs

- A new ADR.
- `commands/wave-gate.md`: the classify-before-approve paragraph now uses `orchestration disposition`.
- `docs/reference/helpers.md` (or recovery), architecture and the review context, and the decision wire example.
