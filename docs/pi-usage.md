# Using Loom with Pi

Loom is a first-class Pi package. The package exports:

- `pi/extension.ts` — the Pi extension that replaces the old hook/bridge setup.
- `skills/` plus the Vercel skill directory.
- top-level command prompt templates in `commands/*.md`.
- generated Pi-compatible subagent definitions synced into `~/.pi/agent/agents/`.

## Install

```bash
pi install /home/peterstorm/dev/claude-plugins/loom
# or for a one-off run:
pi -e /home/peterstorm/dev/claude-plugins/loom
```

Reload an existing Pi session with `/reload`.

## Required companion: subagent tool

Pi does not ship subagents by default. Loom expects a `subagent` tool compatible with Pi's example subagent extension (the one that discovers `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`). Install/enable that extension before running `/loom`.

On Pi session start, Loom syncs its bundled agents into `~/.pi/agent/agents/` so the subagent tool can discover them. If you already have a conflicting agent file, Loom leaves it untouched and warns. To overwrite with the bundled Loom version:

```text
/loom-sync-agents --force
```

The sync also makes Claude Code-style agent frontmatter Pi-compatible:

- YAML `tools:` arrays become Pi's comma-separated tool string.
- `Glob` maps to Pi's `find` tool.
- `skills:` are expanded into the agent body because Pi's stock subagent loader ignores skill preloading.

## Runtime path resolution

The Pi extension sets these environment variables for the main Pi process and spawned subagents:

```bash
CLAUDE_PLUGIN_ROOT=/path/to/loom
LOOM_PLUGIN_ROOT=/path/to/loom
```

Commands, agents, and skills should resolve package files through those variables, not by searching the Claude Code plugin cache.

## What works

| Feature | Status | Notes |
|---|---:|---|
| `/loom`, `/wave-gate`, review commands | ✅ | Loaded as Pi prompt templates from `commands/*.md` only. |
| Skills | ✅ | Loaded from `skills/` and `commands/vercel-react-best-practices`. |
| Main-agent guards | ✅ | `tool_call` handlers block unsafe direct edits/state writes and validate subagent tasks. |
| Post-edit lint | ✅ | `tool_result` handler runs immediate lint for write/edit results. |
| Subagent task updates | ✅ | `tool_result` handler processes Pi `subagent` results directly. The old `loom-bridge.ts` is not loaded. |
| Phase advancement | ✅ | Phase-agent subagent results update the task graph. |
| Agent skill preloading | ✅ | Implemented by generated Pi agent files during `/loom-sync-agents`. |

## Interactive phase agents in Pi

Some Loom phase templates were originally written for Claude Code's `AskUserQuestion` tool. Pi subagents are non-interactive. Under Pi, those agents must output a machine-visible block such as `QUESTIONS_REQUIRED` or `APPROACH_SELECTION_REQUIRED` and stop; the main session asks the user, then re-runs the agent with the answers.

## Troubleshooting

### `Unknown agent: "code-implementer-agent"`

Run:

```text
/loom-sync-agents --force
/reload
```

Also confirm the subagent extension is enabled.

### `FATAL: loom package root not found`

The Loom extension is not loaded in the current Pi process. Install the package, start Pi with `-e /path/to/loom`, or run `/reload`.

### Tasks do not update after subagents finish

Ensure only `pi/extension.ts` is loaded. The legacy `pi/loom-bridge.ts` should not be installed separately anymore.

### Conflicting agent warning

You have a user-owned file in `~/.pi/agent/agents/` with the same name as a Loom agent. Use `/loom-sync-agents --force` to replace it with Loom's generated Pi-compatible copy, or rename your custom agent.
