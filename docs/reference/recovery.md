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

`attest` refuses a live attempt, an escalated lineage (remediate first), a satisfied proof, a repeat (`already in attestation mode`), and an unknown Task — all without touching state. It rewrites exactly the proof surface under the TaskGraph lock: one scope-wide attestation obligation plus one attested obligation per declared artifact, a regression-required/new-tests-waived stored policy (the legacy `new_tests_required` boolean is cleared, not flipped — a `false` there would contradict the required regression at the load boundary), and the `implementation_attestation: true` flag. Lineage, baselines, and history are untouched. The dispatch binding requires the engine-derived `LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT` line on every dispatch and refuses it on non-attestation Tasks. The attested child must change nothing inside the attempt scope: any byte move fails the scope obligation and terminalizes that attestation lineage, so it can never become a refreshed attempt-2 baseline. Restore the intended bytes, then use the exact terminal receipt with `remediate` before another proving round. The classified regression still runs. Reconcile measures drift against the attempt baseline (never the population baseline), so pre-existing population-relative changes are the attested work, not writes. Any revalidation ends attestation mode: `reopen-task`, a Contract Revision and `reopen-completed-wave` exist because the Task's bytes may change, so they clear `implementation_attestation` and give the Task a fresh pending Proof under its current (attestation) policy, with new tests still waived, and its agent's normal declared-artifact expectation. Re-arm `attest` afterwards only if the reopened work turns out to need no change.

## Adopting engine-run test evidence on a live graph

A TaskGraph populated before engine-run test evidence existed admits an agent's own test commands, so a project whose runner Loom reads no report from (mocha, say) can never show a qualifying I6 red: its Tasks fail with `red-missing` (`untrustedOnly: true`) on both attempts. Once the frozen manifest declares an `affectedRunner` that writes a JUnit report, adopt engine-run evidence:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration adopt-engine-run-tests \
  --reason "<why: e.g. the project runner writes no report the recorder reads>"
```

It refuses outside execute, while any implementation attempt is reserved or a subagent is active, and when the frozen manifest has no `affectedRunner`; it is idempotent. The adoption is recorded on the field with the reason. From then on every brief carries the **Test evidence: engine runs only** paragraph with the `helper run-tests` call. A Task whose attempt 2 already failed I6 under the old mode needs `remediate` with its terminal receipt before it is dispatched again ([Implementation escalation](#implementation-escalation-semantic-attempt-2-exhausted)).

## The engine changed under a live orchestration

Population pins the TaskGraph to the Loom engine revision it ran on (`engine_revision`: the content-addressed runtime revision of the installed package; loom#198, Cause 4). The State File's one write boundary refuses to persist a graph pinned to any other revision, so hooks and helpers on a different engine never judge the run by different rules. Reads and the guards are unaffected. The refusal names both revisions and leaves the State File untouched.

When the plugin checkout changed (a pull, a merge, a branch switch), either restore the engine the run was pinned to, or continue on the running one:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration adopt-engine-revision \
  --reason "continue on main after the fix for #196"
```

It requires no active subagent (checked before and under the lock) and a non-blank `--reason` of at most 500 characters. It moves the pin to the running revision and appends `{ from, to, reason }` to `engine_revision.adoptions`, an unbroken chain the State File parser checks. A graph populated before pins existed has no pin and is not enforced; adopting gives it its first one (`from: null`). Re-population keeps an existing pin, so re-populating with `--force` on another engine is refused like any other write; adopt first. Repeating it on the running revision changes nothing. A project that holds the engine package itself (Loom orchestrating its own checkout in place) is recorded as `self-hosted`, since every Wave changes the engine it runs on; nothing is enforced there and adoption is refused. Develop Loom in a worktree, never in the checkout the plugin path points at.

A settlement refused for a revision mismatch leaves its attempt unsettled: adopt (or restore the engine), then dispatch the Task again from its brief.

## A run that replays its own failure

A run replays the results it recorded: resuming it after an engine fix shows the same blocked diagnostic, because the fix never re-judges what the run already holds. Abandon it (`helper orchestration abandon`) and start a fresh run with a new `--run` id; resuming an abandoned run says which (`advance <successor>` when it names one, otherwise start a fresh run).

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

## Re-scoping a pending Task

Use this when a pending Task's `file_list` cannot satisfy its policy, most often a Task that owes red-then-green with no test file in its list (its attempt can only fail I6 with `no-test-files`), or when a pending Task must give a file up or take one on. Do not use `populate-task-graph --force`, which resets every Task.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration rescope-task \
  --task T8 --add-file tests/unit-test/t8.test.ts --reason "T8 owes I6 but listed no test file"
```

`--add-file` and `--remove-file` are repeatable; name at least one, and no path twice. Under the TaskGraph lock `rescope-task` requires:

- the precondition `reopen-task` uses (execute Phase, no live Wave Gate run, no executing Task or attempt), and no active subagent (checked before and under the lock);
- the Task to be `pending`, in the active Wave or a later one, not a Distill Task and not armed for attestation (an `implemented` Task is reopened first);
- every added path to be free: no protected verification path, no path another Task of the same Wave lists, and no frozen Acceptance Contract path unless the Task is that contract's writer;
- a path a completed Wave's Task lists to be named with `--add-sealed-file`, and every `--add-sealed-file` path to be one (ADR-0081); plain `--add-file` refuses a sealed path;
- the Task, after the edit, to list every member of a coupled file set it lists any member of, as far as any Task of the graph lists them: a package manifest and the lockfiles beside it change together (ADR-0082). To move a set onto one Task, first remove the member from the Task that holds it, then add the whole set to the Task that takes it;
- every removed path to be one the Task lists (or one an earlier re-scope of it already removed, so a repeat is a no-op), none the plan's export bindings name, and the list never to become empty;
- a Task that owes red-then-green to keep a test file under the frozen classification;
- a non-blank `--reason` of at most 500 characters.

The Task's Proof is re-derived for the new list, recorded skeleton outcomes of removed paths are dropped, and its attempt baseline is cleared for the next registration to capture. A Task that already carries a population baseline (`artifact_baseline`, from population or an earlier attempt) has it extended: the helper reads each added file as Git held it at the Task's `start_sha`, outside the lock, and the commit refuses bytes read at any other revision, so Proof judges an added file from the same boundary as the rest. A request that adds a file to a Task with a baseline but no `start_sha` is refused. One `task-rescoped` audit is appended to `wave_plan_edits` (Wave, Task, added and removed paths, the added paths that were sealed, the `start_sha` the added files were read at or `null`, and the reason). Repeating a request that is already applied changes nothing. Then dispatch the Task from `helper orchestration brief --task <id>`.

## Ordering Tasks within the active Wave

Use this when one pending Task of the active Wave must run after another, for example a benchmark after the code it measures. Do not order Tasks with operator notes; the engine does not read them.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration add-dependency \
  --task T12 --on T25 [--on <task-id>]... --reason "T12 benchmarks the code T25 changes"
```

Under the TaskGraph lock `add-dependency` requires the precondition `reopen-task` uses, no active subagent, and:

- the Task to be `pending` in the active Wave, not a Distill Task and not armed for attestation;
- every `--on` Task to exist, to be in the active Wave or an earlier one, and not to be a Distill Task;
- no edge to close a cycle; the refusal names it (`T28 → T12 → T25 → T28`).

A dependency in the same Wave is satisfied once that Task has settled its implementation (ADR-0081); one in an earlier Wave once it is `completed`. Status, registration and the brief withhold the waiting Task under one rule, the `dependency` Dispatch Hold. When a dependency reaches terminal escalation, status escalates the Wave and names the Tasks blocked behind it; remediate the escalated Task and they run. One `dependency-added` audit is appended to `wave_plan_edits`, and the State File refuses a same-Wave edge no such audit records. Repeating an applied request changes nothing.

## A judgement fails on code a completed Wave sealed

Use this when a Task of the active Wave judges code that a completed Wave wrote (a budget, benchmark or acceptance test) and its attempt failed because that code breaches the judgement. Neither `reopen-task` (active Wave only) nor `reopen-completed-wave` (drifted bytes only) applies, and the judge cannot change code outside its own file list. Append a Forward Fix to the active Wave instead ([ADR-0077](../adr/ADR-0077-a-judgement-lands-while-its-subject-is-open-and-is-fixed-forward-otherwise.md)):

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration add-forward-fix \
  --wave 5 --hold T12 \
  --file dags/direct-sales/leads/lead-scoring/dag.ts --file lib/lead-snapshot/recompute.ts \
  --description "Bring per-request and recompute memory under the spec budgets" \
  --reason "T12's CI budget test: accountManager request 33.8 MB > 10 MB; recompute 158.3 MB > 150 MB"
```

Under the TaskGraph lock it requires the Wave-reopening precondition `reopen-task` uses (execute Phase, `--wave` equal to `current_wave`, no completed history for it, no live Wave Gate or a tombstone naming no successor, no executing Task, attempt or subagent), and:

- every `--hold` Task (one or more, distinct) is an authored Task of that Wave whose last implementation attempt failed: it is owed the engine-authorized retry, or it escalated;
- at least one `--file` (one or more, distinct, repository-relative) is in the file list of a Task of a completed Wave;
- no `--file` is in another Task's file list in the active Wave, a frozen Acceptance Contract path, or protected verification infrastructure;
- a non-blank `--description` and `--reason`; `--agent` defaults to `code-implementer-agent` (also `frontend-agent`, `security-agent`), and `--new-tests` to `required` (`existing-tests-sufficient` when the held judge's tests are the fix's whole proof).

It appends a pending fix Task with the next free Task id, no dependency and no Requirement trace, whose plan context names the held Tasks, the sealed paths and the reason. It retires the Wave's review authority as a reopening does, resets the Wave's gate bits, and appends one `forward-fix-added` audit to `forward_fix_history`. Completed Waves and every existing Task are untouched. Status then owes the fix Task's dispatch, while each held Task stays under a dispatch hold until the fix is implemented and unreserved; a held Task's escalation is deferred until then. Once the fix settles, status offers the held Task's retry, which judges the fixed code. An escalated held Task is remediated with `helper orchestration remediate` after the fix settles. Repeating the same command while the fix Task is still pending changes nothing. `--description` and `--reason` must be text the fix Task's brief can carry, as an operator note must: one line, with no `{template variable}`, no `LOOM_` token and no `Task ID:` binding.

To withdraw a Forward Fix before its fix Task was ever dispatched (for example, to correct its text), run:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration withdraw-forward-fix \
  --wave 5 --task T24 --reason "re-adding with corrected text"
```

It requires the same active, open Wave `add-forward-fix` requires (including no abandoned run naming a successor), a fix Task of a live `forward_fix_history` audit of that Wave, and that Task still exactly as it joined: no reservation, attempt, settlement, observation or review has written any of its evidence fields (`isUntouchedJoinedTask`). It removes the fix Task from the roster and moves the audit whole into `forward_fix_withdrawals`, together with your reason. The held Tasks are released, and the withdrawn id is never minted again. Add a corrected Forward Fix afterwards if the judgement still needs one. A fix Task that was already dispatched is not withdrawn: let it settle, or reopen it.

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
- any Task in a completed Wave (`wave_gate_history`) would change. Completed Waves are verified scope, so moving a Completion Claim into or out of one is refused too; the one exception is removing an id the Spec Index does not define as a completable FR or AS entry (for example a Success Criterion id left by a graph populated before trace admission), which was never verified scope. That removal needs a readable Spec Index, and the completed Task may add nothing and lose no FR or AS id in the same amendment;
- an added id is not a completable FR/AS entry in the Spec Index observed now, or that Spec Index is unavailable (fail closed; removals still apply), or `spec_file` moved during the call;
- the result breaks v2 ownership (`parseSpecTraceContract`).

On success, one locked write:

- replaces only the changed Tasks' `spec_anchors`/`spec_contributions`;
- keeps the recorded Requirement Content Hash of every retained Completion Claim (drift evidence survives), mints one from the observed Spec Index for every added claim, and drops removed claims' hashes;
- retires the current Wave's trace-derived review authority. Over an abandoned tombstone this is what a successor gate install does: it clears `review_run`, the current Wave's `spec_check`, `wave_review_epoch`, `active_wave_completion_suite`, the tombstone, and review acceptance granted by that run, and re-derives Wave blocks. Another Wave's `spec_check` and its block are left alone. With no gate registered, the same reset runs only if some of that review state is left for the current Wave; otherwise nothing else changes, so an older Wave's `spec_check` survives;
- appends a `spec_trace_amendments` audit naming the Wave, the retired run (or `null`), each change before and after, and the Spec Index observation.

Task status, proof, attempt history, test evidence, Findings, Refutations, Resolutions and completed history are untouched, so nothing is re-implemented. Start the Wave Gate next: it issues fresh packets over the amended trace, and spec-check and reviewers judge the new scope. The State File boundary refuses a graph whose trace contradicts a Task's latest amendment, or whose amendment history for a Task does not chain, and re-population drops the audit together with the Tasks it described.
