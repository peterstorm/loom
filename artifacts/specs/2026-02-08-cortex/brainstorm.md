# Brainstorm Summary

**Building:** Cortex — persistent memory plugin for Claude Code that automatically captures knowledge from sessions, surfaces relevant context at session start via push surface, and provides semantic recall mid-session. Key differentiator: code-aware memory via prose-code pairing.

**Approach:** Push surface optimization with automatic extraction. Stop hook silently extracts memories via Haiku, generates branch-aware ranked surface (300-500 tokens), served instantly at next session start. Skills supplement but push surface is primary workflow.

**Key Constraints:**
- Native Claude Code plugin (hooks + skills, no MCP server)
- TypeScript/bun engine, functional core/imperative shell architecture
- 90%+ unit testable without mocks
- SQLite dual-DB (per-project + global) with better-sqlite3
- Voyage AI embeddings (primary), @huggingface/transformers fallback
- Silent background extraction — errors never block session end
- Budget: 300-500 tokens push surface, 6-8 categories with soft caps

**In Scope:**
- Stop hook: automatic extraction from transcript via Haiku API
- Start hook: load cached push surface + staleness warning
- Dual representation: prose summaries (embedded) + raw code blocks (linked via edges)
- Automatic scope classification: >0.8 confidence → global DB, else project DB
- Branch-aware surface caching: (branch, cwd) → ranked memories
- Ranking formula: confidence × priority × centrality × access frequency
- Per-category line budgets with redistribution
- Full skill suite: /recall, /remember, /forget, /index-code, /consolidate, /inspect
- Fail-safe telemetry: structured status.json, /inspect shows extraction health
- Core library (pure functions) + thin CLI (cortex subcommands)

**Out of Scope:**
- MCP server architecture
- Symbol-level code parsing (just file/line tracking)
- Manual promotion to global DB (/promote skill)
- Graph visualization UI
- Real-time extraction during session
- Consolidation automation (manual /consolidate only in v1)
- Multi-user/team features

**Open Questions:**
- None — major design decisions resolved in unified brief, scope validated through clarification process.
