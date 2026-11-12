# Recovery operations

The operator commands that change protected state to recover a run: remediation, reopening a Task or a completed Wave, and upgrading or amending the spec trace. Symptoms and when to reach for each are in [Operations](../operations.md); the read-only helpers are in [Helpers](helpers.md). `$LOOM_DIR` is defined in [Operations → Prerequisites](../operations.md#prerequisites).

These operations change protected state. Each is the only sanctioned way to make its change: never edit the graph instead, and never use `populate-task-graph --force` as a recovery, because it resets every Task and discards all settled evidence.

## Implementation escalation (semantic attempt 2 exhausted)

A modern implementation Task gets exactly two semantic attempts ([Implementation attempts and settlement](../verification.md#implementation-attempts-and-settlement)). When attempt 2's settlement also fails its proof, the lineage records an `escalation-required` receipt and further implementation dispatch is refused — the engine will not spin a third unreviewed attempt. Attestation byte drift is terminal on attempt 1 because refreshing its baseline would certify child-authored bytes. The direct exit from either terminal state is `remediate`; it is deliberate, reason-echoed, and never rewrites history:

```bash
# Consume the escalation: append one escalation-remediated receipt and return
# the Task to a fresh attempt 1 (operator repaired the environment, re-scoped
# the Task, or otherwise sanctioned a new proving round).
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration remediate \
  --task <task-id> \
  --receipt <exact-terminal-escalation-receipt-id> \
  --reason "<why a fresh attempt is now sanctioned>"

# Separately, arm re-attestation only on an eligible pending, nonterminal Task
# when the declared artifacts already carry the completed work
# (populate-task-graph --force reset, reopened Wave). An anchor-only repair
# needs no attestation: amend-spec-trace keeps implementation proof.
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration attest \
  --task <task-id> \
  --reason "<why the work is known to be already present>"
```

`orchestration status` names the exact command for each escalated Task in its `implementation-escalation-required` reason, with the Task and receipt filled in and shell-quoted; only `--reason` is yours to write.

`remediate` requires the exact receipt id of the Task's terminal escalation and refuses a repeat (`no longer escalated`), a live attempt, or a wrong receipt — all without touching state. The receipt is appended only; history start and the seed predecessor are untouched, and the walk past the remediation receipt lands on a fresh attempt 1 with a full two-attempt budget. The reason is echoed to stdout only; it is never persisted into the graph.

`attest` refuses a live attempt, an escalated lineage (remediate first), a satisfied proof, a repeat (`already in attestation mode`), and an unknown Task — all without touching state. It rewrites exactly the proof surface under the TaskGraph lock: one scope-wide attestation obligation plus one attested obligation per declared artifact, a regression-required/new-tests-waived stored policy (the legacy `new_tests_required` boolean is cleared, not flipped — a `false` there would contradict the required regression at the load boundary), and the `implementation_attestation: true` flag. Lineage, baselines, and history are untouched. The dispatch binding requires the engine-derived `LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT` line on every dispatch and refuses it on non-attestation Tasks. The attested child must change nothing inside the attempt scope: any byte move fails the scope obligation and terminalizes that attestation lineage, so it can never become a refreshed attempt-2 baseline. Restore the intended bytes, then use the exact terminal receipt with `remediate` before another proving round. The classified regression still runs. Reconcile measures drift against the attempt baseline (never the population baseline), so pre-existing population-relative changes are the attested work, not writes.

## Reopening an implemented Task to fix a Wave Gate Finding

Use this when a Wave Gate Finding, critical or advisory, must be fixed in a Task that is already `implemented`: abandon the gate run, reopen the Task, and dispatch it again.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration abandon \
  --runs-root ".claude/reviews/wave-gate-runs" --run "<run-id>" --reason "fix comment-analyzer-1 first"
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration reopen-task \
  --wave 2 --task T4 --reason "comment-analyzer-1: the comment contradicts the code"
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration brief --task T4 --note "fix comment-analyzer-1"
```

`reopen-task` is the engine operation that makes an `implemented` Task of the active Wave dispatchable again ([ADR-0045](../adr/ADR-0045-an-implemented-task-is-reopened-through-one-engine-operation.md)). Under the TaskGraph lock it requires all of the following:

- the execute Phase, with `--wave` equal to `current_wave`;
- no completed history for that Wave;
- `active_wave_gate` absent, or an abandoned tombstone for that Wave that names no successor (abandoning with `--superseded-by` authorizes exactly that successor, so start it instead);
- no executing Task, no active implementation attempt, and no active subagent (checked before and under the lock);
- every `--task` (one or more, distinct) is `implemented` in that Wave, with an implementation lineage that can derive a dispatch (an escalated lineage is remediated first, with `helper orchestration remediate`);
- a non-blank `--reason` of at most 512 characters.

It then applies the transition a Contract Revision uses. The abandoned run's review epoch, spec-check, suite receipt and tombstone are retired, and review evidence that run accepted is kept as Findings. Each named Task returns to protected `pending` revalidation at a new Review Generation, and its Findings stay as prior Findings for the next Review Run. The Wave's gate bits reset (`impl_complete: false`, `tests_passed: null`, `reviews_complete: false`), and the Wave's other Tasks stay `implemented`, except its `implemented` Distill Task, which returns with them (see [The distill pass](../verification.md#the-distill-pass-distill-task)). One `implemented-tasks-reopened` audit is appended to `task_reopening_history`, recording the Wave, the Task ids, the Distill Tasks among them that the engine swept back unnamed (`sweptDistillTaskIds`, absent when there is none), the reason, and the abandoned run id (or `null`). Status then owes each reopened Task an `initial-implementation` dispatch, `brief` renders it, and the Wave Gate cannot start until each settles afresh. Re-running the same command while those Tasks still await re-implementation changes nothing. The same request after they are `pending` but with a different reason, or for a Task that is no longer `implemented`, is refused. `populate-task-graph --force` is never the recovery: it resets every Task and discards all settled evidence.

## Completed Wave has post-review workspace-integrity loss

A completed Wave may be reopened only through Loom's independent immutable Review Packet authority. This is the recovery for a missed remediation invalidation; do not edit the graph or decrement a Review Generation.

<!-- wire-example: completed-wave-reopening -->
```bash
cat > /tmp/reopen-wave-3.json <<'JSON'
{"runId":"<completed-run-id>","wave":3,"authorityDigest":"<completed-authority-digest>","taskIds":["T19","T22"]}
JSON
bun "$LOOM_DIR/engine/src/cli.ts" helper reopen-completed-wave \
  --runs-root ".claude/reviews/wave-gate-runs" < /tmp/reopen-wave-3.json
```

For modern packets, `workspaceHeadSha` lets the helper derive exactly the completed Tasks whose declared bytes drifted. For historical packets without it, `headSha` is only a batch epoch and is never compared with current bytes: the helper records `legacy-workspace-authority-unverifiable` and requires every completed Task in that Wave. The payload Task list must equal that mode's engine-derived list in protected order. The helper requires execute phase, `current_wave === wave + 1`, no active Wave Gate, and no later-Wave Task progress evidence. It re-proves authority under the StateManager lock, removes only that completed Wave's terminal entry, restores `current_wave`, increments and invalidates reopened Tasks' review generation, and preserves all historical proof, test, artifact, and Finding bytes. Each reopened Task is instead returned to protected `pending` revalidation state; the Wave Gate resets `impl_complete: false`, `tests_passed: null`, and `reviews_complete: false`. Re-spawn **every reopened Task** before starting a new Wave Gate. The implementation Agent may make no production change when current code is correct, but it must run tests and stop with fresh task-linked test evidence; only that stop clears revalidation. An exact replay after success is idempotent; a changed payload is refused. Start a normal fresh Wave Gate only after every reopened Task revalidates.

## Active graph uses the legacy Requirement trace contract

Legacy graphs without `spec_trace_version` remain readable and auditable. To upgrade exactly one active legacy graph, prepare JSON covering the exact existing Task roster in protected order; provide both arrays for every Task:

<!-- wire-example: spec-trace-ownership -->
```json
{
  "spec_trace_version": 2,
  "tasks": [
    {"id":"T1","spec_anchors":[],"spec_contributions":["FR-001"]},
    {"id":"T2","spec_anchors":["FR-001"],"spec_contributions":[]}
  ]
}
```

Then run the sanctioned atomic helper (use `.pi/state/...` through Loom's normal `LOOM_STATE_PATH` under Pi):

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper upgrade-spec-trace \
  < /path/to/exact-trace-ownership.json
```

The helper uses StateManager's lock, validates the resulting v2 graph through the same pure trace parser used by normal loading and `validate-task-graph`, and changes only `spec_trace_version`, `spec_anchors`, and `spec_contributions`. It rejects duplicate, missing, reordered, or foreign roster entries; stale conflicting replays; active subagents; and invalid ownership. An exact replay is idempotent.

By default the helper refuses while protected `active_wave_gate` authority exists. Normally, resume and finish that registered Wave Gate until the engine archives it and clears active authority. If the run is blocked specifically because its legacy Requirement scope is wrong, finishing it is impossible. Use this explicit retirement sequence instead, substituting the exact `runsRoot` and `runId` stored in `active_wave_gate`:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration abandon \
  --runs-root "<exact-protected-runsRoot>" \
  --run "<exact-protected-active-runId>" \
  --reason "legacy Requirement scope prevents this Wave Gate from completing"

bun "$LOOM_DIR/engine/src/cli.ts" helper upgrade-spec-trace \
  --retire-abandoned-run \
  < /path/to/exact-trace-ownership.json
```

Usually omit `--superseded-by` and start the replacement only after migration. If an already-created successor Run Directory was deliberately named during abandonment, the upgrade re-proves that exact direct child and preserves the pointer as audit data; it does not install the successor as protected authority. The upgrade opens the exact protected Run Directory, proves its engine-owned Wave Gate program (Wave, Task roster, and authority digest), reads the immutable abandonment marker, then repeats those proofs under StateManager's lock. Missing/unreadable/foreign markers, authority drift, missing or foreign supersession targets, and non-abandoned runs cause no TaskGraph mutation.

On success, one immutable `SpecTraceWaveGateRetirement` audit preserves the old run id, Wave, authority digest, revision, runs root, and exact abandonment reason/supersession. The same locked commit installs trace v2 and retires the run's review authority as a successor install would, except that another Wave's `spec_check` and its block are left alone: it clears `active_wave_gate`, `wave_review_epoch`, `active_wave_completion_suite`, the retired Wave's `spec_check`, the Wave's in-flight `review_run`s, and review acceptance granted by the abandoned run (those reviews reopen), and re-derives the retired Wave's block. Tasks, proofs, Findings, Review Generations, Refutations, Resolutions, issued packets, completed/orphan retirement history, and implementation evidence remain intact, so the next `start wave-gate` installs cleanly. An exact replay does not append another audit; a different mapping remains refused.

## Amending a v2 Requirement trace

A populated v2 graph whose Completion Claims or Contributions are wrong (a Requirement claimed by the wrong Task, a missing Contribution) is corrected in place, not by `populate-task-graph --force`. Re-population resets every Task to `pending` and discards all settled implementation, review and refutation results; an amendment keeps them. Prepare the same exact-roster JSON as the legacy upgrade, every Task once in protected order (each Distill Task too, with two empty arrays), then:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper amend-spec-trace \
  < /path/to/exact-trace-ownership.json
```

Arrays compare as sets, so a reordering is not an amendment and an exact replay writes nothing. The helper refuses, without writing, when:

- the input is not the exact Task roster in order, or a Task's array repeats an id;
- the graph is legacy (use `upgrade-spec-trace`) or not in the execute Phase;
- any Task is executing or a subagent is active;
- a Wave Gate is live: its review packets froze the old trace, so first run `helper orchestration abandon` on it. A `terminal-abandoned` tombstone is accepted and retired; a legacy terminal (`done` or `terminal-blocked`) registration is refused too and must first be migrated to terminal history;
- any Task in a completed Wave (`wave_gate_history`) would change. Completed Waves are verified scope, so moving a Completion Claim into or out of one is refused too;
- an added id is not a completable FR/AS entry in the Spec Index observed now, or that Spec Index is unavailable (fail closed; removals still apply), or `spec_file` moved during the call;
- the result breaks v2 ownership (`parseSpecTraceContract`).

On success, one locked write:

- replaces only the changed Tasks' `spec_anchors`/`spec_contributions`;
- keeps the recorded Requirement Content Hash of every retained Completion Claim (drift evidence survives), mints one from the observed Spec Index for every added claim, and drops removed claims' hashes;
- retires the current Wave's trace-derived review authority. Over an abandoned tombstone this is what a successor gate install does: it clears `review_run`, the current Wave's `spec_check`, `wave_review_epoch`, `active_wave_completion_suite`, the tombstone, and review acceptance granted by that run, and re-derives Wave blocks. Another Wave's `spec_check` and its block are left alone. With no gate registered, the same reset runs only if some of that review state is left for the current Wave; otherwise nothing else changes, so an older Wave's `spec_check` survives;
- appends a `spec_trace_amendments` audit naming the Wave, the retired run (or `null`), each change before and after, and the Spec Index observation.

Task status, proof, attempt history, test evidence, Findings, Refutations, Resolutions and completed history are untouched, so nothing is re-implemented. Start the Wave Gate next: it issues fresh packets over the amended trace, and spec-check and reviewers judge the new scope. The State File boundary refuses a graph whose trace contradicts a Task's latest amendment, or whose amendment history for a Task does not chain, and re-population drops the audit together with the Tasks it described.
