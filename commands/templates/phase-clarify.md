# Clarify Phase Context

Template for spawning clarify-agent. Variables in `{braces}` must be substituted.

---

## CRITICAL: You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write.**
- You MUST use Write/Edit tools to update the spec file — this WILL work
- Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you
- Do NOT check if you are "allowed" to write — you are. Just write.

---

## CRITICAL: You MUST Ask the User

**Every `[NEEDS CLARIFICATION]` marker requires a user decision.** You are NOT allowed to resolve markers on your own or accept pre-resolved answers from the orchestrator.

- Use `AskUserQuestion` tool for each marker (batch related ones, max 4 questions per call)
- Present multiple-choice options with clear trade-offs
- Only update the spec AFTER receiving user answers
- Technical uncertainties (HOW not WHAT) should be flagged for architecture phase, not asked here

---

## Clarify: {spec_file_path}

Resolve uncertainties in the specification.

**Marker count:** {marker_count} `[NEEDS CLARIFICATION]` markers found

**Your output must include:**
- Updated spec.md with markers resolved
- Remaining marker count
- Summary of decisions made

The clarify-agent has the `clarify` skill preloaded which guides the questioning process.
