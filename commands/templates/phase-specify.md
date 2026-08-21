# Specify Phase Context

Template for spawning specify-agent. All template variables must be substituted before use.

---

## CRITICAL: You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write — scoped to this phase's artifact directory** (`.claude/specs/{date_slug}/` or `.claude/plans/`); write only there.
- You MUST use Write/Edit tools to create the spec file — this WILL work
- Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you
- Do NOT check if you are "allowed" to write — you are. Just write.

---

## CRITICAL: Interview the User BEFORE Writing

**Do NOT write the spec on the first pass.** The user wants to be involved in shaping the spec, not just approving it at the end.

You will:
1. Read brainstorm.md to understand what's already settled.
2. **Ask ALL the interview questions** listed below to lock down every aspect of the spec. In Claude Code, use `AskUserQuestion`; in Pi subagents, output a `QUESTIONS_REQUIRED` block and stop so the main session can ask the user, then resume with answers.
3. Only THEN write the spec, informed by both brainstorm and the interview.

If brainstorm.md gives a **confident, explicit, unambiguous** answer to a question, you may skip that specific question. When in doubt, ask. Do not skip questions just to be efficient — the user wants depth, not speed.

When an interactive question tool is available, batch up to 4 related questions per call. In Pi, group the same batches under `QUESTIONS_REQUIRED`.

---

## Specify: {feature_description}

**Brainstorm output:** Read `.claude/specs/{date_slug}/brainstorm.md` for selected approach, constraints, and scope.

**Output location:** `.claude/specs/{date_slug}/spec.md`

---

## Process

### 1. Read Brainstorm + Establish Baseline

Read `.claude/specs/{date_slug}/brainstorm.md` end-to-end. List in your head:
- What's already locked (approach, in/out of scope, key constraints)
- What's still vague or missing (priorities, success metrics, edge cases, acceptance bar)

### 2. Interview the User — Ask ALL Questions

Use multiple-choice options where possible. Batch across multiple calls/blocks (4 questions per batch max). **Cover every topic below** — skip a specific question only if brainstorm.md already gives a confident, explicit answer for it.

**Required interview topics:**

1. **Scenario priorities** — Present brainstorm's in-scope items, ask user to assign P1 (blocks everything), P2 (significant value), P3 (nice-to-have) to each.
2. **Scope boundary check** — Surface anything you suspect might be ambiguously in/out of scope. Get an explicit ruling on each.
3. **Measurable success criteria** — Ask for concrete numbers: latency targets, error rates, completion times, accuracy thresholds, throughput. Vague answers ("fast", "reliable") fail the spec quality check — push for numbers.
4. **Acceptance bar for each P1 scenario** — For every P1, what's the minimum behavior that counts as "works"? Cover happy path, edge cases, error states, retries, idempotency.
5. **Sensitive failure modes** — Which failure modes must be handled explicitly vs. left as `[NEEDS CLARIFICATION]`? (timeouts, partial failures, concurrent edits, network loss, etc.)
6. **User-visible error states** — What should users see/experience when things fail? Error UX is often under-specified.
7. **Data/state lifecycle** — Creation, update, deletion, expiration, retention policies for any data the feature touches.
8. **Permissions & access** — Who can do what? Are there role-based restrictions, ownership rules, audit requirements?
9. **External dependencies & integration points** — What external systems/services does this feature interact with from a user-facing perspective? (Not implementation — just what shows up in scenarios.)
10. **Out-of-scope clarifications** — Items the user wants to **explicitly exclude** so they don't get pulled in during implementation.

Prefer multiple-choice or short-list options over open-ended. Group related topics into single question batches when natural (e.g., priorities + scope often fit in one batch).

**Do NOT ask about implementation** (tech stack, APIs, DB schema, frameworks, libraries) — those are architecture's job. If a question keeps drifting toward HOW, drop it and let the spec mark `[NEEDS CLARIFICATION: technical approach TBD]`.

### 3. Write the Spec

After the interview, write `.claude/specs/{date_slug}/spec.md` in one pass, incorporating both brainstorm context and interview answers. Follow the format from the preloaded `specify` skill (User Scenarios → Functional Requirements → Success Criteria → Out of Scope).

### 4. Present Summary

After writing, give a 5-bullet summary:
- Path to spec file
- Count of `[NEEDS CLARIFICATION]` markers
- Top 3 functional requirements
- Key acceptance bars decided in the interview
- Anything you deliberately left as a marker (and why)

---

## What NOT to Do

- Do NOT write the spec first and ask questions after. Interview FIRST.
- Do NOT skip interview topics for speed. The user explicitly wants the full questionnaire.
- Do NOT ask HOW questions (tech stack, API shape, schemas) — those belong in architecture.
- Do NOT write implementation hints into the spec.
- Do NOT accept "fast", "reliable", "easy to use" as success criteria — push for numbers.

---

The specify-agent has the `specify` skill preloaded which defines the spec format and content rules.
