# Using Loom with Pi

> Practical guide for running loom orchestration in [pi](https://pi.dev) today.
> For the full architectural migration plan, see [migration-claude-code-to-pi.md](./migration-claude-code-to-pi.md).

## Overview

Loom was designed for Claude Code's hook system (`hooks.json`). Pi has a different extension model but supports loom through a bridge extension. This doc covers the current working setup.

### What Works Today

| Feature | Status | Notes |
|---------|--------|-------|
| Skill loading (`/loom`) | works | Via pi skills |
| PreToolUse hooks (validation) | works | Claude Code plugin hooks fire in pi |
| SubagentStop (state updates) | works | Via `loom-bridge` extension |
| Phase advancement | works | Via `loom-bridge` dispatch |
| Task graph state management | works | Same state file, same engine |
| Wave gate detection | works | Auto-detected on wave completion |
| Template substitution check | works | PreToolUse hook fires on subagent tool |
| `block-direct-edits` | works | Blocks main agent Write/Edit |
| `guard-state-file` | works | Blocks bash state writes |
| Subagent file writes | works | Subagents are separate pi processes (no hooks) |

---

## Installation

### Prerequisites

- Pi installed (`npm install -g @earendil-works/pi-coding-agent`)
- Loom plugin installed in Claude Code (`~/.claude/plugins/cache/plugins/loom/`)
- `bun` available on PATH (loom engine requires it)

### 1. Install the loom-bridge extension

The bridge lives at `~/.pi/agent/extensions/loom-bridge/index.ts` (global scope).

```bash
mkdir -p ~/.pi/agent/extensions/loom-bridge
cp ~/dev/claude-plugins/loom/pi/loom-bridge.ts \
   ~/.pi/agent/extensions/loom-bridge/index.ts
```

### 2. Verify loom plugin is accessible

```bash
ls ~/.claude/plugins/cache/plugins/loom/*/engine/src/cli.ts
```

### 3. Reload pi

```
/reload
```

### 4. Verify

After a subagent completes during a loom session, stderr shows:
```
[loom-bridge] dispatched code-implementer-agent
```

---

## How It Works

### The Gap

Claude Code fires `SubagentStop` events when its built-in `Task` tool completes.
Pi's `subagent` tool fires `tool_result` events instead. Loom's state management
runs in `SubagentStop` handlers — without the bridge, none of it fires in pi.

### The Bridge

```
Pi subagent completes
    |
    v  (pi fires tool_result event)
+-------------------------------------+
| loom-bridge extension               |
|  1. Filter: is agent in LOOM_AGENTS?|
|  2. Convert pi messages -> JSONL    |
|     (toolCall->tool_use, etc.)      |
|  3. Write transcript to /tmp/       |
|  4. Pipe SubagentStopInput to:      |
|     bun cli.ts subagent-stop dispatch|
+-------------------------------------+
    |
    v  (loom engine, shared code path)
+-------------------------------------+
| update-task-status.ts               |
|  - Extract task ID from transcript  |
|  - Parse test evidence from bash    |
|  - Mark task "implemented"          |
|  - Detect wave completion           |
+-------------------------------------+
```

### Message Format Translation

| Pi Format | Claude Code Format |
|-----------|-------------------|
| `type: "toolCall"` | `type: "tool_use"` |
| `name: "bash"` (lowercase) | `name: "Bash"` (title-case) |
| `arguments: {...}` | `input: {...}` |
| `role: "toolResult"` | `role: "user"` + `type: "tool_result"` block |
| `toolCallId: "x"` | `tool_use_id: "x"` |

---

## Differences from Claude Code

### Subagent Isolation

| Aspect | Claude Code | Pi |
|--------|-------------|-----|
| Subagent process | Same process (nested agent) | Separate process |
| Hooks in subagent | Yes (parent's hooks fire) | No (clean pi instance) |
| Subagent can write | Only with SubagentStart flag | Always (no hooks present) |
| Transcript access | File on disk (`agent_transcript_path`) | In-memory messages in tool_result |

### PreToolUse Hooks

Claude Code plugin hooks fire for the MAIN agent in pi via the hooks.json integration:

- `validate-template-substitution` — blocks `{variable}` patterns in subagent tasks
- `validate-phase-order` — validates phase sequencing
- `block-direct-edits` — blocks main agent Write/Edit during orchestration
- `guard-state-file` — deny-by-default guard on bash commands that reference
  loom-guarded state (only read-only commands and whitelisted helpers pass)

### Template Variable Escaping

The `validate-template-substitution` hook blocks any subagent task containing
`{word}` patterns. This means English copy with `{importDonor}` or `{exportDate}`
in spec excerpts will be blocked.

**Workaround:** Use `<placeholder>` notation or descriptive text instead of
curly braces when quoting copy templates in task prompts.

### State File Location

Both Claude Code and pi use the same path:
```
.claude/state/STATE_FILE_NAME
```
(where STATE_FILE_NAME is the task graph JSON)

This allows switching between Claude Code and pi mid-project.

---

## Troubleshooting

### "dispatch failed" in stderr

```
[loom-bridge] dispatch failed for code-implementer-agent: ...
```

Causes:
- `bun` not in PATH
- Loom plugin not at `~/.claude/plugins/cache/plugins/loom/`
- State file missing or wrong permissions (should be `444`)

### Task not marked implemented

The dispatch extracts the task ID from the transcript using pattern matching.
Ensure the subagent prompt contains `**Task ID:** T1` (or similar pattern
like `Task ID: T1`, `Task: T1`).

### Template substitution blocked

```
BLOCKED: Task prompt contains unsubstituted template variables: {importDonor}
```

Use `<importDonor>` or descriptive text instead of `{curly braces}` for
copy examples in task prompts.

### block-direct-edits blocks your Write

Working as intended. During loom orchestration, use `subagent` tool for
implementation. For infrastructure files (not task code), use bash:
```bash
echo "content" > path/to/file
# or
base64 -d encoded_content > path/to/file
```

The guard only blocks Edit/Write/MultiEdit tools, not bash file operations
(unless targeting state files).

### guard-state-file blocks your bash command

The guard is deny-by-default: a command line that names guarded state (the
task graph, `review-invocations.json`, the state directory, the subagent
tracking dir, or the machine-definitions dir) is allowed only if EVERY
segment of a pipe-chain touching a guarded path is either:

1. A whitelisted helper invocation (`bun <path>/cli.ts helper <name>`), or
2. An allowlisted read-only command (jq, cat, grep, head, ls, diff, …)
   with no output redirect.

Everything else blocks — including writers nobody enumerated, wrappers
(`env`, `xargs`, `timeout`), shells/interpreters executing piped content,
and variable bindings of a guarded path.

Reading the state file with jq/cat is fine. Writing content that mentions
the guarded file name is NOT — a guarded token plus any write on one line
blocks, so there is no single-line indirection workaround. Never name the
guarded path in a writing command line:

```bash
# BLOCKED: names the guarded file AND redirects on the same line
echo "content mentioning active_task_graph.json" > /tmp/doc.md

# Allowed: the writing line never names the guarded path
echo "content describing the task graph state file" > /tmp/doc.md
```

---

## Architecture Details

### Why a global extension?

The bridge lives at `~/.pi/agent/extensions/` (global) rather than
`.pi/extensions/` (project-local) because:

1. **Not blocked by `block-direct-edits`** — project-level Write is blocked
   during orchestration, making it impossible to create a project-local extension
2. **Applies to all projects** — any project using loom benefits automatically
3. **Single maintenance point** — update once, works everywhere

### Why pipe to CLI instead of importing directly?

The bridge shells out to `bun cli.ts subagent-stop dispatch` rather than
importing loom engine TypeScript directly because:

1. **No build step** — the extension is loaded by pi via jiti (TypeScript
   interpreted). Importing loom's engine would require resolving its
   dependencies (ts-pattern, etc.)
2. **Version isolation** — uses whatever loom version is installed in
   Claude Code's plugin cache
3. **Same code path** — guaranteed identical behavior to Claude Code's
   dispatch.sh → cli.ts path
4. **No loom code changes needed** — pure adapter, zero modifications to loom

### Why temp file for transcript?

The loom dispatch handler reads a transcript FILE (via `agent_transcript_path`).
Pi's subagent messages are in-memory. The bridge writes them to a temp file
to match the expected interface. The file is cleaned up immediately after dispatch.

---

## Future

The loom repo contains a planned full pi extension at `pi/extension.ts` that
imports engine core functions directly (no CLI subprocess). This requires
extracting pure business logic from handlers into `engine/src/core/`.

When complete, this replaces both the loom-bridge AND hooks.json with a single
TypeScript extension. See `docs/migration-claude-code-to-pi.md` section
"Dual-Client Architecture" for the full plan.

---

## Pi Compatibility Patches (Required)

The installed loom plugin (`~/.claude/plugins/cache/plugins/loom/`) needs three
handler patches. Without these, wave-gate enforcement and phase validation
are silently bypassed because handlers read Claude Code field names that
pi doesn't send.

### What to patch

All three PreToolUse handlers:
- `engine/src/handlers/pre-tool-use/validate-task-execution.ts`
- `engine/src/handlers/pre-tool-use/validate-template-substitution.ts`
- `engine/src/handlers/pre-tool-use/validate-phase-order.ts`

### Changes needed

**1. Accept both tool names:**
```typescript
// Before (Claude Code only):
if (input.tool_name !== "Task") return { kind: "allow" };

// After (Claude Code + pi):
if (input.tool_name !== "Task" && input.tool_name !== "subagent") return { kind: "allow" };
```

**2. Read both prompt field names:**
```typescript
// Before (Claude Code only):
const prompt = (input.tool_input?.prompt as string) ?? "";

// After (Claude Code + pi):
const prompt = (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "";
```

**3. Read both agent type field names** (validate-phase-order only):
```typescript
// Before:
agentType: stripNamespace((input.tool_input?.subagent_type as string) ?? "")

// After:
agentType: stripNamespace((input.tool_input?.subagent_type as string) ?? (input.tool_input?.agent as string) ?? "")
```

### One-liner patch script

```bash
INSTALLED=~/.claude/plugins/cache/plugins/loom/*/

perl -i -pe 's/if \(input\.tool_name !== "Task"\) return \{ kind: "allow" \};/if (input.tool_name !== "Task" \&\& input.tool_name !== "subagent") return { kind: "allow" };/' \
  $INSTALLED/engine/src/handlers/pre-tool-use/validate-task-execution.ts \
  $INSTALLED/engine/src/handlers/pre-tool-use/validate-template-substitution.ts \
  $INSTALLED/engine/src/handlers/pre-tool-use/validate-phase-order.ts

perl -i -pe 's/const prompt = \(input\.tool_input\?\.prompt as string\) \?\? "";/const prompt = (input.tool_input?.prompt as string) ?? (input.tool_input?.task as string) ?? "";/' \
  $INSTALLED/engine/src/handlers/pre-tool-use/validate-task-execution.ts \
  $INSTALLED/engine/src/handlers/pre-tool-use/validate-template-substitution.ts \
  $INSTALLED/engine/src/handlers/pre-tool-use/validate-phase-order.ts

perl -i -pe 's/stripNamespace\(\(input\.tool_input\?\.subagent_type as string\)/stripNamespace((input.tool_input?.subagent_type as string) ?? (input.tool_input?.agent as string)/' \
  $INSTALLED/engine/src/handlers/pre-tool-use/validate-phase-order.ts
```

### Why this happens

Pi's `subagent` tool sends different field names than Claude Code's `Task` tool:

| Field | Claude Code (`Task`) | Pi (`subagent`) |
|-------|---------------------|-----------------|
| Tool name | `"Task"` | `"subagent"` |
| Task text | `tool_input.prompt` | `tool_input.task` |
| Agent name | `tool_input.subagent_type` | `tool_input.agent` |

The handlers check `tool_name !== "Task"` as an early exit (only validate Task
tool calls, not Bash/Edit/etc). Without the patch, pi's subagent calls pass
this guard and then fail to extract the task ID (because `prompt` is undefined),
causing the handler to return `allow` at the "not a planned task" fallback.
