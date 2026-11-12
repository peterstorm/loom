# Specify Phase Context

Template for spawning specify-agent. All template variables must be substituted before use.

---

## Specify: {feature_description}

**Brainstorm output:** `.claude/specs/{date_slug}/brainstorm.md` (selected approach, constraints, scope)

**Output location:** `.claude/specs/{date_slug}/spec.md`

You are running inside `/loom` (Phase 1). You may write with Write/Edit under `.claude/specs/{date_slug}/`. Loom's hooks allow this; do not read `.claude/hooks/` or `.claude/state/` to check.

Interview the user before you write: the spec is written once, after the interview, from the brainstorm and the answers together.

---

## Process

### 1. Read the brainstorm

Read `.claude/specs/{date_slug}/brainstorm.md` end to end. Note what is settled (approach, scope, constraints) and what is still vague or missing (priorities, success metrics, edge cases, acceptance bar).

### 2. Interview the user

Ask with `AskUserQuestion`, up to 4 related questions per call, multiple choice or short lists where possible. Under Pi, Loom relays the tool to the parent TUI while this Agent turn stays alive. Ask every topic; skip one only when brainstorm.md answers it explicitly.

1. **Scenario priorities.** Present the brainstorm's in-scope items and have the user assign each P1 (blocks everything), P2 (significant value) or P3 (nice to have).
2. **Scope boundary check.** Surface anything that might be ambiguously in or out of scope and get a ruling on each.
3. **Measurable success criteria.** Ask for numbers: latency targets, error rates, completion times, accuracy thresholds, throughput. "Fast" and "reliable" fail the spec quality check.
4. **Acceptance bar for each P1 scenario.** The minimum behavior that counts as working: happy path, edge cases, error states, retries, idempotency.
5. **Sensitive failure modes.** Which must be handled explicitly and which stay `[NEEDS CLARIFICATION]` (timeouts, partial failures, concurrent edits, network loss).
6. **User-visible error states.** What users see when things fail.
7. **Data and state lifecycle.** Creation, update, deletion, expiration and retention for any data the feature touches.
8. **Permissions and access.** Who can do what: roles, ownership rules, audit requirements.
9. **External dependencies and integration points.** The external systems the feature touches as they appear in user scenarios, not their implementation.
10. **Out-of-scope clarifications.** What the user wants explicitly excluded.

Do not ask about implementation (tech stack, APIs, database schema, frameworks, libraries); that is the architecture phase's job. If a question keeps drifting toward HOW, drop it and let the spec carry `[NEEDS CLARIFICATION: technical approach TBD]`.

### 3. Write the spec

Write `.claude/specs/{date_slug}/spec.md` in one pass. The format and content rules are the preloaded `specify` skill's (which reads `references/spec-template.md`). Put no implementation hints in it.

### 4. Present a summary

- Path to the spec file
- Count of `[NEEDS CLARIFICATION]` markers
- Top 3 functional requirements
- Key acceptance bars decided in the interview
- Anything deliberately left as a marker, and why
