# Using Loom with Pi

Loom ships as a native Pi package. It uses the same deterministic engine as Claude Code, with a Pi extension for tool guards, lifecycle capture, resource rendering, and child write capabilities.

## Support summary

Supported through the shared engine:

- commands and Skills rendered from the active package;
- phase/Wave/task guards and protected `.pi/state`;
- implementation proof and test-result adaptation;
- immediate/full lint;
- registered standalone review, Refutation Panel, Wave Gate, and remediation programs;
- exact model/Skill request policy;
- immutable Run Directories and exact-byte Agent-result capture;
- scoped phase/panel artifact writes and Task-bound implementation writes.

Current parity gap:

- Pi subagents are headless and cannot relay interactive phase questionnaires to the parent TUI. Architecture-panel interviewer spawns fail fast. Standard specify/architecture questionnaire templates have the same transport limitation even where the role is not separately blocked. See [Pi phase-agent interviews](pi-phase-agent-interviews.md).

## Installation

### Local checkout

```bash
pi install /absolute/path/to/loom
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
```

A local package is referenced in place. After source or generated-Agent changes, run `/reload`.

### Git or npm

```bash
pi install git:github.com/peterstorm/loom@<tag-or-commit>
# or
pi install npm:@peterstorm/loom@<version>
```

Run `scripts/sync-pi-agents.sh` from the installed package root, then `/reload`.

Generated Agents are written to:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents
```

## Verify the active package

Pi derives identity from the extension module’s `import.meta.url`, never cwd or a Claude installation. The extension exports that root:

```bash
printf 'LOOM_PLUGIN_ROOT=%s\n' "$LOOM_PLUGIN_ROOT"
test -f "$LOOM_PLUGIN_ROOT/engine/src/cli.ts"
pi list
```

`PI_CODING_AGENT_DIR`, when set, selects the Pi Agent/resource base directory. Otherwise Loom uses `$HOME/.pi/agent`. `PI_CODING_AGENT` is Pi’s process identity marker; Loom also treats explicit `PI_CODING_AGENT_DIR` as Pi context for state/rule path selection.

## Shared-resource rendering

Shared Markdown contains Claude Code’s `${CLAUDE_PLUGIN_ROOT}` token. Pi does not expand it.

At `resources_discover`:

1. `pi/extension.ts` derives the package root.
2. `pi/resources.ts` inventories commands, Skills, references, and rules.
3. Root tokens are replaced with the active absolute package path.
4. Rendered bytes and inventory are published into a content-addressed cache.
5. Reuse verifies every expected file and its bytes.
6. Corrupt cache entries are quarantined and rebuilt atomically.

Source resource trees must contain regular readable files, not symbolic links. Package roots with unsafe interpolation characters are rejected rather than partially escaped.

`package.json` statically registers only `pi/extension.ts`; rendered resources are contributed dynamically so Pi never loads unrendered Claude-facing Markdown first.

## Agent sync and model policy

Source Agents map to semantic profiles in `engine/src/core/model-profiles.ts`. The sync script:

- emits exact Pi provider/model/thinking frontmatter;
- expands package paths;
- inlines declared Skill content;
- stamps source/package/full-definition integrity metadata.

Every Pi spawn byte-compares the selected user-global definition with a fresh render from the loaded package. Project-local Agent shadowing, stale definitions, unresolved root tokens, and missing required Skills are rejected.

Pi launcher routing may explicitly inherit a local parent model for children. Loom validates request/source/render authority and allows that explicit launcher policy; the pure catalog never silently infers parent inheritance.

## Pi write grants

Pi children are separate processes, so Claude’s active-subagent write exemption cannot be reused.

Before spawn, the parent mints a one-time cryptographic grant and injects its token into only that child’s task. The token is stored on disk only as a SHA-256 digest.

Two grant shapes exist:

- **Task-bound implementation grant** — bound to Agent, Task id, repository cwd, TaskGraph, and session; valid for the implementation session.
- **Scoped artifact grant** — for writer roles only; target directories are derived from prompt authority (spec, plan, or panel-run directories).

Read-only roles—reviewers, verifier, judge, decompose, and spec-check—receive no grant even if their prompts mention writable-looking paths.

The child consumes the token before its first model turn. Replay, wrong Agent/Task/cwd, expiration, rejected spawn, or shutdown fails closed. Parent tool completion and rollback revoke outstanding grants. A fixed 24-hour ceiling only bounds a capability abandoned by a parent crash; it is not the normal lifetime.

## Registered orchestration capture

Registered `spawn-batch` requests contain `LOOM_REQUEST_ID`, Context Packet digest/path, and complete request authority. Before dispatch, the extension binds Pi’s native tool-call/item identity to that request. On result, it publishes the exact final bytes into the reserved immutable transcript slot and resumes program semantics from those bytes.

Pi’s subagent tool accepts at most eight items per call. Large engine-issued batches may be partitioned into ordered chunks of at most eight, but requests must not be changed, dropped, or duplicated; resume only after every chunk completes.

## Harness behavior

| Capability | Pi implementation |
|---|---|
| Resource/package identity | `pi/resources.ts`, extension `import.meta.url` |
| Tool guards | `pi/extension.ts` `tool_call` handlers + shared core |
| Phase/task state | shared `StateManager` under `.pi/state/` |
| Lint | shared linter from Pi tool results |
| Task completion | shared proof/review/spec core with Pi transcript adaptation |
| Agent writes | one-time Task or scoped grants |
| Agent models/Skills | generated, integrity-checked user definitions |
| Registered result capture | native correlator + shared capture runtime |
| Run persistence | shared anchored Run Directory and orchestration runtime |

`pi/loom-bridge.ts` is not loaded. It is an inert fail-closed compatibility stub.

## Development workflow

```bash
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
cd engine
bun run typecheck
bun run test:unit
bun run test:smoke
```

Then `/reload` Pi and exercise the affected command from a project that has the intended Loom package scope.

## Troubleshooting

### `CLAUDE_PLUGIN_ROOT` is unset

Expected. Shared resources must be rendered before the model sees them. Use `LOOM_PLUGIN_ROOT` for diagnostics. An unresolved Claude token in a Pi prompt is a packaging bug.

### Command uses the wrong checkout

```bash
printf '%s\n' "$LOOM_PLUGIN_ROOT"
pi list
```

Project package scope wins over a global entry for the same package identity. Remove/disable the unintended package and `/reload`.

### Agent definitions are stale

```bash
"$LOOM_PLUGIN_ROOT/scripts/sync-pi-agents.sh"
```

Then `/reload`. Ensure you are writing to the `PI_CODING_AGENT_DIR` used by the active Pi process.

### Resource materialization fails

Check that `commands/`, `skills/`, `references/`, and `rules/` contain only regular readable files and that the Pi Agent directory is writable. Loom rejects symlinked source files and corrupt cache reuse.

### A writer is blocked

Read the diagnostic:

- no grant for a reviewer/judge/verifier is expected;
- a scoped writer can write only derived artifact roots;
- an implementation grant must match its Task and repository;
- state/evidence paths remain guarded regardless of grant.

Never broaden the grant manually.

### Architecture panel is refused

This is intentional until interactive child-to-parent question relay exists. Use Claude Code for the panel interview, or use non-panel architecture only when all required decisions are already explicit and the flow can honestly avoid live questions.

### State or Wave operation is blocked

Use canonical status and resume the registered program:

```bash
bun "$LOOM_PLUGIN_ROOT/engine/src/cli.ts" helper orchestration status
```

Do not edit `.pi/state/active_task_graph.json` or Run Directory evidence.

## Further reading

- [Architecture](architecture.md)
- [Workflows](workflows.md)
- [Operations](operations.md)
- [Claude Code and Pi integration guide](migration-claude-code-to-pi.md)
- [Model profiles and calibration](model-profiles-and-calibration.md)
