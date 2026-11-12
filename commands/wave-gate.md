---
name: wave-gate
version: "3.0.0"
description: "Run the engine-owned Wave Gate lifecycle after wave implementation completes. Usage: /wave-gate"
---

# Wave Gate

Run this after the implementation hook reports that the active Wave is
implemented, including the Wave's Distill Task. The engine owns everything
except spawning the returned batch and relaying decisions: protected-state
verification, test readiness, the completion suite, Review Packets, reviewer
selection, retries, aggregation, Refutation Panel routing, advisory suspension,
full-tier lint and Wave advancement.

**Arguments:** "$ARGUMENTS"

Resolve the active Loom package once:

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR. Repair or reinstall that package, then retry /wave-gate." >&2; exit 1; }
```

The runs root must exist; the engine never creates it. Name one fresh run id
and start the registered program. `start` creates the Run Directory; `--run`
takes either the bare run id or a full path to that same direct child of
`--runs-root`:

<!-- wire-example: wave-gate-start -->
```bash
mkdir -p ".claude/reviews/wave-gate-runs"
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start wave-gate \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<fresh-run-id>" <<'JSON'
{"wave":null}
JSON
```

`start` preflights before creating the directory. A non-zero exit means it
claimed nothing: unmet start prerequisites (executing Task, implementation
proof, test evidence, new tests), a Wave another live run owns, a completed
Wave, or — under a Verification Manifest — full-tier lint. Fix the named cause
and rerun `start` with the same fresh run id; there is nothing to `abandon`.

Execute only the one typed action returned by `start`, `resume`, or `decide`:

- `spawn-batch`: spawn every exact request, preserving its model, required
  Skill, task text, context reference, and `LOOM_REQUEST_ID`. Claude may send
  the semantic batch in one message. Pi's native subagent transport accepts at
  most eight requests per call, so partition larger batches into ordered
  chunks of at most eight without changing, dropping, or duplicating any
  request; resume only after every chunk finishes. The initial Wave review
  batch is one spec-check request plus each Task's reviewer roster: five
  reviewers, or six (`architecture-tech-lead` appended) for a Task touching an
  owned Invariant's family, which carries the owner map (ADR-0047), and for a
  Contract Task writing its contract's types file, which carries the contract
  surface (ADR-0069). The
  Wave's Distill Task (agent `distill-agent`, the engine-added pass that
  simplified the Wave's code, ADR-0068) is registered with the Wave but gets no
  reviewer: the other Tasks' packets read the distilled bytes. Never infer the
  count; spawn exactly the requests returned.
- `await-user`: present the advisory findings the request references exactly as
  supplied, and ask the operator whether to approve them. The only decision a
  Wave Gate accepts is approval (below).
- `blocked`: stop and report the diagnostic. Do not bypass or reconstruct it.
- `done`: report the completion receipt and newly protected Wave state, alongside the canonical Project Verification Coverage described below. The receipt alone does not claim every project verification category passed. After the final Wave, retire the orchestration with `bun ${LOOM_DIR}/engine/src/cli.ts helper complete-orchestration`. Until then, Loom's guards stay on.

After a harness batch finishes, resume the same run:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration resume \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<same-run-id>"
```

For an `await-user` action the operator approves:

<!-- wire-example: wave-gate-decision -->
```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration decide \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<same-run-id>" \
  --request "<exact-decision-request-id>" <<'JSON'
{"kind":"approve"}
JSON
```

The decision must be exactly `{"kind":"approve"}`; any other object is refused
and nothing is recorded. Approval lets the gate continue past its advisories to
lint and completion. To act on an advisory (or a surviving critical) instead, do
not decide: follow [Acting on a Finding](#acting-on-a-finding).

Classify every advisory before approving. Relevant (in scope for the Task,
actionable, consistent with project conventions): fix through Acting on a
Finding. Not relevant (out-of-scope refactor, contradicts a project convention,
false positive, deliberately deferred): record a one-line reason. Every advisory
ends fixed, deferred (reason) or dismissed (reason).

At a contract Wave's pause, read `helper orchestration status` before deciding.
An `acceptance-freeze-pending` reason names every advisory on a file this
gate's Acceptance Freeze stamps when it completes. Receipt installation does not
freeze anything, and neither does abandoning the run. Approving freezes those
files as they are, and changing them afterwards needs a Contract Revision. So
present those advisories first, and fix the relevant ones before approving by
reopening the contract Task through [Acting on a Finding](#acting-on-a-finding).

Resume is idempotent. The harness writes each agent's final bytes into the
engine's slots. Never write transcripts, build manifests, select models, tally
findings, mutate the protected State File, or stage deterministic operation
output in the parent.

## Acting on a Finding

The one procedure for fixing a Wave Gate Finding (a relevant advisory at the
pause, or a critical that blocks the Wave) without discarding the Wave's
settled evidence. `/loom` points here; this is the only place it is spelled out.

```bash
# 1. Abandon the run, naming no successor.
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration abandon \
  --runs-root "<exact-active_wave_gate.runsRoot>" \
  --run "<exact-active_wave_gate.runId>" \
  --reason "<why: the Finding to fix>"

# 2. Reopen each affected implemented Task of the active Wave.
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration reopen-task \
  --wave <N> --task <task-id> [--task <task-id>]... \
  --reason "<the Finding to fix>"

# 3. Dispatch each reopened Task from its brief, carrying the Finding.
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration brief \
  --task <task-id> --note "<the Finding to fix>"
```

4. Once every reopened Task settles, start a fresh Wave Gate with `start
   wave-gate` and a fresh run id (above).

Reopening returns each named Task to revalidation, so status owes it a fresh
dispatch (an `implemented` Task gets no brief, and the spawn gate refuses it).
Its Findings stay as prior Findings for the next Review Run, the abandoned
run's review and suite authority is retired, and the Wave's other Tasks stay
`implemented`. The fix subagent spawns from that brief and can Edit/Write; the
orchestrator cannot. Never use `populate-task-graph --force`, which resets
every Task.

`reopen-task` refuses outside the execute Phase, while a Wave Gate run is live,
while any implementation reservation, attempt or subagent is active, for a Wave
other than the active one or one that already completed, when the abandoned run
names a successor, and for any Task that is not `implemented` in the active
Wave. Repeating the same command after it succeeds changes nothing.

## Reviewer evidence

Reviewers return one JSON payload; the engine admits or retries it. A
malformed payload is failed evidence, never a Finding. Surviving criticals
block.

`helper store-review-findings` is an explicit operator override, separately
audited. Use it only when the operator asks for it: never invoke it
automatically, and never as a fallback for a reviewer whose output was
refused. Protocol detail is in
[operations: Reviewer Protocol v2](../docs/standalone-review.md#reviewer-protocol-v2).

## Completion suite and Project Verification Coverage

The registered program runs the Wave's frozen completion suite after
implementation proof and test readiness and before review publication. It owns
the command execution, the results and their acceptance. Do not run a
substitute command or create a receipt by hand.

Read coverage through the read-only status command, including after `done`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration status --json \
  --runs-root ".claude/reviews/wave-gate-runs"
```

Relay `waveCompletionSuiteReadiness` and its independent `projectVerificationCoverage`; do not reconstruct coverage from a check count or today's source file:

- `configured` has non-empty sorted `checkIds`. Configuration is not a pass; only accepted suite evidence establishes those commands' acceptance.
- `not-configured` with `engine-default` means the manifest was absent at population; `empty-operator-manifest` means it explicitly listed zero project checks. Both allow engine-only advancement. Report **Reserved checks accepted; Project verification NOT CONFIGURED**, not "project verification passed."
- A completed Wave reports its archived receipt roster. A reserved-only receipt has reason `historical-unknown`, because it cannot distinguish an absent manifest from an empty one.
- `legacy-unavailable` stays unavailable; do not invent coverage for it. A required, rejected or stale outcome is not a pass because checks are configured.

Coverage is a report, not a waiver: it never claims that an unconfigured test, build or typecheck category ran. The manifest is installed with `write-verification-manifest` before population; later edits do not replace the frozen commands.

## Retiring a Wave Gate blocked by legacy Requirement scope

`upgrade-spec-trace` refuses active Wave Gate authority by default. Normally,
finish the registered run. Only when that exact run cannot finish because its
legacy Requirement scope is wrong, first record the operator decision on the
protected run and then request the explicit atomic retirement:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration abandon \
  --runs-root "<exact-active_wave_gate.runsRoot>" \
  --run "<exact-active_wave_gate.runId>" \
  --reason "legacy Requirement scope prevents this Wave Gate from completing"

bun ${LOOM_DIR}/engine/src/cli.ts helper upgrade-spec-trace \
  --retire-abandoned-run \
  < /path/to/exact-trace-ownership.json
```

Normally omit `--superseded-by`; no replacement owns protected authority yet.
If the abandonment did name a successor Run Directory, the upgrade audits that
pointer but does not install it as active authority. The upgrade re-proves the abandonment and the run's Wave authority, installs
the v2 ownership, records the retirement and clears only the retired active
authority with its stale review epoch and spec-check scope. Task
implementation and review evidence and completed history survive. Missing,
unreadable, foreign, changed, non-abandoned or superseded authority is refused.
After success, start a fresh Wave Gate normally; never clear protected fields by
hand. See `docs/reference/recovery.md` for the ownership JSON contract.

## Restarting an exhausted reviewer run

Only when the blocked diagnostic says Wave reviewer **attempt 2 exhausted**, name
a fresh replacement run id and invoke the engine-owned restart:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration restart \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<exhausted-run-id>" \
  --new-run "<fresh-replacement-run-id>"
```

The restart refuses while any outstanding slot lacks a durably captured
attempt-2 rejection. On success it retires the old run, keeps accepted findings
as prior findings and returns the replacement `spawn-batch`. Execute that exact
batch normally. The old transcripts remain as audit evidence. Never repair,
copy, or delete exhausted transcripts by hand.

## Reopening a completed Wave after Review Packet integrity loss

If a full-tier lint remediation changed declared bytes after accepted review evidence, completion is protected-blocked until the review is refreshed. For an already completed Wave, use the engine-owned recovery with the exact terminal registration and the exact engine-derived Task list:

<!-- wire-example: completed-wave-reopening -->
```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper reopen-completed-wave \
  --runs-root ".claude/reviews/wave-gate-runs" <<'JSON'
{"runId":"<completed-run-id>","wave":3,"authorityDigest":"<completed-authority-digest>","taskIds":["T19","T22"]}
JSON
```

Loom reopens exactly the Tasks whose current declared bytes differ from the reviewed ones. A packet too old to carry a byte snapshot records `legacy-workspace-authority-unverifiable` and requires every completed Task of that Wave. The command refuses an active gate, any later-Wave progress, a wrong Task list, and a packet with no drift. Each reopened Task returns to pending revalidation at a fresh Review Generation, and the Wave's implementation, test and review gates reset. Re-spawn every reopened Task before the next Wave Gate: an Agent may make no production change if the code is correct, but must finish with fresh test evidence. Then start a fresh Wave Gate.

## Recovering an orphaned active run

If `orchestration status --json --runs-root ".claude/reviews/wave-gate-runs"`
reports that the protected active Run Directory is missing, use the dedicated
engine operation. Read the exact `runId`, `wave`, and `authorityDigest` from
`active_wave_gate`; name one fresh replacement run id; then run:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration recover-orphan \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run-id "<exact-missing-active-run-id>" \
  --wave "<exact-active-wave>" \
  --digest "<exact-active-authority-digest>" \
  --new-run "<fresh-replacement-run-id>"
```

Recovery refuses unless the requested authority and runs root exactly match
protected state, the old direct-child entry is absent, the replacement is
pristine, and no review or implementation subagent is active for this Task
Graph. It keeps every Finding, Refutation, Resolution and Review Generation,
installs the replacement as the active run and returns the fresh `spawn-batch`;
execute only that batch. Repeating it after it succeeds changes nothing.

Do not recreate an empty old directory, copy another run's artifacts, remove
`active_wave_gate` manually, delete failed replacement directories, or use
`cleanup-state` unless you explicitly intend to discard orchestration history.
