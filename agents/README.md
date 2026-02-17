# Loom Plugin Agents

Agents spawned by loom orchestration (`/loom`, `/review-pr`, `/wave-gate`).

## Shared agents (duplicated in dotfiles)

These agents exist in both this directory and `~/.dotfiles/claude/` because
symlinks are not supported by the plugin cache. Changes must be synced manually.

**From `~/.dotfiles/claude/project/meta/agents/`:**

| Agent | Purpose |
|-------|---------|
| `architecture-tech-lead.md` | FC/IS adherence, coupling, testability |
| `code-reviewer.md` | General code quality, CLAUDE.md compliance |
| `code-simplifier.md` | Clarity and FP pattern polish |
| `comment-analyzer.md` | Comment accuracy and documentation rot |
| `dotfiles-agent.md` | Dotfiles/NixOS configuration |
| `pr-test-analyzer.md` | Test coverage quality and completeness |
| `security-agent.md` | Auth, JWT, OWASP, vulnerability assessment |
| `silent-failure-hunter.md` | Error handling, Either patterns, silent failures |
| `skill-content-reviewer.md` | Skill/command file quality review |
| `type-design-analyzer.md` | Type invariants, sealed types, encapsulation |

**From `~/.dotfiles/claude/project/typescript/agents/`:**

| Agent | Purpose |
|-------|---------|
| `frontend-agent.md` | Next.js frontend, React Server Components |
| `test-engineer.md` | TypeScript test engineering |
| `ts-test-agent.md` | Vitest, React Testing Library, Playwright |

When editing a shared agent, update both copies and verify with:

```bash
diff loom/agents/<name>.md ~/.dotfiles/claude/project/<path>/agents/<name>.md
```

## Loom-only agents

These agents are specific to loom orchestration and do not exist in dotfiles:

| Agent | Purpose |
|-------|---------|
| `architecture-agent.md` | Architecture design (preloads `architecture-tech-lead` skill) |
| `brainstorm-agent.md` | Exploration and ideation |
| `clarify-agent.md` | Uncertainty resolution |
| `code-implementer-agent.md` | Java/Spring Boot or TS/Next.js implementation |
| `decompose-agent.md` | Task graph decomposition |
| `spec-check-invoker.md` | Wave-gate spec alignment (preloads `spec-check` skill) |
| `specify-agent.md` | Formal requirements specification |

## Skill preloading pattern

Agents that need a skill declare it in YAML frontmatter:

```yaml
skills:
  - my-skill-name
```

The plugin system injects the skill content into the agent's context at spawn
time. The agent body should reference the skill as "preloaded" and must NOT
call `Skill()` at runtime (the Skill tool registry is not available to subagents).
