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

Resolve the active Loom package once:

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || exit 1
```

Create one fresh direct-child Run Directory, then start the registered program:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration start wave-gate \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<fresh-run-directory>" <<'JSON'
{"wave":null}
JSON
```

Execute only the one typed action returned by `start`, `resume`, or `decide`:

- `spawn-batch`: spawn every exact request in one message, preserving its
  model, required Skill, task text, context reference, and `LOOM_REQUEST_ID`.
- `await-user`: present the advisory disposition request exactly as supplied;
  send the resulting JSON object through `decide`.
- `blocked`: stop and report the diagnostic. Do not bypass or reconstruct it.
- `done`: report the completion receipt and newly protected Wave state.

After a harness batch finishes, resume the same run:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration resume \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<same-run-directory>"
```

For an `await-user` action:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration decide \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run "<same-run-directory>" \
  --request "<exact-decision-request-id>" <<'JSON'
{"disposition":"defer","reason":"<operator reason>"}
JSON
```

Resume is idempotent. Pi and Claude persist exact native-id/request bindings and
raw final bytes directly into engine-declared slots. Never write transcripts,
build manifests, select models, tally findings, mutate the protected State File,
or stage deterministic operation output in the parent.
