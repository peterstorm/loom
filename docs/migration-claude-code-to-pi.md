# Migration Guide: Claude Code → Pi

Migrating plugins, skills, commands, hooks, and settings from Claude Code to the [pi coding agent](https://pi.dev) harness.

## Table of Contents

- [Overview](#overview)
- [Concept Mapping](#concept-mapping)
- [1. Context Files](#1-context-files)
- [2. Commands → Prompt Templates & Skills](#2-commands--prompt-templates--skills)
- [3. Hooks → Extensions](#3-hooks--extensions)
- [4. Plugins → Pi Packages](#4-plugins--pi-packages)
- [5. Marketplace Skills](#5-marketplace-skills)
- [6. Settings](#6-settings)
- [7. Quick Start Migration Steps](#7-quick-start-migration-steps)
- [8. Sub-Agents](#8-sub-agents)
- [9. Session File Format (JSONL Transcript Parsing)](#9-session-file-format-jsonl-transcript-parsing)
- [Key Differences](#key-differences)
- [Appendix: Loom Plugin Deep Dive](#appendix-loom-plugin-deep-dive)

---

## Overview

Claude Code organizes customization into plugins (bundles of commands, hooks, and skills), marketplace skills, context files (`CLAUDE.md`), and settings. Pi uses a different but largely compatible set of primitives:

| Claude Code | Pi |
|---|---|
| Commands (`.md` files) | **Prompt Templates** or **Skills** |
| Hooks (shell scripts via `hooks.json`) | **Extensions** (TypeScript event handlers) |
| Plugins (bundles) | **Pi Packages** (npm/git) or local extensions + skills |
| Marketplace skills (`SKILL.md`) | **Skills** (same Agent Skills standard) |
| `CLAUDE.md` | `AGENTS.md` (pi also loads `CLAUDE.md`) |
| `settings.json` / `settings.local.json` | `~/.pi/agent/settings.json` / `.pi/settings.json` |

---

## Concept Mapping

### Claude Code Hook → Pi Extension Event

| Claude Code Hook | Pi Extension Event | Notes |
|---|---|---|
| `PreToolUse` | `pi.on("tool_call", ...)` | Can block, mutate input |
| `PostToolUse` | `pi.on("tool_result", ...)` | Can modify result |
| `SessionStart` | `pi.on("session_start", ...)` | Fires on start/reload/resume |
| `SessionEnd` | `pi.on("session_shutdown", ...)` | Fires on quit/reload/switch |
| `UserPromptSubmit` | `pi.on("input", ...)` or `pi.on("before_agent_start", ...)` | Input for transform/intercept, before_agent_start for context injection |
| `SubagentStart` | Custom tool or `pi.sendUserMessage()` | Sub-agents not built-in; build with extensions |
| `SubagentStop` | Custom tool or event handler | Build dispatch logic in extension |

### Claude Code Directory → Pi Directory

| Claude Code | Pi |
|---|---|
| `~/.claude/` | `~/.pi/agent/` |
| `~/.claude/CLAUDE.md` | `~/.pi/agent/AGENTS.md` |
| `.claude/CLAUDE.md` | `.pi/AGENTS.md` (or keep `CLAUDE.md` in project root) |
| `.claude/settings.local.json` | `.pi/settings.json` |
| Plugin `commands/*.md` | `~/.pi/agent/prompts/` or `~/.pi/agent/skills/` |
| Plugin `hooks/` | `~/.pi/agent/extensions/*.ts` |
| Plugin `skills/` | `~/.pi/agent/skills/` |

---

## 1. Context Files

Pi auto-discovers both `AGENTS.md` **and** `CLAUDE.md`, so existing context files work without changes.

| Claude Code | Pi | Action |
|---|---|---|
| `~/.claude/CLAUDE.md` | `~/.pi/agent/AGENTS.md` | Copy or symlink |
| Project `CLAUDE.md` | Keep as-is | Pi loads it automatically |
| `.claude/CLAUDE.md` | `.pi/AGENTS.md` or project root `CLAUDE.md` | Move or symlink |

Pi loads context files from:
- `~/.pi/agent/AGENTS.md` (global)
- Parent directories walking up from cwd
- Current directory

---

## 2. Commands → Prompt Templates & Skills

Claude Code "commands" are `.md` files that expand when you type `/commandname`. In pi, these map to two things depending on complexity:

### Simple Commands → Prompt Templates

For commands that are just text expansions (no scripts, no multi-file references):

```bash
# Copy the markdown file to pi's prompts directory
cp ~/.claude/plugins/cache/plugins/feynman/0.1.0/commands/feynman.md \
   ~/.pi/agent/prompts/feynman.md
```

Place in `~/.pi/agent/prompts/` (global) or `.pi/prompts/` (project-local). Use with `/feynman` in pi.

Prompt templates support variables:

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

### Complex Commands → Skills

For commands with scripts, references, or multi-file structures:

```bash
# Copy the entire skill directory
cp -r ~/dev/claude-plugins/loom/skills/nextjs-frontend-design \
   ~/.pi/agent/skills/nextjs-frontend-design
```

Ensure the skill has a `SKILL.md` with proper frontmatter:

```markdown
---
name: nextjs-frontend-design
description: Frontend design patterns for Next.js applications with component library, animation recipes, and TypeScript patterns.
---

# Next.js Frontend Design
...
```

Place in `~/.pi/agent/skills/` (global) or `.pi/skills/` (project-local). Use with `/skill:nextjs-frontend-design` in pi.

### Decision Guide

| Command Type | Pi Target | Example |
|---|---|---|
| Simple text prompt | Prompt Template (`prompts/`) | `/feynman`, `/clarify`, `/brainstorming` |
| Has scripts/references/assets | Skill (`skills/`) | `/loom`, `/nextjs-frontend-design` |
| Registers slash command with logic | Extension (`extensions/`) | Custom commands needing programmatic behavior |

---

## 3. Hooks → Extensions

This is the biggest migration effort. Claude Code hooks are shell scripts triggered by JSON config. Pi uses TypeScript extensions with event handlers.

### Extension Basics

Create `~/.pi/agent/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("event_name", async (event, ctx) => {
    // handle event
  });
}
```

Extensions are auto-discovered from `~/.pi/agent/extensions/` (global) and `.pi/extensions/` (project-local). Hot-reload with `/reload`.

### Example: Cortex Memory Hooks → Extension

**Claude Code (`hooks.json`):**
```json
{
  "SessionStart": [{ "command": "bash .../load-surface.sh" }],
  "SessionEnd": [{ "command": "bash .../extract-and-generate.sh" }],
  "UserPromptSubmit": [
    { "command": "cat .claude/cortex-memory.local.md" },
    { "command": "bash .../prompt-recall.sh" }
  ]
}
```

**Pi Extension (`~/.pi/agent/extensions/cortex.ts`):**
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  const CORTEX_DIR = "/path/to/cortex/engine";

  // SessionStart → session_start
  pi.on("session_start", async (_event, _ctx) => {
    try {
      execSync(`bash ${CORTEX_DIR}/hooks/scripts/load-surface.sh`, {
        timeout: 30_000,
      });
    } catch {}
  });

  // SessionEnd → session_shutdown
  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      execSync(`bash ${CORTEX_DIR}/hooks/scripts/extract-and-generate.sh`, {
        timeout: 300_000,
      });
    } catch {}
  });

  // UserPromptSubmit → before_agent_start (inject context)
  pi.on("before_agent_start", async (_event, _ctx) => {
    let extra = "";
    try {
      extra = execSync("cat .claude/cortex-memory.local.md 2>/dev/null || true").toString();
    } catch {}
    try {
      extra += execSync(`bash ${CORTEX_DIR}/hooks/scripts/prompt-recall.sh`, {
        timeout: 5_000,
      }).toString();
    } catch {}

    if (extra.trim()) {
      return {
        message: {
          customType: "cortex-memory",
          content: extra,
          display: false,
        },
      };
    }
  });
}
```

### Example: PreToolUse Guards → Extension

**Claude Code (`hooks.json`):**
```json
{
  "PreToolUse": [
    { "matcher": "Edit", "command": "bash .../block-direct-edits.sh" },
    { "matcher": "Write", "command": "bash .../block-direct-edits.sh" },
    { "matcher": "Bash", "command": "bash .../guard-state-file.sh" }
  ]
}
```

**Pi Extension (`~/.pi/agent/extensions/loom-guards.ts`):**
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  const LOOM_DIR = "..."; // resolve dynamically or hardcode

  pi.on("tool_call", async (event, ctx) => {
    // Block direct edits during loom orchestration
    if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
      try {
        const result = execSync(
          `bash ${LOOM_DIR}/hooks/scripts/block-direct-edits.sh`,
        ).toString();
        if (result.includes("BLOCK")) {
          return { block: true, reason: "Direct edits blocked during Loom orchestration" };
        }
      } catch {
        return { block: true, reason: "Edit guard script failed" };
      }
    }

    // Guard state file on bash commands
    if (isToolCallEventType("bash", event)) {
      try {
        execSync(`bash ${LOOM_DIR}/hooks/scripts/guard-state-file.sh`);
      } catch {
        return { block: true, reason: "State file guard triggered" };
      }
    }
  });
}
```

### Example: Permission Gates (replacing `settings.local.json` allow rules)

**Claude Code (`.claude/settings.local.json`):**
```json
{
  "permissions": {
    "allow": [
      "Bash(git push:*)",
      "Bash(gh pr:*)"
    ]
  }
}
```

**Pi Extension (`~/.pi/agent/extensions/permissions.ts`):**
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const ALLOWED_PATTERNS = [/^git push/, /^gh pr/];

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;

      // Auto-allow matching patterns
      if (ALLOWED_PATTERNS.some((p) => p.test(cmd))) {
        return; // allow
      }

      // Block dangerous commands
      if (cmd.includes("rm -rf") || cmd.includes("sudo")) {
        const ok = await ctx.ui.confirm("Dangerous Command", `Allow: ${cmd}?`);
        if (!ok) return { block: true, reason: "Blocked by user" };
      }
    }
  });
}
```

### Hook → Event Quick Reference

```
Claude Code                          Pi Extension
──────────────────────────────────── ────────────────────────────────────
PreToolUse + matcher "Bash"     →   pi.on("tool_call", ...) + isToolCallEventType("bash", event)
PreToolUse + matcher "Edit"     →   pi.on("tool_call", ...) + isToolCallEventType("edit", event)
PreToolUse + matcher "Write"    →   pi.on("tool_call", ...) + isToolCallEventType("write", event)
PreToolUse + matcher "Read"     →   pi.on("tool_call", ...) + isToolCallEventType("read", event)
PreToolUse + matcher "Agent"    →   No built-in spawn tool; build custom tool via pi.registerTool()
  (Claude Code renamed this tool "Task" → "Agent"; loom's matcher covers both.)
PostToolUse                     →   pi.on("tool_result", ...)
SessionStart                    →   pi.on("session_start", ...)
SessionEnd                      →   pi.on("session_shutdown", ...)
UserPromptSubmit                →   pi.on("input", ...) for transform/intercept
                                    pi.on("before_agent_start", ...) for context injection
SubagentStart                   →   Custom tool + pi.exec() or tmux spawn
SubagentStop                    →   Custom tool result handler
```

---

## 4. Plugins → Pi Packages

Claude Code plugins bundle commands + hooks + skills into installable packages. Pi has an equivalent: **pi packages** — npm or git repos that bundle extensions, skills, prompts, and themes.

**Yes, you can bundle everything into one package.** A pi package can contain extensions, skills, prompts, themes, and any supporting files (agents, rules, references, engine code). The extension code can reference sibling files in the package using `import.meta.url`.

### Package Manifest

Pi packages declare resources in `package.json` under the `pi` key:

```json
{
  "name": "loom-pi-package",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "dependencies": {
    "ts-pattern": "^5.0.0"
  }
}
```

The `pi` manifest supports four resource types: `extensions`, `skills`, `prompts`, `themes`. Each is an array of paths (directories or files, supports globs).

**Without a `pi` manifest**, pi auto-discovers from conventional directories: `extensions/`, `skills/`, `prompts/`, `themes/`.

### What About Agents, Rules, References, Engine?

Pi packages only auto-discover the four resource types above. But agents, rules, references, and engine code **don't need auto-discovery** — they're referenced by your extension code and skill/agent content via paths.

Two approaches:

**Approach 1: Extension discovers agents/rules via `resources_discover` + `import.meta.url`**

Your extension can dynamically contribute skill paths and use its own directory as the base:

```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

export default function (pi: ExtensionAPI) {
  // Dynamically contribute skills from this package
  pi.on("resources_discover", () => ({
    skillPaths: [
      join(PACKAGE_ROOT, "../skills"),  // relative to extension file
    ],
    promptPaths: [
      join(PACKAGE_ROOT, "../prompts"),
    ],
  }));

  // Import engine code directly (it's in the same package)
  // import { StateManager } from "../engine/src/state-manager";
  // import { PHASE_ORDER } from "../engine/src/config";
}
```

**Approach 2: Agents/rules are just files that skills and agent definitions tell the model to `read`**

Skill content and agent system prompts reference files by path. The model uses the `read` tool to load them on demand. Just include the files in your package and reference them:

```markdown
<!-- In a skill SKILL.md or agent .md -->
**Always read before reviewing:**
- `~/.pi/agent/agents/rules/architecture.md`
- `~/.pi/agent/agents/rules/typescript-patterns.md`
```

For a self-contained package, the subagent extension's agent discovery loads agents from `~/.pi/agent/agents/` (user) and `.pi/agents/` (project). Copy your agents there, or extend the discovery in your extension.

### Full Loom Package Structure

```
loom-pi/
├── package.json              # pi manifest + dependencies
├── extensions/
│   └── index.ts              # Main extension (hooks, tools, commands)
├── agents/                   # Subagent definitions (loaded by subagent tool)
│   ├── architecture-agent.md
│   ├── code-implementer-agent.md
│   ├── code-reviewer.md
│   └── ...21 agents
├── rules/                    # Reference docs (read by agents on demand)
│   ├── architecture.md
│   ├── java-patterns.md
│   ├── typescript-patterns.md
│   ├── property-testing.md
│   └── rust-patterns.md
├── skills/                   # Auto-discovered by pi
│   ├── loom/
│   │   ├── SKILL.md          # Main /skill:loom entry point
│   │   ├── templates/
│   │   └── references/
│   ├── nextjs-frontend-design/
│   │   └── SKILL.md
│   └── vercel-react-best-practices/
│       └── SKILL.md
├── prompts/                  # Auto-discovered by pi
│   ├── clarify.md
│   ├── brainstorming.md
│   ├── review-pr.md
│   ├── wave-gate.md
│   └── ...more commands
└── engine/                   # Engine code (imported by extension)
    ├── src/
    │   ├── cli.ts
    │   ├── config.ts
    │   ├── types.ts
    │   ├── state-manager.ts
    │   ├── handlers/
    │   ├── parsers/
    │   └── utils/
    └── package.json
```

**`package.json`:**
```json
{
  "name": "@peterstorm/loom",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  },
  "dependencies": {
    "ts-pattern": "^5.0.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

The extension imports engine code directly:

```typescript
// extensions/index.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");
const RULES_DIR = join(PACKAGE_ROOT, "rules");

// Import engine code directly — no shell wrappers needed
// import { StateManager } from "../engine/src/state-manager";
// import { PHASE_ORDER, PHASE_AGENT_MAP } from "../engine/src/config";

export default function (pi: ExtensionAPI) {
  // Hook: tool_call guards
  pi.on("tool_call", async (event, ctx) => {
    // ... validation logic using engine imports directly
  });

  // Hook: session lifecycle
  pi.on("session_start", async (event, ctx) => {
    // ... cleanup stale state
  });

  // Custom command: /loom-status
  pi.registerCommand("loom-status", {
    description: "Show current loom orchestration status",
    handler: async (args, ctx) => {
      // ... read state file, show status
    },
  });
}
```

### Installing Packages

```bash
# From git (your loom repo)
pi install git:github.com/peterstorm/loom

# From git with pinned version
pi install git:github.com/peterstorm/loom@v1.0.0

# From npm
pi install npm:@peterstorm/loom

# Local path (for development — no copy, references in-place)
pi install ./path/to/loom-pi

# Quick test without installing
pi -e ./extensions/index.ts --skill ./skills/loom

# Manage
pi list                     # show installed packages
pi config                   # enable/disable specific resources
pi update                   # update all packages
pi remove git:github.com/peterstorm/loom
```

Project-local install (writes to `.pi/settings.json`, shared with team):
```bash
pi install -l git:github.com/peterstorm/loom
```

### Package Filtering

Users can selectively enable/disable parts of your package:

```json
{
  "packages": [
    {
      "source": "git:github.com/peterstorm/loom",
      "extensions": ["extensions/*.ts"],
      "skills": ["skills/loom"],
      "prompts": []
    }
  ]
}
```

### Or Just Use Local Directories

If you don't need to distribute, just place files directly:

```
~/.pi/agent/
├── extensions/
│   ├── cortex.ts
│   └── loom/
│       └── index.ts
├── agents/                   # Loaded by subagent extension
│   ├── architecture-agent.md
│   ├── code-reviewer.md
│   └── ...
├── rules/                    # Read by agents on demand
│   ├── architecture.md
│   └── ...
├── skills/
│   ├── loom/
│   │   └── SKILL.md
│   └── impeccable/
│       └── SKILL.md
└── prompts/
    ├── feynman.md
    ├── clarify.md
    └── brainstorming.md
```

---

## 5. Marketplace Skills

Claude Code marketplace skills that follow the [Agent Skills standard](https://agentskills.io) (i.e., have `SKILL.md` with frontmatter) work in pi as-is.

### Option A: Point pi at existing Claude Code skills

Add to `~/.pi/agent/settings.json`:

```json
{
  "skills": [
    "~/.claude/plugins/cache/impeccable/impeccable/3.0.7/skills",
    "~/.claude/plugins/cache/frontend-slides/frontend-slides/1.0.0/skills"
  ]
}
```

### Option B: Copy into pi's skills directory

```bash
cp -r ~/.claude/plugins/cache/impeccable/impeccable/3.0.7/skills/impeccable \
   ~/.pi/agent/skills/impeccable

cp -r ~/.claude/plugins/cache/frontend-slides/frontend-slides/1.0.0/skills/* \
   ~/.pi/agent/skills/
```

### Using skills from other harnesses

Pi natively supports loading skills from Claude Code or OpenAI Codex directories:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

---

## 6. Settings

### Claude Code → Pi Settings Map

| Claude Code Setting | Pi Equivalent |
|---|---|
| `"model": "opus[1m]"` | `pi --model opus --thinking high` or `/model` + `/settings` |
| `"effortLevel": "high"` | `--thinking high` or Shift+Tab to cycle |
| `"autoCompactEnabled": true` | Enabled by default |
| `"statusLine": { "command": "..." }` | `ctx.ui.setStatus()` in extension |
| `"enabledPlugins": { ... }` | Auto-discovered; toggle with `pi config` |
| `"env": { "KEY": "val" }` | Set in shell or `.env` |
| `"permissions.allow"` | Extension with `tool_call` event handler |

### Pi Settings File

**Global:** `~/.pi/agent/settings.json`
**Project:** `.pi/settings.json`

```json
{
  "skills": [
    "~/.claude/skills"
  ],
  "extensions": [
    "/path/to/extra/extension.ts"
  ]
}
```

Use `/settings` in interactive mode for common options (thinking level, theme, etc.).

---

## 7. Quick Start Migration Steps

```bash
# 1. Create pi directories
mkdir -p ~/.pi/agent/{extensions,skills,prompts}

# 2. Copy simple commands as prompt templates
# Note: Use the repo version (~/dev/claude-plugins/loom), NOT the installed
# cache — the repo is newer and self-contained with ${CLAUDE_PLUGIN_ROOT} paths
LOOM_REPO=~/dev/claude-plugins/loom

cp ~/.claude/plugins/cache/plugins/feynman/0.1.0/commands/feynman.md \
   ~/.pi/agent/prompts/
cp $LOOM_REPO/commands/clarify.md \
   ~/.pi/agent/prompts/
cp $LOOM_REPO/commands/brainstorming.md \
   ~/.pi/agent/prompts/
cp $LOOM_REPO/commands/review-pr.md \
   ~/.pi/agent/prompts/
cp $LOOM_REPO/commands/wave-gate.md \
   ~/.pi/agent/prompts/

# 3. Copy complex skills (repo already has proper skills/ structure)
mkdir -p ~/.pi/agent/skills/loom
cp $LOOM_REPO/commands/loom.md \
   ~/.pi/agent/skills/loom/SKILL.md
cp -r $LOOM_REPO/commands/templates \
   ~/.pi/agent/skills/loom/
cp -r $LOOM_REPO/engine \
   ~/.pi/agent/skills/loom/
cp -r $LOOM_REPO/references \
   ~/.pi/agent/skills/loom/
cp -r $LOOM_REPO/rules \
   ~/.pi/agent/skills/loom/

# Copy bundled skills (already in skills/ with SKILL.md)
cp -r $LOOM_REPO/skills/* ~/.pi/agent/skills/

cp -r ~/.claude/plugins/cache/impeccable/impeccable/3.0.7/skills/impeccable \
   ~/.pi/agent/skills/

# 4. Copy agents (for subagent extension)
mkdir -p ~/.pi/agent/agents
cp $LOOM_REPO/agents/*.md ~/.pi/agent/agents/

# 5. Copy cortex commands as prompt templates
cp ~/.claude/plugins/cache/plugins/cortex/0.1.0/commands/remember.md \
   ~/.pi/agent/prompts/
cp ~/.claude/plugins/cache/plugins/cortex/0.1.0/commands/recall.md \
   ~/.pi/agent/prompts/
cp ~/.claude/plugins/cache/plugins/cortex/0.1.0/commands/forget.md \
   ~/.pi/agent/prompts/
cp ~/.claude/plugins/cache/plugins/cortex/0.1.0/commands/inspect.md \
   ~/.pi/agent/prompts/

# 5. Create extensions for hooks (see examples in section 3 above)
# → ~/.pi/agent/extensions/cortex.ts
# → ~/.pi/agent/extensions/loom-guards.ts

# 6. Copy context files
cp ~/.claude/CLAUDE.md ~/.pi/agent/AGENTS.md 2>/dev/null || true

# 7. Verify
pi  # Start pi, check startup header for loaded skills/extensions/prompts
```

---

## 8. Sub-Agents

Claude Code has a built-in `Task` tool for spawning sub-agents. Pi doesn't include this by default, but ships a **full subagent example extension** that's actually more capable:

```
examples/extensions/subagent/
├── index.ts             # Extension entry point
├── agents.ts            # Agent discovery logic
├── agents/              # Agent definitions (markdown with frontmatter)
│   ├── scout.md         # Fast recon (Haiku, read-only tools)
│   ├── planner.md       # Implementation plans (Sonnet, read-only)
│   ├── reviewer.md      # Code review (Sonnet)
│   └── worker.md        # General-purpose (Sonnet, all tools)
└── prompts/             # Workflow presets
    ├── implement.md             # scout → planner → worker
    ├── scout-and-plan.md        # scout → planner
    └── implement-and-review.md  # worker → reviewer → worker
```

### Installation

```bash
# Copy the extension
cp -r "$(dirname $(which pi))/../lib/node_modules/pi-monorepo/examples/extensions/subagent" \
  ~/.pi/agent/extensions/subagent

# Copy sample agents
mkdir -p ~/.pi/agent/agents
cp ~/.pi/agent/extensions/subagent/agents/*.md ~/.pi/agent/agents/

# Copy workflow prompts
mkdir -p ~/.pi/agent/prompts
cp ~/.pi/agent/extensions/subagent/prompts/*.md ~/.pi/agent/prompts/
```

Or if installed via nix, symlink from the store path.

### Features

The subagent extension supports three modes:

| Mode | Usage | Description |
|------|-------|-------------|
| **Single** | `{ agent: "scout", task: "find auth code" }` | One agent, one task |
| **Parallel** | `{ tasks: [{agent, task}, ...] }` | Up to 8 tasks, 4 concurrent |
| **Chain** | `{ chain: [{agent, task}, ...] }` | Sequential with `{previous}` placeholder |

Each subagent spawns a separate `pi` process with isolated context. Features include:
- **Streaming output** — see tool calls and progress as they happen
- **Parallel streaming** — all parallel tasks stream updates simultaneously
- **Usage tracking** — turns, tokens, cost, and context usage per agent
- **Abort support** — Ctrl+C propagates to kill subagent processes
- **Agent scoping** — user-level (`~/.pi/agent/agents/`) and project-level (`.pi/agents/`)
- **Security confirmation** — prompts before running project-local agents

### Defining Custom Agents

Agents are markdown files with YAML frontmatter placed in `~/.pi/agent/agents/` (global) or `.pi/agents/` (project-local):

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
Be concise. Focus on X.
```

### Workflow Prompts

Use prompt templates to define multi-agent workflows:

```markdown
<!-- ~/.pi/agent/prompts/implement.md -->
Use a chain of subagents:
1. scout: Find all relevant code for: {{task}}
2. planner: Create implementation plan based on {previous}
3. worker: Implement the plan from {previous}
```

Then invoke with `/implement add Redis caching to the session store`.

### Mapping Loom Sub-Agents

Your Loom plugin's sub-agent orchestration maps well to this extension:

| Loom Concept | Pi Subagent Equivalent |
|---|---|
| `Task` tool call with agent | `subagent` tool with `{ agent, task }` |
| Wave-based parallel execution | `{ tasks: [...] }` parallel mode |
| Phase-ordered execution | `{ chain: [...] }` chain mode |
| Agent model selection | `model:` in agent frontmatter |
| Agent skill/tool restrictions | `tools:` in agent frontmatter |
| SubagentStart/Stop hooks | Not needed — extension handles lifecycle |
| Dispatch/cleanup scripts | `session_start` / `session_shutdown` events |

---

## 9. Session File Format (JSONL Transcript Parsing)

Both Claude Code and pi use **JSONL** (one JSON object per line), but the schemas differ. Since Loom parses agent transcripts heavily, here's the mapping.

### Format Comparison

| Aspect | Claude Code | Pi |
|---|---|---|
| Format | JSONL | JSONL |
| Structure | Flat linked list (`parentUuid`) | Tree (`id`/`parentId`) with branching |
| Location | `~/.claude/projects/<path>/<uuid>.jsonl` | `~/.pi/agent/sessions/<path>/<timestamp>_<uuid>.jsonl` |
| Header | No dedicated header line | First line: `{"type":"session", "version":3, ...}` |
| Entry linking | `parentUuid` / `uuid` | `id` (8-char hex) / `parentId` |
| Branching | Separate files for subagents | In-place tree branching in single file |
| Sub-agent sessions | `subagents/agent-<id>.jsonl` | Separate pi process, separate session file |

### Claude Code Entry Types → Pi Entry Types

| Claude Code `type` | Pi `type` | Notes |
|---|---|---|
| `"human"` / user turn | `"message"` with `message.role: "user"` | |
| `"assistant"` / assistant turn | `"message"` with `message.role: "assistant"` | |
| `"tool_use"` / `"tool_result"` | `"message"` with `message.role: "toolResult"` | Tool calls are inline in assistant content |
| `"attachment"` | No direct equivalent | Use `"custom_message"` or `"custom"` |
| `"queue-operation"` | No equivalent | Pi uses message queue differently |
| `"agent_listing_delta"` | No equivalent | Pi discovers agents at runtime |
| (subagent session file) | Separate pi session file | Subagent output captured in tool result |

### Pi Session Entry Structure

Every pi entry (except the header) has:

```typescript
{
  type: string;           // "message", "compaction", "model_change", etc.
  id: string;             // 8-char hex ID
  parentId: string | null; // Parent entry (null for first)
  timestamp: string;      // ISO timestamp
  // ...type-specific fields
}
```

### Pi Message Roles

```typescript
type AgentMessage =
  | UserMessage            // role: "user"
  | AssistantMessage       // role: "assistant" (includes tool calls inline)
  | ToolResultMessage      // role: "toolResult"
  | BashExecutionMessage   // role: "bashExecution" (user ! commands)
  | CustomMessage          // role: "custom" (extension-injected)
  | BranchSummaryMessage   // role: "branchSummary"
  | CompactionSummaryMessage // role: "compactionSummary"
```

### Key Differences for Transcript Parsing

**Tool calls are embedded in assistant messages**, not separate entries:

```json
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","message":{
  "role":"assistant",
  "content":[
    {"type":"text","text":"Let me check that file."},
    {"type":"toolCall","id":"call_123","name":"read","arguments":{"path":"src/main.ts"}}
  ],
  "provider":"anthropic","model":"claude-sonnet-4-5",
  "usage":{"input":1000,"output":200,"cacheRead":500,"cacheWrite":0,"totalTokens":1700,
    "cost":{"input":0.003,"output":0.006,"cacheRead":0.0005,"cacheWrite":0,"total":0.0095}},
  "stopReason":"toolUse"
}}
```

**Tool results are separate message entries** linked by `toolCallId`:

```json
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","message":{
  "role":"toolResult","toolCallId":"call_123","toolName":"read",
  "content":[{"type":"text","text":"file contents..."}],
  "details":{},"isError":false
}}
```

**Tree structure** means you need to follow `parentId` to get the active branch:

```typescript
// Walk from leaf to root to get the active conversation
function getActiveBranch(entries: any[], leafId: string): any[] {
  const byId = new Map(entries.map(e => [e.id, e]));
  const branch: any[] = [];
  let current = byId.get(leafId);
  while (current) {
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch;
}
```

### Parsing Example (for Loom transcript analysis)

```typescript
import { readFileSync } from "fs";

const lines = readFileSync("session.jsonl", "utf8").trim().split("\n");
const entries = lines.map(l => JSON.parse(l));

// Skip header
const header = entries[0]; // type: "session"
const dataEntries = entries.slice(1);

// Find the leaf (last entry)
const leaf = dataEntries[dataEntries.length - 1];

// Extract conversation messages
for (const entry of dataEntries) {
  if (entry.type !== "message") continue;
  const msg = entry.message;

  switch (msg.role) {
    case "user":
      console.log(`USER: ${typeof msg.content === "string" ? msg.content : msg.content.map(c => c.text).join("")}`);  
      break;
    case "assistant":
      const text = msg.content.filter(c => c.type === "text").map(c => c.text).join("");
      const toolCalls = msg.content.filter(c => c.type === "toolCall");
      if (text) console.log(`ASSISTANT: ${text}`);
      for (const tc of toolCalls) {
        console.log(`  TOOL_CALL: ${tc.name}(${JSON.stringify(tc.arguments)})`);
      }
      // Usage info:
      console.log(`  tokens: ${msg.usage.totalTokens}, cost: $${msg.usage.cost.total}`);
      break;
    case "toolResult":
      const output = msg.content.map(c => c.text).join("");
      console.log(`  TOOL_RESULT [${msg.toolName}]: ${output.slice(0, 100)}...`);
      break;
  }
}
```

### Using SessionManager API (from Extensions)

If your Loom extension runs inside pi, you can skip raw JSONL parsing and use the typed API:

```typescript
pi.on("agent_end", async (event, ctx) => {
  // Get all entries on the active branch
  const branch = ctx.sessionManager.getBranch();
  
  // Get full context as the LLM sees it
  const { messages, thinkingLevel, model } = ctx.sessionManager.buildSessionContext();
  
  // Iterate messages with full typing
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "toolCall") {
          console.log(`Tool: ${part.name}, args: ${JSON.stringify(part.arguments)}`);
        }
      }
    }
  }
});
```

See [session-format.md](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md) for the complete specification.

---

## Key Differences

| Feature | Claude Code | Pi |
|---|---|---|
| **Hooks** | Shell scripts via JSON config | TypeScript extensions with event handlers |
| **Sub-agents** | Built-in `Task` tool | Not built-in — build with extensions (spawn pi via tmux, `pi.exec()`) |
| **Permissions** | `settings.local.json` allow/deny rules | Extensions with `tool_call` event blocking |
| **Commands** | `.md` files in `commands/` | Prompt templates, skills, or `pi.registerCommand()` |
| **Plugins** | Installed via marketplace | Pi packages via `pi install npm:` or `pi install git:` |
| **MCP** | Built-in MCP server support | Not built-in — use extensions or CLI tools with skills |
| **Plan mode** | Built-in | Not built-in — use skills, write plans to files, or build via extensions |
| **Status line** | Shell command in settings | `ctx.ui.setStatus()` in extension |
| **Custom UI** | Limited | Full TUI components via `ctx.ui.custom()` |
| **Hot reload** | Restart required | `/reload` reloads extensions, skills, prompts, themes |

### Advantages of Pi's Approach

- **TypeScript extensions** are more powerful than shell script hooks — full access to session state, UI, model info
- **Event chaining** — multiple extensions can handle the same event, each seeing the result of previous handlers
- **Custom tools** — register tools the LLM can call, not just intercept existing ones
- **Custom UI** — build interactive wizards, selectors, status bars
- **Hot reload** — `/reload` picks up changes without restarting
- **Composable** — extensions, skills, prompts, and themes can be bundled into shareable packages

### Migration Effort by Plugin

| Plugin | Effort | Notes |
|---|---|---|
| **feynman** | Low | Single command → prompt template, copy the `.md` |
| **cortex** | Medium | Hooks → extension, commands → prompts, engine scripts stay as-is |
| **loom** | High | Heavy hook usage, sub-agent orchestration, engine CLI — needs extension rewrite |
| **impeccable** | Low | Already Agent Skills standard, just copy or point settings |
| **frontend-slides** | Low | Already Agent Skills standard, just copy or point settings |

---

## Appendix: Loom Plugin Deep Dive

Loom is the most complex plugin to migrate. This section inventories every component and maps it to pi.

### Full Component Inventory

#### Agents (21 agent definitions)

Claude Code agent definitions in `agents/*.md` — these are markdown files with YAML frontmatter (`name`, `description`, `model`, `color`, `skills`) and a system prompt body.

| Agent | Role | Claude Code Model | Pi Equivalent |
|---|---|---|---|
| `architecture-agent` | Architectural design | opus | Pi subagent agent definition |
| `adr-writer-agent` | Write Architecture Decision Records | (default) | Pi subagent agent definition |
| `architecture-tech-lead` | Architectural review | (default) | Pi subagent agent definition |
| `brainstorm-agent` | Exploration/ideation | (default) | Pi subagent agent definition |
| `clarify-agent` | Resolve ambiguity | (default) | Pi subagent agent definition |
| `code-implementer-agent` | Implementation (Java/TS) | sonnet | Pi subagent agent definition |
| `code-reviewer` | Code review | (default) | Pi subagent agent definition |
| `code-simplifier` | Code simplification | (default) | Pi subagent agent definition |
| `comment-analyzer` | Comment quality | (default) | Pi subagent agent definition |
| `decompose-agent` | Task decomposition | (default) | Pi subagent agent definition |
| `frontend-agent` | Next.js frontend | (default) | Pi subagent agent definition |
| `plan-alignment-agent` | Plan vs spec gaps | (default) | Pi subagent agent definition |
| `pr-test-analyzer` | PR test coverage | (default) | Pi subagent agent definition |
| `security-agent` | Security analysis | (default) | Pi subagent agent definition |
| `silent-failure-hunter` | Error handling gaps | (default) | Pi subagent agent definition |
| `skill-content-reviewer` | Skill quality review | (default) | Pi subagent agent definition |
| `spec-check-invoker` | Spec alignment check | (default) | Pi subagent agent definition |
| `specify-agent` | Formal specification | (default) | Pi subagent agent definition |
| `test-engineer` | Test writing/fixing | (default) | Pi subagent agent definition |
| `ts-test-agent` | TypeScript testing | (default) | Pi subagent agent definition |
| `type-design-analyzer` | Type design review | (default) | Pi subagent agent definition |
| `dotfiles-agent` | Dotfiles management | (default) | Dropped in repo version (commit `22ee2f4`) |

**Migration:** Copy to `~/.pi/agent/agents/` and adapt frontmatter:

```markdown
<!-- Claude Code format (agents/code-implementer-agent.md) -->
---
name: code-implementer-agent
description: Implementation agent for Java/Spring Boot or TypeScript/Next.js
model: sonnet
color: blue
skills:
  - code-implementer
---
System prompt here...
```

```markdown
<!-- Pi format (~/.pi/agent/agents/code-implementer-agent.md) -->
---
name: code-implementer-agent
description: Implementation agent for Java/Spring Boot or TypeScript/Next.js
model: claude-sonnet-4-5
tools: read, write, edit, bash, grep, find, ls
---
System prompt here...

Preloaded skill content (inline the skill content since pi agents don't auto-load skills):
...
```

**Key difference:** Claude Code agents have `skills:` that auto-preload skill content. Pi subagent agents don't — you need to either inline the skill content in the system prompt, or have the agent use `read` to load it.

#### Commands (10 slash commands)

| Command | Type | Pi Target |
|---|---|---|
| `/loom` | Main orchestration entry | **Skill** (`~/.pi/agent/skills/loom/SKILL.md`) |
| `/wave-gate` | Wave completion gate | **Prompt template** or **skill** |
| `/review-pr` | PR review workflow | **Prompt template** |
| `/clarify` | Clarification phase | **Prompt template** |
| `/brainstorming` | Brainstorm phase | **Prompt template** |
| `/specify` | Specification phase | **Prompt template** |
| `/code-implementer` | Implementation prompt | **Prompt template** |
| `/spec-check` | Spec alignment check | **Prompt template** or **skill** |
| `/architecture-tech-lead` | Architecture review | **Prompt template** |

#### Command Templates (7 phase templates)

Used internally by the loom orchestration flow, referenced from `loom.md`:

| Template | Purpose |
|---|---|
| `phase-brainstorm.md` | Brainstorm phase instructions |
| `phase-specify.md` | Specification phase instructions |
| `phase-clarify.md` | Clarification phase instructions |
| `phase-architecture.md` | Architecture phase instructions |
| `phase-plan-alignment.md` | Plan alignment phase instructions |
| `phase-decompose.md` | Decomposition phase instructions |
| `impl-agent-context.md` | Implementation agent context injection |

**Migration:** These are internal templates referenced by the loom skill. Copy into the loom skill directory:
```
~/.pi/agent/skills/loom/
├── SKILL.md
├── templates/
│   ├── phase-brainstorm.md
│   ├── phase-specify.md
│   └── ...
```

#### Skills (repo-level, 6 + 2 in commands/)

The repo contains 6 skills in `skills/` that agents preload via their `skills:` frontmatter:

| Skill | Purpose | Used by |
|---|---|---|
| `architecture-tech-lead` | Architecture review patterns | `architecture-agent`, `architecture-tech-lead` agent |
| `code-implementer` | FP/DDD implementation patterns | `code-implementer-agent` |
| `java-test-engineer` | Java testing patterns (JUnit, jqwik, Testcontainers) | `java-test-agent` |
| `ts-test-engineer` | TypeScript testing (Vitest, RTL, Playwright) | `ts-test-agent` |
| `security-expert` | Security analysis patterns | `security-agent` |
| `nextjs-frontend-design` | Next.js/React design patterns | `frontend-agent` |

Plus 2 embedded skills in `commands/`:

| Skill | Purpose |
|---|---|
| `nextjs-frontend-design` | Next.js/React design patterns (duplicate of above) |
| `vercel-react-best-practices` | Vercel React performance rules |

**Migration:** Already Agent Skills format. Copy to `~/.pi/agent/skills/`.

#### Rules (5 rule files)

Claude Code rules with `globs:` frontmatter — these inject into context for matching files:

| Rule | Applies to |
|---|---|
| `architecture.md` | `**/*.{ts,tsx,js,jsx,java,kt,hs,scala,rs}` |
| `java-patterns.md` | `**/*.{java}` |
| `typescript-patterns.md` | `**/*.{ts,tsx}` |
| `property-testing.md` | `**/*.test.*` |
| `rust-patterns.md` | `**/*.rs` |

**Migration:** These are just **reference files that agents tell the model to `read`** — the agent body says things like:

```markdown
**Always read:**
- `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md`

**Java** (*.java):
- `${CLAUDE_PLUGIN_ROOT}/rules/java-patterns.md`
```

Note: There are **two versions** of the rule paths in the wild:
- **Repo (dev, newer — use this):** `${CLAUDE_PLUGIN_ROOT}/rules/` — self-contained copies bundled in the plugin (commit `22ee2f4` refactored to this)
- **Installed (cached, older):** `~/.dotfiles/claude/project/*/rules/` — references external dotfiles

The repo version (`dev/claude-plugins/loom`) is 19 commits ahead of the installed version and is already **self-contained** — it bundles rules, skills, and references with `${CLAUDE_PLUGIN_ROOT}/` relative paths. **Port from the repo version**, not the installed cache.

Pi works exactly the same way — agents tell the model to `read` files at paths, and the model uses the `read` tool.

**For the pi package, replace `${CLAUDE_PLUGIN_ROOT}` with the package root path:**

In your extension, resolve the package root:
```typescript
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
```

Then update agent system prompts. Since agents are markdown files loaded by the subagent extension, you can either:

**Option A: Use absolute paths (simplest)**
```markdown
<!-- Agent system prompt references rules at known location -->
**Always read:**
- `~/.pi/agent/rules/architecture.md`
```

**Option B: Keep `${CLAUDE_PLUGIN_ROOT}` and resolve in extension**

Your extension can resolve `${CLAUDE_PLUGIN_ROOT}` in agent system prompts before passing them to the subagent:

```typescript
// In your custom agent loader, replace the variable:
const systemPrompt = raw.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PACKAGE_ROOT);
```

**Option C: Dotfiles references still work**

If you prefer keeping `~/.dotfiles/claude/...` paths (e.g., for a shared source of truth across tools), pi's `read` tool can access them just fine. No migration needed for the paths themselves.

#### References (3 reference docs)

| File | Purpose |
|---|---|
| `plan-template.md` | Template for architecture plans |
| `spec-template.md` | Template for specifications |
| `design-functional-evaluator.md` | Functional design evaluation criteria |

**Migration:** Copy into the loom skill directory. Referenced by agents via relative paths.

#### Hooks → Extension (11 shell scripts, 27 TypeScript handlers)

This is the most complex part. The hooks shell scripts are thin wrappers around the TypeScript engine CLI:

```bash
# Example: hooks/scripts/validate-phase-order.sh
exec bun "$LOOM_DIR/engine/src/cli.ts" pre-tool-use validate-phase-order
```

**Hook categories and their pi equivalents:**

| Hook Category | Scripts | Pi Event | Complexity |
|---|---|---|---|
| **PreToolUse validators** | 7 scripts | `pi.on("tool_call", ...)` | Medium |
| **SubagentStop dispatch** | 1 script (routes to 5 handlers) | `pi.on("tool_result", ...)` on subagent tool | High |
| **SubagentStart** | 1 script | Extension state tracking | Low |
| **SessionStart** | 2 scripts (cleanup-stale-subagents, resume-after-clear) | `pi.on("session_start", ...)` | Low |

**PreToolUse hooks → `tool_call` event:**

| Hook | What it does | Pi mapping |
|---|---|---|
| `validate-phase-order` | Blocks Task calls if phase ordering violated | Block subagent tool if wrong phase |
| `validate-task-execution` | Ensures task in execute phase matches graph | Check task ID against state |
| `validate-template-substitution` | Blocks un-substituted `{LOOM_DIR}` in Task | Check for template vars in tool args |
| `validate-agent-model` | Warns if agent model doesn't match config | Log warning on model mismatch |
| `validate-agent-skill` | Warns if agent missing required skill | Log warning on missing skill |
| `block-direct-edits` | Blocks Edit/Write during orchestration | Block edit/write tools when state active |
| `guard-state-file` | Prevents direct state file writes | Block bash commands touching state |

**SubagentStart hook → extension state:**

| Hook | What it does | Pi mapping |
|---|---|---|
| `mark-subagent-active` | Writes flag file when subagent starts | Track in extension state or `pi.appendEntry()` |

**SessionStart hooks → `session_start` event:**

| Hook | What it does | Pi mapping |
|---|---|---|
| `cleanup-stale-subagents` | Removes orphaned subagent markers on startup | Cleanup in `session_start` handler |
| `resume-after-clear` | Restores loom state after `/clear` | Restore state in `session_start` with `reason: "new"` |

**SubagentStop hooks → `tool_result` event on subagent tool:**

| Handler | What it does |
|---|---|
| `dispatch` | Routes by agent type to appropriate handler |
| `advance-phase` | Moves phase forward after phase agents complete |
| `update-task-status` | Marks tasks done/failed based on transcript |
| `store-reviewer-findings` | Extracts review findings from transcript |
| `store-spec-check-findings` | Extracts spec-check results from transcript |
| `cleanup-subagent-flag` | Removes active subagent marker |

#### Engine (TypeScript CLI + state management)

The engine is a bun-based TypeScript CLI that all hooks call:

```bash
bun engine/src/cli.ts <hook-type> <handler-name> [args...]
bun engine/src/cli.ts init-state --spec-dir <dir> --output <path>
```

**Components:**

| Component | Purpose | Pi Migration |
|---|---|---|
| `cli.ts` | CLI entry point, routes to handlers | Replace with extension direct calls |
| `state-manager.ts` | Atomic task graph JSON read/write with locking | Reuse as-is, or use `pi.appendEntry()` |
| `config.ts` | Constants (phase order, agent maps, patterns) | Import directly into extension |
| `types.ts` | TypeScript types (TaskGraph, Task, Phase, etc.) | Import directly into extension |
| `phase-init.ts` | Initialize state for a new orchestration | Call from extension |
| **Parsers** | | |
| `parse-transcript.ts` | Extract text from Claude Code JSONL | **Must adapt for pi's JSONL format** |
| `parse-bash-test-output.ts` | Detect test pass/fail from bash output | Reuse as-is |
| `parse-files-modified.ts` | Extract modified files from transcript | **Must adapt for pi's format** |
| `parse-phase-artifacts.ts` | Extract phase artifact paths | Reuse as-is |
| **Utils** | | |
| `read-transcript-with-retry.ts` | Retry-read transcript file | Adapt for pi session paths |
| `git.ts` | Git operations (start SHA, diff) | Reuse as-is |
| `lock.ts` | File locking for state writes | Reuse as-is |
| `find-file.ts` | File discovery | Reuse as-is |
| `extract-task-id.ts` | Parse task ID from agent input | Reuse as-is |
| `strip-namespace.ts` | Strip `loom:` prefix from agent types | Reuse as-is |
| **Helper handlers** (called by other handlers, not directly by hooks) | | |
| `cleanup-state.ts` | Remove state file and subagent markers | Reuse as-is |
| `complete-wave-gate.ts` | Mark a wave gate as complete | Reuse as-is |
| `extract-task-id.ts` | Extract task ID from hook input | Reuse as-is |
| `mark-tests-passed.ts` | Mark task tests as passed | Reuse as-is |
| `populate-task-graph.ts` | Fill task graph from decompose output | Reuse as-is |
| `set-phase.ts` | Advance to next phase | Reuse as-is |
| `store-review-findings.ts` | Store code review findings in state | Reuse as-is |
| `store-spec-check.ts` | Store spec-check results in state | Reuse as-is |
| `store-test-evidence.ts` | Store test output evidence | Reuse as-is |
| `suggest-spec-anchors.ts` | Suggest spec anchors for tasks | Reuse as-is |
| `validate-task-graph.ts` | Validate task graph consistency | Reuse as-is |

#### State File (`.claude/state/active_task_graph.json`)

The task graph is a JSON file with chmod 444 protection:

```typescript
interface TaskGraph {
  current_phase: Phase;  // "init" | "brainstorm" | ... | "execute"
  phase_artifacts: Partial<Record<Phase, string>>;
  skipped_phases: Phase[];
  spec_file: string | null;
  plan_file: string | null;
  tasks: Task[];  // Array of {id, description, agent, wave, status, depends_on, ...}
  current_wave?: number;
  wave_gates: Record<string, WaveGate>;  // {impl_complete, tests_passed, reviews_complete}
  github_issue?: number;
  spec_check?: SpecCheck;
}
```

**Migration:** The state file path changes from `.claude/state/` to `.pi/state/` (or keep it project-agnostic). The StateManager TypeScript class can be reused directly — just update the path constants in `config.ts`.

Alternatively, use `pi.appendEntry()` to persist state in the session file itself, making it survive session switches. But the current file-based approach is simpler and works across subagent processes.

### Transcript Parsing (Critical for Loom)

Loom's engine parses Claude Code transcripts to extract:
- Test pass/fail evidence from bash output
- Files modified by subagents
- Phase artifacts (spec, plan paths)

The parsers in `engine/src/parsers/` assume Claude Code's JSONL format:

```typescript
// Claude Code format (parsers/types.ts)
interface TranscriptLine {
  message?: {
    role?: string;
    content?: string | ContentBlock[];  // tool_use, tool_result, text
  };
}
```

Pi's format is different (see [Section 9](#9-session-file-format-jsonl-transcript-parsing)):

```typescript
// Pi format
interface PiEntry {
  type: "message";
  id: string;
  parentId: string | null;
  message: {
    role: "user" | "assistant" | "toolResult";  // not tool_use/tool_result
    content: (TextContent | ToolCall)[];  // toolCall inline in assistant
  };
}
```

**Key adapter changes needed:**

1. **Tool calls** are `{ type: "toolCall", name, arguments }` inside assistant content (not `tool_use`)
2. **Tool results** are separate entries with `role: "toolResult"` (not `tool_result` content blocks)
3. **Tree structure** — must follow `parentId` chain, not just iterate lines
4. **Subagent transcripts** — pi subagents produce their own session files; the subagent tool result contains the final output but not the full transcript. For full transcript parsing, read the subagent's session file.

**Adapter pattern:**

```typescript
// Adapter: pi session → loom's expected format
function piSessionToTranscript(sessionPath: string): string {
  const lines = readFileSync(sessionPath, "utf8").trim().split("\n");
  const texts: string[] = [];
  
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type !== "message") continue;
    const msg = entry.message;
    
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") texts.push(block.text);
      }
    } else if (msg.role === "toolResult") {
      for (const block of msg.content) {
        if (block.type === "text") texts.push(block.text);
      }
    }
  }
  
  return texts.join("\n");
}
```

Or if running inside a pi extension, use `ctx.sessionManager` directly instead of parsing files.

### Migration Strategy for Loom

#### Dual-Client Architecture (Claude Code + Pi from one repo)

Most of loom is **pure business logic** that doesn't care which harness runs it. The handlers have a thin stdin/JSON parsing layer on top, but the core logic (phase validation, state management, task graph operations) is shared. Here's how to refactor for both clients:

**What's already shared (no changes needed):**
- `skills/` — Agent Skills standard works in both
- `rules/` — Just `.md` files agents `read`
- `references/` — Just `.md` files agents `read`
- `commands/` — Prompt/skill content (`.md` files)
- `agents/` — Agent definitions (frontmatter needs minor adaptation, see below)
- `engine/src/types.ts` — Pure types
- `engine/src/state-manager.ts` — File I/O with locking
- `engine/src/phase-init.ts` — State initialization
- `engine/src/utils/` — All utilities (git, lock, find-file, extract-task-id, strip-namespace)
- `engine/src/parsers/parse-bash-test-output.ts` — Test output detection
- `engine/src/parsers/parse-phase-artifacts.ts` — Phase artifact extraction
- `engine/src/handlers/helpers/` — All 11 helper handlers (pure business logic)
- `engine/tests/` — All tests

**What's Claude Code only (keep as-is):**
- `.claude-plugin/plugin.json`
- `hooks/hooks.json` + `hooks/scripts/*.sh`
- `engine/src/cli.ts` (bun CLI entry point)

**What's pi only (add new):**
- `package.json` with `pi` manifest
- `pi/extension.ts` (thin adapter)

**What needs a small refactor (extract core logic from handlers):**

The handlers currently look like this:
```typescript
// engine/src/handlers/pre-tool-use/block-direct-edits.ts
const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);  // <-- Claude-specific
  if (!FILE_TOOLS.has(input.tool_name)) return ...;   // <-- uses .tool_name
  // ... core logic ...
};
```

**Refactor: extract the core logic into a pure function, keep the stdin wrapper:**

```typescript
// engine/src/core/block-direct-edits.ts (NEW - shared)
export function shouldBlockDirectEdit(toolName: string, sessionId: string): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  if (!FILE_TOOLS.has(toolName)) return { kind: "allow" };
  // ... same logic ...
}

// engine/src/handlers/pre-tool-use/block-direct-edits.ts (Claude Code wrapper - unchanged)
const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);
  return shouldBlockDirectEdit(input.tool_name, input.session_id);
};

// pi/extension.ts (Pi wrapper - new)
pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
    const result = shouldBlockDirectEdit("Edit", sessionId);
    if (result.kind === "block") return { block: true, reason: result.message };
  }
});
```

The same pattern applies to all handlers. The input fields map like this:

| Claude Code (`PreToolUseInput`) | Pi (`tool_call` event) |
|---|---|
| `input.tool_name` ("Agent", "Edit", "Bash") | `event.toolName` ("subagent", "edit", "bash") |
| `input.tool_input.prompt` | `event.input.task` |
| `input.tool_input.subagent_type` | `event.input.agent` |
| `input.session_id` | `ctx.sessionManager.getSessionId()` |

| Claude Code (`SubagentStopInput`) | Pi (`tool_result` event) |
|---|---|
| `input.agent_type` | `event.details.results[0].agent` |
| `input.agent_transcript_path` | Subagent session file path |
| `input.session_id` | `ctx.sessionManager.getSessionId()` |

#### Proposed Repo Structure

```
loom/
├── .claude-plugin/             # Claude Code plugin manifest
│   └── plugin.json
├── package.json                # Pi package manifest (pi key) + shared deps
│
├── agents/                     # SHARED - agent definitions
│   ├── architecture-agent.md
│   ├── code-reviewer.md
│   └── ...21 agents
│
├── skills/                     # SHARED - Agent Skills standard
│   ├── loom/SKILL.md
│   ├── code-implementer/SKILL.md
│   └── ...
│
├── commands/                   # SHARED - slash commands / prompts
│   ├── loom.md
│   ├── clarify.md
│   └── templates/
│
├── rules/                      # SHARED - reference docs
├── references/                 # SHARED - templates
│
├── engine/                     # SHARED core + client wrappers
│   ├── src/
│   │   ├── core/               # NEW - pure business logic (no stdin)
│   │   │   ├── block-direct-edits.ts
│   │   │   ├── guard-state-file.ts
│   │   │   ├── validate-phase-order.ts
│   │   │   ├── validate-task-execution.ts
│   │   │   ├── validate-template-substitution.ts
│   │   │   ├── validate-agent-model.ts
│   │   │   ├── validate-agent-skill.ts
│   │   │   ├── dispatch-subagent-stop.ts
│   │   │   ├── on-session-start.ts
│   │   │   └── on-subagent-start.ts
│   │   ├── handlers/           # Claude Code stdin wrappers (call core/)
│   │   │   ├── pre-tool-use/
│   │   │   ├── subagent-stop/
│   │   │   ├── session-start/
│   │   │   ├── subagent-start/
│   │   │   └── helpers/        # Already pure, stays here
│   │   ├── parsers/
│   │   │   ├── types.ts        # Add pi transcript types alongside Claude types
│   │   │   ├── parse-transcript.ts        # Add pi adapter
│   │   │   └── parse-files-modified.ts    # Add pi adapter
│   │   ├── config.ts           # Make TASK_GRAPH_PATH configurable
│   │   ├── types.ts
│   │   ├── state-manager.ts
│   │   ├── phase-init.ts
│   │   ├── cli.ts              # Claude Code only
│   │   └── utils/
│   └── tests/
│
├── hooks/                      # CLAUDE CODE ONLY
│   ├── hooks.json
│   └── scripts/*.sh
│
└── pi/                         # PI ONLY
    └── extension.ts            # Pi extension (calls engine/src/core/)
```

#### The `engine/src/core/` Extraction

Each handler becomes a pure function that takes typed args and returns `HookResult`:

```typescript
// engine/src/core/validate-phase-order.ts
import type { Phase, HookResult } from "../types";
import { StateManager } from "../state-manager";
import { VALID_TRANSITIONS, UTILITY_AGENTS } from "../config";
import { stripNamespace } from "../utils/strip-namespace";

export interface ValidatePhaseOrderInput {
  toolName: string;       // "Agent" (Claude) or "subagent" (pi) — see SUBAGENT_SPAWN_TOOLS
  agentType: string;      // bare agent name
  prompt: string;         // task prompt
}

export function validatePhaseOrder(input: ValidatePhaseOrderInput): HookResult {
  // All the current logic, but no JSON.parse(stdin)
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  const bareAgent = stripNamespace(input.agentType);
  if (UTILITY_AGENTS.has(bareAgent)) return { kind: "allow" };
  const targetPhase = detectPhase(bareAgent, input.prompt);
  // ... rest of validation ...
}
```

The Claude Code handler stays as a thin wrapper:
```typescript
// engine/src/handlers/pre-tool-use/validate-phase-order.ts
import { validatePhaseOrder } from "../../core/validate-phase-order";
const handler: HookHandler = async (stdin) => {
  const input: PreToolUseInput = JSON.parse(stdin);
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };
  return validatePhaseOrder({
    toolName: input.tool_name,
    agentType: (input.tool_input?.subagent_type as string) ?? "",
    prompt: (input.tool_input?.prompt as string) ?? "",
  });
};
```

The pi extension calls the same core:
```typescript
// pi/extension.ts
import { validatePhaseOrder } from "../engine/src/core/validate-phase-order";
import { shouldBlockDirectEdit } from "../engine/src/core/block-direct-edits";
import { guardStateFile } from "../engine/src/core/guard-state-file";
// ... etc

pi.on("tool_call", async (event, ctx) => {
  // Subagent tool → phase validation
  if (event.toolName === "subagent" && event.input.agent) {
    const result = validatePhaseOrder({
      toolName: "subagent",
      agentType: event.input.agent,
      prompt: event.input.task ?? "",
    });
    if (result.kind === "block") return { block: true, reason: result.message };
  }

  // Edit/Write → block direct edits
  if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
    const result = shouldBlockDirectEdit("Edit", ctx.sessionManager.getSessionId());
    if (result.kind === "block") return { block: true, reason: result.message };
  }

  // Bash → guard state file
  if (isToolCallEventType("bash", event)) {
    const result = guardStateFile(event.input.command);
    if (result.kind === "block") return { block: true, reason: result.message };
  }
});
```

#### Making `config.ts` Client-Agnostic

The only path that differs is the state file location:

```typescript
// engine/src/config.ts
function detectHarness(): "claude" | "pi" {
  // Pi sets this, Claude Code doesn't
  if (process.env.PI_CODING_AGENT_DIR) return "pi";
  return "claude";
}

const TASK_GRAPH_RELATIVE = detectHarness() === "pi"
  ? ".pi/state/active_task_graph.json"
  : ".claude/state/active_task_graph.json";
```

Or simpler — just make it configurable:
```typescript
export const TASK_GRAPH_RELATIVE = process.env.LOOM_STATE_DIR
  ?? ".claude/state/active_task_graph.json";
```

#### Making Transcript Parsers Client-Agnostic

Add a format parameter:

```typescript
// engine/src/parsers/parse-transcript.ts
export function parseTranscript(content: string, format: "claude" | "pi" = "claude"): string {
  if (format === "pi") return parsePiTranscript(content);
  return parseClaudeTranscript(content);  // existing logic
}

function parsePiTranscript(content: string): string {
  const texts: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role === "assistant" || msg.role === "toolResult") {
        for (const block of msg.content) {
          if (block.type === "text") texts.push(block.text);
        }
      }
    } catch {}
  }
  return texts.join("\n");
}
```

#### Agent Frontmatter

Claude Code agents have `color:` and `skills:` (auto-preload). Pi agents have `tools:`. Both share `name`, `description`, `model`.

Simplest approach: **keep Claude Code frontmatter, handle the difference in pi's agent loader.** The pi subagent extension ignores unknown frontmatter fields, so `color:` and `skills:` are harmlessly ignored. For the `skills:` auto-preload, your pi extension can handle it:

```typescript
// In pi/extension.ts — custom agent loader that resolves skills: frontmatter
function loadAgent(agentPath: string): AgentConfig {
  const { frontmatter, body } = parseFrontmatter(readFileSync(agentPath, "utf-8"));
  let systemPrompt = body;

  // Resolve skills: frontmatter (Claude Code auto-preloads these)
  if (frontmatter.skills) {
    for (const skillName of frontmatter.skills) {
      const skillPath = join(PACKAGE_ROOT, "skills", skillName, "SKILL.md");
      if (existsSync(skillPath)) {
        systemPrompt += "\n\n" + readFileSync(skillPath, "utf-8");
      }
    }
  }

  return { ...frontmatter, systemPrompt };
}
```

#### Migration Phases (Revised for Dual-Client)

**Phase 1 — Add pi support without breaking Claude Code:**
1. Add `package.json` with `pi` manifest
2. Create `pi/extension.ts` that calls existing handler logic directly
3. Add `LOOM_STATE_DIR` env var support to `config.ts`
4. Works immediately for skills, prompts, rules, references

**Phase 2 — Extract `engine/src/core/` (pure functions):**
1. Extract core logic from each handler into `core/` functions
2. Thin Claude Code wrappers remain in `handlers/`
3. Pi extension calls `core/` directly
4. All existing tests still pass (test the core functions)

**Phase 3 — Transcript parser adapter:**
1. Add `format` parameter to parsers
2. Add pi JSONL parsing alongside Claude Code parsing
3. Test with pi subagent session output

**Phase 4 — Agent skill preloading:**
1. Custom agent loader in pi extension resolves `skills:` frontmatter
2. Agent `.md` files stay identical for both clients
