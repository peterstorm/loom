# Brainstorm Summary

**Building:** A platform-agnostic PostEdit linter that guards against bad code patterns immediately after edits, with a two-tier architecture (fast regex gate + full wave-gate suite). The core rule engine is shared; only the hook/trigger mechanism differs between Claude Code (PostToolUse shell shim) and Pi (extension event API).

**Approach:** Two-Tier Platform-Agnostic Engine — A shared TypeScript rule engine (rule loading, execution, result formatting) with thin platform adapters. Immediate tier runs declarative regex rules on the edited file; wave-gate tier runs the full programmatic rule suite. Violations always block (reject the edit, agent must fix).

**Key Constraints:**
- Platform-agnostic core: rule engine + rules work identically in Claude Code AND Pi
- Claude Code adapter: PostToolUse hook in hooks.json → shell shim → `bun` CLI entry
- Pi adapter: Extension using pi's tool_result event API → same core engine
- Always-block violation behavior — no warnings, no soft passes
- Scoped to the single file being edited, matched by file extension
- Hot-reload free: bun's import model means rule changes take effect without restart
- Rules are both declarative (JSON regex patterns) and programmatic (TypeScript functions)
- TypeScript and Java file support

**In Scope:**
- Shared rule engine (load rules, match file extension, execute rules, format violations)
- Declarative rule format (JSON with regex patterns, per-language)
- Programmatic rule format (TypeScript functions receiving file content + AST-light info)
- Claude Code PostToolUse hook adapter (shell shim + bun CLI)
- Pi extension adapter (event-driven, same engine)
- Two-tier execution: immediate (fast regex) + wave gate (full suite)
- Violation output format consumable by both platforms (structured JSON)
- File-extension-based rule scoping (.ts/.tsx → TS rules, .java → Java rules)

**Out of Scope:**
- Project-wide / multi-file analysis
- AST parsing (keep rules regex/text-based for speed; programmatic rules get raw content)
- Auto-fix / code modification (agent handles the fix)
- UI/dashboard for rule management
- Rule severity levels (everything is block)
- Integration with external linters (ESLint, Checkstyle) — this is its own engine
- CI/CD integration

**Open Questions:**
- What's the exact Pi extension event API for intercepting tool results? (needs docs review during specify)
- Should the wave-gate tier run asynchronously or block the next edit until complete?
- Where do rule definition files live — in the loom repo, or in each target project's `.claude/` dir?
- Should there be a `--dry-run` mode for rule development/testing?
