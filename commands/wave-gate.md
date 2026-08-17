---
name: wave-gate
version: "3.0.0"
description: "Run the engine-owned Wave Gate lifecycle after wave implementation completes. Usage: /wave-gate"
---

# Wave Gate

Run this after the implementation hook reports that the active Wave is implemented.
The engine owns protected-state verification, test readiness, Review Packets,
reviewer/model/Skill selection, exact request authority, retries, aggregation,
Refutation Panel routing, advisory suspension, and atomic Wave advancement.

**Arguments:** "$ARGUMENTS"

Resolve the active Loom package once:

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || exit 1
```

Name one fresh Run Directory, then start the registered program. The engine
creates it; `--run` takes either the bare run id or a full path to that same
direct child of `--runs-root`:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start wave-gate \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<fresh-run-id>" <<'JSON'
{"wave":null}
JSON
```

Execute only the one typed action returned by `start`, `resume`, or `decide`:

- `spawn-batch`: spawn every exact request, preserving its model, required
  Skill, task text, context reference, and `LOOM_REQUEST_ID`. Claude may send
  the semantic batch in one message. Pi's native subagent transport accepts at
  most eight requests per call, so partition larger batches into ordered
  chunks of at most eight without changing, dropping, or duplicating any
  request; resume only after every chunk finishes.
- `await-user`: present the advisory disposition request exactly as supplied;
  send the resulting JSON object through `decide`.
- `blocked`: stop and report the diagnostic. Do not bypass or reconstruct it.
- `done`: report the completion receipt and newly protected Wave state.

After a harness batch finishes, resume the same run:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration resume \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<same-run-id>"
```

For an `await-user` action:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration decide \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<same-run-id>" \
  --request "<exact-decision-request-id>" <<'JSON'
{"disposition":"defer","reason":"<operator reason>"}
JSON
```

Resume is idempotent. Pi and Claude persist exact native-id/request bindings and
raw final bytes directly into engine-declared slots. Never write transcripts,
build manifests, select models, tally findings, mutate the protected State File,
or stage deterministic operation output in the parent.

## Restarting an exhausted reviewer run

Only when the blocked diagnostic says Wave reviewer **attempt 2 exhausted**, name
a fresh replacement Run Directory and invoke the engine-owned restart:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration restart \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<exhausted-run-id>" \
  --new-run "<fresh-replacement-run-id>"
```

The restart refuses while any outstanding slot lacks a durably captured attempt-2
rejection. On success it atomically retires the old active authority, preserves
accepted findings as prior findings, clears rejected packet evidence, preserves
the implementation review generation, installs a fresh run/epoch-bound Review Packet,
and returns the replacement `spawn-batch`. Execute that exact batch normally.
The old transcripts remain immutable audit evidence and cannot bind to the new
generation. Never repair, copy, or delete exhausted transcripts by hand.

## Recovering an orphaned active run

If `orchestration status --json --runs-root ".claude/reviews/wave-gate-runs"`
reports that the protected active Run Directory is missing, use the dedicated
engine operation. Read the exact `runId`, `wave`, and `authorityDigest` from
`active_wave_gate`; name one fresh replacement Run Directory; then run:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration recover-orphan \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run-id "<exact-missing-active-run-id>" \
  --wave "<exact-active-wave>" \
  --digest "<exact-active-authority-digest>" \
  --new-run "<fresh-replacement-run-id>"
```

Recovery refuses unless the requested authority and runs root exactly match protected state,
the old direct-child entry is genuinely absent, the replacement is pristine, and
no review or implementation subagent is active for this Task Graph. In one locked
State File transaction it materializes accepted partial findings, preserves all
Findings/Refutations/Resolutions and Review Generations, clears stale packet/spec
evidence, appends an orphan-retirement audit record, and installs replacement
active authority. It then returns the exact fresh `spawn-batch`; execute only that
batch. The operation is idempotent after a committed recovery.

Do not recreate an empty old directory, copy another run's artifacts, remove
`active_wave_gate` manually, delete failed replacement directories, or use
`cleanup-state` unless you explicitly intend to discard orchestration history.
