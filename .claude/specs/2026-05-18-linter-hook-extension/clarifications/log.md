# Clarification Log — PostEdit Linter Hook Extension

## Session: 2026-05-18

### Q1: Pi Extension Event API Shape

**Question:** What is the exact event name and payload structure for intercepting tool results in Pi's extension system?

**Options Considered:**
1. `pi.on("tool_result", handler)` — inject error into result with `isError: true`
2. Separate `postEdit` event with blocking semantics
3. Middleware pattern wrapping tool execution

**User Answer:** Option 1 — Accept "inject error into result." User said: "I just want it to be flagged after a write, so the agent can fix it immediately. So pick the simplest most correct one."

**Decision:** Pi adapter uses `pi.on("tool_result", handler)` for edit/write tools. After the edit lands on disk, the handler reads the file, runs lint rules, and if violations exist, returns `{ content: [violation message], isError: true }` so the LLM sees the error and fixes immediately. The file is temporarily in a violated state until the agent's next edit — this is acceptable.

**Impact:** Resolves US6 acceptance scenario and FR-018 implementation approach. Simplest possible integration — no blocking, no rollback, just error injection.

**Rationale:** Simplicity wins. The file being temporarily violated is acceptable because the agent will fix it in its very next turn. No complex blocking or rollback machinery needed.

---

## Coverage Summary

| Category | Resolved | Deferred | Outstanding |
|----------|----------|----------|-------------|
| Platform Integration | 1 | 0 | 0 |
| Rule Engine | 0 | 0 | 0 |
| Execution Model | 0 | 0 | 0 |
| **Total** | **1** | **0** | **0** |
