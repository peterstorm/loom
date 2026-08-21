# Using Loom with Pi

Loom ships as a first-class native Pi package: its `package.json` exposes one native extension (`pi/extension.ts`), Loom skills, and top-level command templates. It uses the same deterministic engine as Claude Code, with the extension providing tool guards, lifecycle capture, resource rendering, and child write capabilities.

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

## Interactive phase agents in Pi

Pi subagents are non-interactive. When a Loom phase requires user input, its agent emits `QUESTIONS_REQUIRED` or `APPROACH_SELECTION_REQUIRED`; ask those questions in the main Pi session and rerun the agent with the answers.

## This workstation: dotfiles-managed local package

Home Manager installs the Pi binary and links these directories from the dotfiles repository:

```text
~/.pi/agent/agents      -> ~/.dotfiles/pi/agents
~/.pi/agent/extensions  -> ~/.dotfiles/pi/extensions
~/.pi/agent/prompts     -> ~/.dotfiles/pi/prompts
```

`~/.pi/agent/settings.json` is a mutable copy of `~/.dotfiles/pi/settings.json`. It declares Loom as a live local package:

```json
{
  "packages": [
    "../../dev/claude-plugins/loom",
    "../../dev/claude-plugins/cortex",
    "../../dev/claude-plugins/obsidian",
    "../../dev/claude-plugins/loom-pi-goal/packages/pi-goal"
  ]
}
```

The Loom path resolves relative to `~/.pi/agent/` as `~/dev/claude-plugins/loom`. Pi therefore loads the currently checked-out Loom worktree; no `pi install` or `pi update` is required for normal development.

After changing or pulling Loom:

```bash
cd ~/dev/claude-plugins/loom
git pull
```

Restart Pi or run `/reload`. Run `home-manager switch` only after changing the Home Manager module or dotfiles' default Pi settings.

The dotfiles package supplies a generic `subagent` extension and a small set of generic agents (planner, reviewer, scout, worker). Loom's agent definitions live in the same Pi agent directory as rendered, integrity-stamped files produced by `scripts/sync-pi-agents.sh` (see [Agent sync and model policy](#agent-sync-and-model-policy)); do not hand-edit them or byte-copy raw source agents there.

## Installation

### Local checkout

```bash
pi install /absolute/path/to/loom
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
```

A local package is referenced in place. After source changes, run `/reload`; after generated-Agent inputs change, run `scripts/sync-pi-agents.sh` and then `/reload`.

Loom binds the in-memory extension and fresh CLI processes with a content-addressed Runtime Revision. A mutating CLI command launched by a Pi process whose extension predates or differs from the checkout is refused before any TaskGraph or Run Directory write. Read-only orchestration status remains available.

### Git or npm

```bash
pi install git:github.com/peterstorm/loom@<tag-or-commit>
# or
pi install npm:@peterstorm/loom@<version>
```

A Git ref is intentionally pinned. To adopt a newer Loom version, change the ref or reinstall with the desired ref, then `/reload`. Use an unpinned Git source only when you explicitly want `pi update` to follow the repository's default branch.

Run `scripts/sync-pi-agents.sh` from the installed package root, then `/reload`.

Generated Agents are written to:

```text
${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents
```

## Verify the active package

Pi derives identity from the extension module’s `import.meta.url`, never cwd or a Claude installation. The extension exports that root as both `CLAUDE_PLUGIN_ROOT` and `LOOM_PLUGIN_ROOT`; Loom commands, skills, and subagents use these variables for package-relative files.

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

Outside orchestration—no active TaskGraph for the session—no role receives a grant, including implementation agents. Direct edits are ungated when no TaskGraph exists, so a capability there would authorize nothing already forbidden, while its Task id binding would refuse a spawn that has no Task id to give. This is what makes a Loom agent usable ad hoc on Pi, matching Claude Code, whose hook shims already exit before any gate when no TaskGraph is present. `engine/src/core/pi-write-grant-plan.ts` owns the decision.

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

The legacy `pi/loom-bridge.ts` bridge was removed; `pi/extension.ts` is the only Pi state adapter, and the package manifest pins the bridge's absence.

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

### `CLAUDE_PLUGIN_ROOT` is unset where a command needs it

The native extension sets `CLAUDE_PLUGIN_ROOT` (and `LOOM_PLUGIN_ROOT`) for Pi subprocesses; if it is missing, the loom extension is not loaded for this process. Use `LOOM_PLUGIN_ROOT` for diagnostics where the command accepts it. An unresolved Claude token in a rendered Pi prompt is a packaging bug.

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
- no grant for anyone outside orchestration is expected;
- a scoped writer can write only derived artifact roots;
- an implementation grant must match its Task and repository;
- state/evidence paths remain guarded regardless of grant.

Never broaden the grant manually.

### Architecture panel is refused

This is intentional until interactive child-to-parent question relay exists. Use Claude Code for the panel interview, or use non-panel architecture only when all required decisions are already explicit and the flow can honestly avoid live questions.

### `Unknown agent: "code-implementer-agent"`

Confirm the dotfiles generic `subagent` extension is enabled, that `~/.pi/agent/agents/` holds the rendered Loom definitions (run `scripts/sync-pi-agents.sh`), and run `/reload`.

### `FATAL: active Loom package is incomplete`

Loom's native Pi extension is not loaded (or the package root it resolved is incomplete). Confirm `pi list` includes the Loom package and restart/reload Pi.

### Tasks update twice or state transitions behave unexpectedly

Remove any legacy `loom-bridge` extension from the loaded package set (it no longer ships in the package; an old cached copy is the only source). The native Loom extension is the only state adapter that should process `subagent` results.

### Runtime version skew / restart required

A diagnostic beginning `Loom runtime version skew detected` means the checkout changed after Pi loaded the extension. The TaskGraph is not corrupt, and the refused CLI command performed no mutation.

Run:

```text
/reload
```

If reload is unavailable or fails, fully exit and restart Pi, preserving the session. Then retry the exact idempotent orchestration command. Do not remove newly valid fields, edit the TaskGraph, or recreate a Run Directory.

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
