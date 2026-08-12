# Using Loom with Pi

Loom ships as a native Pi package. The active package is identified from the
loaded extension module's `import.meta.url`; Pi never discovers Loom through a
Claude Code installation or the current working directory.

## Installation

### Local checkout (development)

```bash
pi install /absolute/path/to/loom
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
```

A local package is referenced in place, so edits to the checkout become active
after `/reload`.

### Git or npm package

```bash
pi install git:github.com/peterstorm/loom@<tag-or-commit>
# or
pi install npm:@peterstorm/loom@<version>
```

After install or update, run `scripts/sync-pi-agents.sh` from that installed
package root, then `/reload`. Loom agents require explicit Pi model bindings and
are generated into `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents`.
Loom's guard enforces a two-layer model contract: Claude Code spawns must match
the agent's declared binding exactly, while on Pi the launcher's routing policy
(`pi/model-routing.json`) decides the effective model at spawn — a machine
running a local parent model may explicitly inherit it for every child, and
the guard proves the synced render and user-global spawn scope rather than
vetoing that routing decision.
`PI_CODING_AGENT` is Pi's process identity marker. Loom selects Pi state/rule
paths when either that marker or `PI_CODING_AGENT_DIR` is present, so explicit
agent-directory configuration also works in processes that do not carry the
marker. When set, `PI_CODING_AGENT_DIR` is the active base directory for
generated Pi agents and rendered Loom resources; otherwise Loom falls back to
`$HOME/.pi/agent`.

## Package-root contract

The shared markdown source uses Claude Code's `${CLAUDE_PLUGIN_ROOT}` token.
That token is correct only in Claude Code. Pi does not expand it.

Loom's Pi adapter therefore performs harness lowering at resource discovery:

1. `pi/extension.ts` derives `PACKAGE_ROOT` from its own `import.meta.url`.
2. `pi/resources.ts` renders commands, skills, references, and rules into a
   content-addressed cache under the Pi agent directory.
3. Every root token in rendered markdown becomes the active package's absolute
   path.
4. `scripts/sync-pi-agents.sh` applies the same lowering to generated Pi agent
   definitions, inlines each declared skill (including command-backed phase
   skills), and stamps package-root plus full-definition integrity metadata.
5. Every Pi spawn byte-compares the generated definition with a fresh render
   from the loaded package, rejects non-user agent scope and unresolved root
   tokens, and enforces the source agent's required-skill prompt contract.
6. The extension exports `LOOM_PLUGIN_ROOT` to child processes for diagnostics.

This supports local checkouts, Pi git/npm installs, read-only package stores,
and paths outside a Git repository. CWD and Claude's plugin cache are never
package identity. Because one shared token appears in both shell snippets and
Markdown/tool paths—and some historical snippets expand `LOOM_DIR` unquoted—
roots containing whitespace, glob characters, quotes, dollar signs, backticks,
backslashes, or control characters are rejected rather than interpolated
unsafely.

To verify the active root inside a Pi Bash tool call:

```bash
printf 'LOOM_PLUGIN_ROOT=%s\n' "$LOOM_PLUGIN_ROOT"
test -f "$LOOM_PLUGIN_ROOT/engine/src/cli.ts"
```

## Resources

`package.json` statically registers only `pi/extension.ts`. The extension's
`resources_discover` handler contributes the rendered prompt and skill paths.
This avoids Pi loading the unrendered Claude-facing markdown first.

The package provides:

- commands such as `/loom`, `/wave-gate`, `/review-pr`, and `/review-and-fix`;
- skills under `skills/`;
- the full Loom extension and shared engine;
- generated user-level subagent definitions produced by
  `scripts/sync-pi-agents.sh`.

## Harness behavior

| Capability | Pi implementation |
|---|---|
| Tool guards | `pi/extension.ts` `tool_call` handlers |
| Phase and task state | Shared engine and `StateManager` |
| Subagent completion | `tool_result` dispatch in `pi/extension.ts` |
| Review finding capture | Shared review-output core |
| Prompt/skill root expansion | Content-addressed Pi resource rendering |
| Agent root expansion | `model-profiles render-pi` |
| Explicit agent models | Generated Pi agent frontmatter (launcher routing may override) |

Pi subagents are separate Pi processes. The generated agent definition already
contains absolute package resource paths, so it does not depend on the parent
process's CWD or on Claude-specific environment variables.

For execute-phase implementation spawns, the parent adapter also issues one
one-time write grant per child item (single, parallel, or chain). The grant is
bound to agent, Task ID, repository CWD, and task graph; its raw token is
injected only into that child's prompt and is stored on disk only as a SHA-256
digest. The child consumes it before its first model turn and creates a
session-local guarded-write binding. Pi exposes no per-child timeout, so queued
grants use one fixed parent-session start window rather than estimating chain
stages from unsupported input fields. Normal revocation is immediate on parent
tool completion, rollback, or session shutdown; the 24-hour ceiling only bounds
an abandoned capability after a parent crash. Mismatch, expiry, replay, failed
spawn, or shutdown fails closed. This avoids incorrectly treating all parallel
children as one shared active agent.

## Development workflow

```bash
cd /absolute/path/to/loom
bash scripts/sync-pi-agents.sh
cd engine
bun run typecheck
bun test
```

Then run `/reload` in Pi. For UI changes, start a fresh Pi session from a project
that has the local Loom package enabled and exercise the affected command.

## Troubleshooting

### `CLAUDE_PLUGIN_ROOT` is unset

Expected under Pi. Use `LOOM_PLUGIN_ROOT` for diagnostics. Markdown resources
must have been rendered before the model sees them; an unresolved
`CLAUDE_PLUGIN_ROOT` in a Pi prompt is a Loom packaging bug.

### A command points at the wrong checkout

Run:

```bash
printf '%s\n' "$LOOM_PLUGIN_ROOT"
pi list
```

Pi package scope deduplication makes the project package entry win over a global
entry for the same package identity. Remove or disable an unintended package,
then `/reload`.

### Agent model or resource paths are stale

Run the sync script from the package root printed by `LOOM_PLUGIN_ROOT`:

```bash
"$LOOM_PLUGIN_ROOT/scripts/sync-pi-agents.sh"
```

Then `/reload`.

### Resource rendering fails

Loom fails closed on symbolic links in source resource trees. On reuse it
verifies the complete rendered inventory and every file's bytes, quarantining
and atomically rebuilding a corrupted content-addressed root. Check that
`skills/`, `commands/`, `references/`, and `rules/` in the active package are
regular readable files and that the Pi agent directory is writable.

### State or phase operations are blocked

This is independent of package-root resolution. Inspect the shared task graph
and follow `/wave-gate`; direct writes to guarded state remain prohibited.

## Legacy bridge

`pi/loom-bridge.ts` is retained only as a fail-closed compatibility entry point.
It emits a diagnostic and dispatches nothing because its historical partial
agent roster could lose review/spec evidence. The package manifest loads
`pi/extension.ts`, the only supported adapter.
