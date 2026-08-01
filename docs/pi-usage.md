# Using Loom with Pi

Loom is a Pi package. Its `package.json` exposes one native extension (`pi/extension.ts`), Loom skills, and top-level command templates. The native extension handles Pi `tool_call` and `tool_result` events directly; **do not install `loom-bridge`** alongside it.

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
    "../../dev/claude-plugins/cortex"
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

The dotfiles package supplies a generic `subagent` extension. Its agent definitions are symlinks to `~/dev/claude-plugins/loom/agents`, and it resolves each agent's `skills:` from the Loom package manifest. Do not copy or generate another agent set into `~/.pi/agent/agents`.

## Native Pi behavior

| Feature | Status | Native owner |
|---|---:|---|
| `/loom`, `/wave-gate`, review commands | ✅ | Loom prompt templates |
| Skills | ✅ | Loom package manifest |
| Main-agent guards | ✅ | `pi/extension.ts` `tool_call` handler |
| Post-edit lint | ✅ | `pi/extension.ts` `tool_result` handler |
| Subagent task updates and phase advancement | ✅ | `pi/extension.ts` `tool_result` handler |
| Agent skill preloading | ✅ | Dotfiles generic `subagent` extension |

`CLAUDE_PLUGIN_ROOT` and `LOOM_PLUGIN_ROOT` are set by the native extension to the installed package root. Loom commands, skills, and subagents use these variables for package-relative files.

## Installing outside this dotfiles setup

For active Loom development, prefer a local path because Pi immediately uses the checked-out source:

```bash
pi install /absolute/path/to/loom
```

For a reproducible consumer installation, use a pinned Git ref:

```bash
pi install git:github.com/peterstorm/loom@<tag-or-commit>
```

A ref is intentionally pinned. To adopt a newer Loom version, change the ref or reinstall with the desired ref, then `/reload`. Use an unpinned Git source only when you explicitly want `pi update` to follow the repository's default branch.

## Interactive phase agents in Pi

Pi subagents are non-interactive. When a Loom phase requires user input, its agent emits `QUESTIONS_REQUIRED` or `APPROACH_SELECTION_REQUIRED`; ask those questions in the main Pi session and rerun the agent with the answers.

## Troubleshooting

### `Unknown agent: "code-implementer-agent"`

Confirm the dotfiles generic `subagent` extension is enabled and that `~/.dotfiles/pi/agents/code-implementer-agent.md` still symlinks to the Loom worktree. Run `/reload` after changing agents.

### `FATAL: loom package root not found`

Loom's native Pi extension is not loaded. Confirm `pi list` includes the Loom package and restart/reload Pi.

### Tasks update twice or state transitions behave unexpectedly

Remove any legacy `loom-bridge` extension. The native Loom extension is the only state adapter that should process `subagent` results.
