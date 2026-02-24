# Specify Phase Context

Template for spawning specify-agent. All template variables must be substituted before use.

---

## CRITICAL: You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write.**
- You MUST use Write/Edit tools to create the spec file — this WILL work
- Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you
- Do NOT check if you are "allowed" to write — you are. Just write.
- If you waste time reading hook files instead of writing the spec, you have failed your task

---

## Specify: {feature_description}

**Brainstorm output:** Read `.claude/specs/{date_slug}/brainstorm.md` for the brainstorm summary (approach, constraints, scope).

Create formal specification for this feature.

**Output location:** `.claude/specs/{date_slug}/spec.md`

**Your output must include:**
- Path to created spec file
- Count of `[NEEDS CLARIFICATION]` markers
- Summary of key requirements (FR-xxx list)

The specify-agent has the `specify` skill preloaded which defines the spec format and process.
