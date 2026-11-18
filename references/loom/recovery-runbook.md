# `/loom` Recovery Runbook

Read by the `/loom` orchestrator before it does any of the following:

- acts on a `blocked` status that the Phase 5 list in `commands/loom.md` does not cover;
- fixes a blocked Wave or overrides a false-positive finding;
- runs any helper directly that `commands/loom.md` or another runbook did not name;
- repairs a State File the engine reports as corrupt;
- completes or abandons the orchestration.

`{LOOM_DIR}` means what `commands/loom.md` Setup defines. Every direct helper invocation in this file needs the user's approval first.

## Status is the authority

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper orchestration status          # human
bun {LOOM_DIR}/engine/src/cli.ts helper orchestration status --json   # machine
```

Both forms render one value, so they cannot disagree. Status reports the active Phase and Wave, the five-way Task partition, failed proof obligations, test readiness, Review Run roster gaps and evidence failures, the Finding counts, Refutation Panel need, completion-suite readiness with `projectVerificationCoverage`, Wave Gate completion eligibility, exactly one typed next action, and every reason behind it. It reads stored results and never runs a verification command.

- A category shown as `unavailable` is a real answer: the authority behind that fact could not be parsed, and the next action is `blocked` with the reason attached. Relay it; never substitute a zero or a "ready".
- The next action's recovery is at `next.action.diagnostic.recovery` in the JSON form. Do what it says and nothing else.
- When you relay a result, relay Project Verification Coverage as [`/wave-gate`](../../commands/wave-gate.md#completion-suite-and-project-verification-coverage) describes it. `configured` is not a pass, and an engine-only suite is reported as **Project verification NOT CONFIGURED**, never as "project verification passed".

### Reading raw state

These read stored fields directly. Use them to inspect one stored value. They do not reproduce the engine's readiness logic: a Task that looks `implemented` here may still be ineligible to advance, and a missing field reads as absent when it is really an authority failure. Never derive a gate decision or a re-spawn from them:

```bash
jq '.' .claude/state/active_task_graph.json
jq '.tasks[] | {id, status, test_result, review_status}' .claude/state/active_task_graph.json
jq '.wave_gates' .claude/state/active_task_graph.json
```

A Task that is still running stays `pending`; it is tracked in `executing_tasks`, and there is no `in_progress` status. Wait for it; do not duplicate it.

## Fixing a blocked Wave

When a Wave Gate is blocked by critical findings, your own Edit and Write are blocked too.

1. **Fix through a subagent**, by [Acting on a Finding](../../commands/wave-gate.md#acting-on-a-finding): abandon the run, `reopen-task`, and spawn the fix agent from the reopened Task's brief with the findings as its `--note`s. Never use `populate-task-graph --force`; it resets every Task.
2. **Run a fresh `/wave-gate`.** It reviews the fix.

## The engine changed under a live orchestration

A write refused with "This TaskGraph is pinned to Loom engine revision …" means the plugin checkout changed since population. Tell the user. With their approval, continue on the running engine (or have them restore the pinned one):

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper orchestration adopt-engine-revision --reason "<why this engine>"
```

Then re-read status; a Task whose settlement was refused is dispatched again from its brief. The full contract is in `docs/reference/recovery.md` (The engine changed under a live orchestration).

## A pending Task's file list cannot satisfy its policy

A pending Task that owes red-then-green but lists no test file can only fail I6 with `no-test-files`; its agent reports that instead of finishing. Do not spend its retry and do not re-populate. With the user's approval, add the test file it needs (or move a file between pending Tasks) in place:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper orchestration rescope-task \
  --task <task-id> --add-file <test path> [--add-file <path>]... [--add-sealed-file <path>]... [--remove-file <path>]... \
  --reason "<why the Task's file list changes>"
```

A file a completed Wave sealed joins only through `--add-sealed-file`. A package manifest and its lockfile belong to one Task: move a member off the Task that holds it first, then add the whole set to the Task that takes it. Then dispatch the Task from its brief. The full contract is in `docs/reference/recovery.md` (Re-scoping a pending Task).

## One Task of the Wave must run after another

With the user's approval, make the order an engine-enforced dependency instead of an operator note:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper orchestration add-dependency \
  --task <task-id> --on <task-id> [--on <task-id>]... --reason "<why it must wait>"
```

Status then withholds the Task until its dependencies settle, and names it as blocked when one of them escalates. A cycle is refused. The full contract is in `docs/reference/recovery.md` (Ordering Tasks within the active Wave).

## A judgement fails on code a completed Wave sealed

A Task of the active Wave whose tests judge code an earlier, completed Wave wrote (a budget, benchmark or acceptance test) may fail its attempt on that code's breach. It cannot change code outside its own file list, `reopen-task` reaches only the active Wave, and a completed Wave is not reopened for this. Never spend the judge's retry on unchanged code, and never relax the judgement.

With the user's approval, append a Forward Fix to the active Wave for the breaching files, holding the failed judge until it settles:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper orchestration add-forward-fix \
  --wave <N> --hold <judge-task-id> --file <sealed path> [--file <path>]... \
  --description "<what the fix changes>" --reason "<the failed judgement, with its measured values>"
```

Keep `--description` and `--reason` to one line with no `{variable}`, no `LOOM_` token and no `Task ID:` binding: the fix Task's brief carries them. A fix whose Task was never dispatched can be withdrawn with `helper orchestration withdraw-forward-fix --wave <N> --task <fix-task-id> --reason "<why>"` and added again.

Then return to the Phase 5 loop: status owes the fix Task's dispatch (render it with `brief`, adding the breach as `--note`s), and the held judge's next attempt once the fix settles. The preconditions and what the helper writes are in `docs/reference/recovery.md` ("A judgement fails on code a completed Wave sealed").

## Overriding a false positive

Only when a finding is wrong, and only with the user's approval. Pipe the corrected findings through the helpers the state guard allows:

```bash
# Spec-check override (for example, FRs covered in later waves flagged as missing)
echo 'SPEC_CHECK_WAVE: N
SPEC_CHECK_CRITICAL_COUNT: 0
SPEC_CHECK_VERDICT: PASSED
MEDIUM: reason for override' | bun {LOOM_DIR}/engine/src/cli.ts helper store-spec-check

# Review-findings override (for example, a false critical downgraded to advisory)
echo 'ADVISORY: original finding — reason for downgrade' | bun {LOOM_DIR}/engine/src/cli.ts helper store-review-findings --task T1
```

Then return to the registered Wave Gate: resume its exact Run Directory with `helper orchestration resume`, or start a fresh `/wave-gate` when no registration is active. For a TaskGraph that has a `verification_manifest`, never run `complete-wave-gate` directly: it is legacy-only and refuses.

## Helpers you may run directly

Hooks and `/wave-gate` drive most state-writing helpers themselves (`complete-wave-gate`, `store-review-findings` and `store-spec-check` outside the override above). Calling one of those by hand races the hook that owns the write. The direct invocations below are sanctioned, each only where a Loom document says to use it.

**Allowed by the state guard on a guarded path** (`WHITELISTED_HELPERS` in `engine/src/core/guard-state-file.ts`):

| Helper | When |
|---|---|
| `write-verification-manifest`, `populate-task-graph` | Phase 4d |
| `set-phase` | Loop-back to an earlier phase (Phase 3.5, Phase 4a) |
| `amend-spec-trace` | Correcting a Requirement trace in place after population |
| `amend-spec` | Changing the specification's text while the TaskGraph is live (ADR-0087) |
| `revise-contract` | Operator Contract Revision of a frozen Acceptance Contract |
| `mark-tests-passed` | Read-only evidence status check during `/wave-gate`; it does not modify state |
| `repair-task-graph` | Corrupt State File (below) |
| `review-packet create` | Starts the packet-bound Review Run |
| `store-review-findings`, `store-spec-check` | The false-positive overrides above |
| `cleanup-state` | Abort (below) |
| `record-retro` | Recording a written or skipped retro (Completion, below; `/retro`) |

The guard's list also holds `complete-wave-gate`, `store-test-evidence`, `reconcile-implementation-proof` and `upgrade-spec-trace`. Run one of those by hand only for a recovery that `docs/operations.md` or `docs/reference/recovery.md` names.

**Outside the guard's scope when invoked as documented** (they name no guarded path):

- `validate-task-graph`, `validate-lint-rules`, and `lint-wave-gate` (a diagnostic; the registered Wave Gate runs the same full-tier lint itself).
- `orchestration status`, `contract-status`, `retro-facts` and `stop-check-plan --task <id>`: pure reads of the State File that write only to stdout. `retro-facts [--wave <N>] [--graph <path>]` prints the friction the run recorded, for `/retro`. `contract-status` takes no arguments and prints each Acceptance Contract's freeze state, roster and due Waves. `stop-check-plan` prints what the Acceptance Stop Check would do at that Task's stop, or the one reason the check is off; it refuses an unknown Task id with a non-zero exit. See `docs/reference/helpers.md`.
- `panel-contract` (the architecture panel), `review-panel` and `standalone-review`: each writes only into a run directory under the runs root it is given (`.claude/specs/{date_slug}/panel-runs/`, `.claude/reviews/panel-runs/`, `.claude/reviews/review-and-fix-runs/`). Invoked against a guarded path they are blocked like anything else.
- `accept-plan-design-review` (Phase 3.6): its arguments name only a runs root under `.claude/reviews/`, and its one State File write goes through the engine's locked writer.

**`review-panel tally` is the exception in that class.** It writes the TaskGraph: it moves refuted findings into `refuted_findings` and can change `review_status` from `blocked` to `passed`. The registered Wave Gate runs its own Refutation Panel and never calls it. It refuses a second tally on a run it has already adjudicated, and refuses `--threshold`. Do not invoke it to "re-check" a Wave.

Everything else is driven by hooks.

## Repairing a corrupt State File

When the engine reports a corrupt graph and names `repair-task-graph`, run:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper repair-task-graph
```

Set `LOOM_STATE_PATH` only when repairing a non-default graph. The helper refuses if repair would drop findings or audit data, and leaves the State File read-only. Do not redirect `validate-task-graph --fix` into the guarded State File; the guard blocks it.

## Completion

`/loom --complete` is not a flag. After the final Wave Gate reports `done`, run `/retro` for the whole run; it writes the retro under `.claude/retros/` and records it with `helper record-retro --file <path>`. Only when the user agrees the run needs no retro, record a skip with `helper record-retro --skip --reason "<why>"`. Then retire the orchestration:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper complete-orchestration
```

It refuses, naming each reason, unless every Task is `completed`, no Wave Gate run is active, and a whole-run retro is recorded (ADR-0083). On success it archives the graph beside the live one as `completed_task_graph-<issue>-<stamp>.json` and removes the live graph. Every Loom guard then lifts, so a later `/review-and-fix` can run in the same checkout.

## Abort

`/loom --abort` is not a flag. Only when the user explicitly confirms abandoning an unfinished run, tear it down with the helper; a direct `rm` of the State File is blocked:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper cleanup-state
```

It keeps no copy. Keep the specs, plans and review Run Directories as audit and recovery evidence, and close or keep the GitHub Issue as the user prefers. The hooks deactivate once the State File is gone.
