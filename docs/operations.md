# Operating and developing Loom

This guide covers status, persisted artifacts, recovery, validation, and contributor commands. For lifecycle semantics, read [Workflows](workflows.md); for module boundaries, read [Architecture](architecture.md).

## Prerequisites

- Bun (engine runtime and tests)
- Git
- Claude Code or Pi
- GitHub CLI for `/loom`’s issue tracking and optional push/PR operations

Run commands from the repository being orchestrated unless a command explicitly changes into Loom’s `engine/` directory.

## Canonical status

Prefer the engine-derived status over hand-written `jq` readiness checks:

```bash
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper orchestration status \
  --runs-root ".claude/reviews/wave-gate-runs"
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper orchestration status --json \
  --runs-root ".claude/reviews/wave-gate-runs"
```

Under Claude Code, command source uses `${CLAUDE_PLUGIN_ROOT}`; under Pi, rendered resources replace that token and export `LOOM_PLUGIN_ROOT` for diagnostics.

Both renderers project one `LoomStatus` value. Status reports:

- active Phase and Wave;
- exhaustive Task counts;
- failed proof obligations;
- test readiness;
- Review Run roster gaps and evidence failures;
- active/advisory/resolved/refuted Finding counts;
- whether a Refutation Panel is needed;
- Wave Gate completion eligibility;
- exactly one next action and all reasons.

Unreadable or malformed authority is represented as `unavailable` and leads to `blocked`; status never fabricates empty/ready values. Status probes the conventional Wave Gate runs root by default; pass `--runs-root` when the active run was started under a different root. A missing active directory is reported as orphaned, never as a healthy suspended run.

Raw state inspection remains useful for diagnosis, but it is not gate logic:

```bash
jq '.' .claude/state/active_task_graph.json
jq '.tasks[] | {id, wave, status, proof, review_status}' \
  .claude/state/active_task_graph.json
```

Use `.pi/state/active_task_graph.json` under Pi.

## Run Directory operations

Registered programs require a fresh directory that is a direct child of the supplied runs root. A nested path or unrelated basename is rejected.

Typical roots:

| Program | Conventional root |
|---|---|
| Wave Gate | `.claude/reviews/wave-gate-runs/` |
| Standalone review/remediation | `.claude/reviews/review-and-fix-runs/` |
| Architecture panel evidence | `.claude/specs/<slug>/panel-runs/` |

Create the exact root and a fresh `run.*` child. Never reuse a completed or blocked run.

### Registered program protocol

```bash
# Start with program-specific JSON on stdin
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration start <program> \
  --runs-root <root> --run <fresh-direct-child>

# After a returned spawn batch finishes
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration resume \
  --runs-root <root> --run <same-child>

# Supply a requested user decision
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration decide \
  --runs-root <root> --run <same-child> --request <decision-id>
```

`resume` is idempotent. Execute only the returned `spawn-batch`, `await-user`, `blocked`, or `done` action. Do not build request lists, Context Packets, verdict manifests, transcript files, model choices, or result artifacts by hand.

The façade also exposes `submit` and `correlate` for transport integration and compatibility. Normal Pi and Claude Code operation records native correlations and captures final bytes automatically. `complete` remains a compatibility adapter for historical panel callers; deterministic operations are executed internally in new façade runs.

### Inspecting one run

`status` answers “where is the graph”; `inspect` answers “what state is this run in, and is it recoverable or stale?”. It is a pure read — it advances nothing.

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration inspect \
  --runs-root <root> --run <run-directory> [--json]
```

It reports the registered program, the machine state read through that program’s own checkpoint shape, every issued slot with its attempt, capture status and the diagnostic that refused it, the event tail, and any abandonment marker. Facts it cannot read are reported as `unavailable` with the cause, never defaulted — so an unreadable checkpoint is distinguishable from a run that never wrote one. Prefer it over hand-reading `authority.json`, `program.json`, `checkpoint.json`, and `events/`. Like `status`, it stays available during a Pi runtime-revision skew, because it is exactly what diagnosing that skew needs.

### Retiring a superseded run

Run directories are never deleted — they hold the evidence. When a newer run replaces one, record it so the directory listing stays honest:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration abandon \
  --runs-root <root> --run <retired-run> \
  --superseded-by <replacement-run> \
  --reason "<why this run was retired>"
```

The marker removes nothing. It is written once and is immutable: an identical repeat succeeds, a different one is refused, a run may not supersede itself, and the replacement must already exist as a direct child of the same runs root. Afterwards `inspect` still reads the run’s evidence, but every operation that would advance it — `resume`, `submit`, `correlate`, `decide`, `restart`, `complete` — refuses, and no recovery can adopt it as a pristine replacement. `--superseded-by` is optional; omit it when a run is retired without a successor.

### Pi batch limit

Pi’s native subagent transport accepts at most eight requests per call. Partition a larger engine-issued batch into ordered chunks of at most eight without changing any request. Resume only after all chunks finish.

## Protected state rules

Do not write `active_task_graph.json`, machine bindings, or evidence ledgers directly.

Protection is layered:

1. TaskGraph mode is `0444` at rest.
2. `guard-state-file` denies Bash segments that may write guarded paths.
3. Under Pi, a content-addressed Runtime Revision handshake rejects stale-extension/fresh-CLI mutations before dynamic import; `StateManager` repeats the check before chmod or lock creation.
4. `StateManager` serializes writes with a lock and atomic rename.
5. Only hooks and narrowly allowlisted helpers receive write authority.
6. Run-scoped programs publish immutable evidence outside the protected graph and commit protected state only through typed effects.

If a helper says a direct write is blocked, use the named canonical operation; do not use `chmod`, output redirection, an interpreter, or path obfuscation to bypass it.

## Common operating states

### Task remains `pending`

- If its Agent is still in `executing_tasks`, wait or diagnose a hang.
- If the Agent crashed, SubagentStop/cleanup clears execution attribution; respawn the exact Task.
- If proof is unsatisfied, inspect `proof.obligations` rather than trusting completion prose.

### Test evidence is missing or degraded

The implementation Agent must run recognizable tests. For trusted Claude evidence, prefer a supported machine-readable report. A nonzero exit is trusted failure; a zero exit without an acceptable report may remain untrusted. Pi structured tool results retain their distinct provenance.

Do not use `mark-tests-passed` to fabricate evidence. It is an evidence/status operation, not an escape hatch.

### Reviewer evidence is missing

Registered programs derive the exact missing slots and issue retry requests. Resume the program; do not re-run the whole roster or manually write a transcript.

A malformed semantic output gets one retry. Attempt-2 rejection is terminal for that run. Wave reviewer exhaustion has an explicit `orchestration restart` path; standalone runs should remain blocked audit evidence rather than be edited.

### Active Wave Gate Run Directory is missing

Do not recreate the old directory or edit `active_wave_gate`. Create a pristine
replacement direct child, copy the exact run ID/wave/digest from protected state,
and use the atomic recovery operation:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper orchestration recover-orphan \
  --runs-root ".claude/reviews/wave-gate-runs" \
  --run-id "<active-run-id>" --wave "<active-wave>" \
  --digest "<active-authority-digest>" \
  --new-run "<fresh-replacement-run-directory>"
```

It refuses if the old entry exists or any subagent is active, preserves review
history and generations, records the retirement, installs replacement authority
atomically, and returns the exact new spawn batch. `cleanup-state` remains a
history-discarding last resort, not normal recovery.

### Wave Gate reports critical Findings

Fix surviving criticals through implementation Agents, which increments Review Generation, then open a new Wave Gate run. Do not remove Findings from the graph. The next Review Run verifies every prior id against a new Review Packet.

### Wave Gate awaits advisory disposition

Present the engine’s request and return exactly one disposition/reason object through `decide`. Do not classify advisories silently in parent reasoning.

### Pi reports runtime version skew

Do not repair state. The mutating CLI route compared the Runtime Revision published by Pi's loaded extension with the current checkout and refused before writing. Run `/reload` (or fully restart Pi while preserving the session), then retry the same idempotent operation. Canonical `orchestration status` remains available during skew.

A missing handshake means the Pi session predates this protocol or did not load Loom; it is also resolved by reload/restart, not by deleting fields from the TaskGraph.

### State is malformed

Use only when the load boundary explicitly directs recovery:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper repair-task-graph
```

The repair path parses rejected bytes, applies conservative repair, refuses loss of Findings/audit data, validates both full and typed forms, installs atomically, and restores mode `0444`.

### Abandoning an orchestration

`/loom --complete` and `--abort` are not implemented lifecycle flags. The canonical emergency teardown is the guarded helper:

```bash
bun "$LOOM_DIR/engine/src/cli.ts" helper cleanup-state
```

Use it only with explicit operator intent. Preserve specs, plans, review runs, and the GitHub Issue as audit/recovery material.

## Remediation and Git safety

`/review-and-fix` must use the registered remediation program. It rejects:

- dirty paths absent from review scope and explicit support paths;
- Loom state, review, panel, and Run Directory evidence;
- unrelated pre-staged work;
- symlinks or non-canonical repository-relative paths at authority boundaries;
- staged sets that differ from the audited set;
- repository witness changes between audit and index installation.

It stages into a temporary index with literal path semantics, verifies that index, then installs it under the real index lock. Commit only after a `done` receipt. Never force-push.

## Linter operations

### Scan a path

```bash
bun scripts/lint-project.ts engine/src
```

### Validate rule files

```bash
bun engine/src/cli.ts helper validate-lint-rules .claude/linter/rules
# Pi project:
bun engine/src/cli.ts helper validate-lint-rules .pi/linter/rules
```

A nonexistent directory is an error for explicit validation. Runtime loading, by contrast, treats an absent project rules directory as “no project overrides.”

See [Lint Rules](../lint-rules/README.md) for configuration and tiers.

## Model policy operations

```bash
# Inspect one Agent’s semantic profile and both bindings
bun engine/src/cli.ts helper model-profiles agent --agent code-reviewer

# Validate all source definitions
bun engine/src/cli.ts helper model-profiles validate

# Regenerate Pi Agent definitions
bash scripts/sync-pi-agents.sh
```

Generated Pi Agents live under `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents`. Regenerate after Agent, Skill, model-profile, or package-root changes, then `/reload` Pi.

## Model calibration

Calibration is live-model work and is opt-in:

```bash
cd /path/to/loom
LOOM_RUN_MODEL_CALIBRATION=1 bun scripts/run-model-calibration.ts \
  --profile focused-review \
  --corpus calibration/corpus.json \
  --output calibration/results/focused-review.json
```

Without `LOOM_RUN_MODEL_CALIBRATION=1`, the script exits without running models. Score predictions separately with the `helper model-calibration` operations. Read [Model profiles and calibration](model-profiles-and-calibration.md) before changing policy.

## Development validation

From `engine/`:

```bash
bun run typecheck
bun run test:unit
bun run test:smoke
# complete project validation:
bun test
```

`bun test` runs unit/property/integration tests and smoke scripts. Smoke coverage includes architecture panel, refutation panel, standalone review, registered orchestration façades, and Pi resource rendering.

Useful focused checks:

```bash
cd engine
bunx vitest run tests/runbook-contract.test.ts tests/panel-config.test.ts
bunx vitest run tests/handlers/helpers/orchestration.test.ts
bunx vitest run tests/pi-extension-review-events.test.ts
```

Do not claim full validation when concurrent work in the repository prevents a clean complete run; report exactly which checks were executed.

## Repository map for operators

```text
.claude-plugin/plugin.json     Claude plugin metadata
package.json                   Pi package registration and runtime dependencies
commands/                      executable user runbooks
skills/                        reusable Skill runbooks and knowledge
agents/                        source Agent definitions
hooks/                         Claude Code hook registration and shims
pi/                            Pi adapter, renderer, transcript adapter, grants
engine/src/core/               parsers, policy, reducers, domain values
engine/src/orchestration/      anchored persistence, effects, Fugue runtime/DAGs
engine/src/handlers/           harness/CLI shell
engine/tests/                  unit, property, integration, contract tests
scripts/                       sync, lint, calibration, smoke scripts
calibration/                   committed corpus; generated results are ignored
```
