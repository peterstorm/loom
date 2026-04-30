# Architecture Phase Context

Template for spawning architecture-agent. All template variables must be substituted before use.

---

## Architecture: {feature_description}

**Spec:** {spec_file_path}

**IMPORTANT: You are designing architecture from a specification, not reviewing existing code.**
You are running inside `/loom`. Your plan feeds into the decompose phase, which parses it into a parallel task graph for implementation agents. Plan structure matters.

## CRITICAL: You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write.**
- You MUST use Write/Edit tools to create the plan file — this WILL work
- Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you
- Do NOT check if you are "allowed" to write — you are. Just write.

---

## Process

### 1. Read the Specification

- Read `{spec_file_path}` thoroughly
- Understand user scenarios (US), functional requirements (FR), success criteria (SC)
- Note out-of-scope items — don't design for them
- Note `[NEEDS CLARIFICATION]` markers — design around known unknowns

### 2. Explore Existing Codebase

- Identify existing patterns, conventions, file structure
- Find code to reuse or extend (don't reinvent)
- Understand the tech stack in use
- Note architectural constraints from existing code

### 3. Evaluate Approaches

For significant decisions, present 2-3 options with trade-offs. Recommend optimal approach with justification.

Apply your preloaded architecture knowledge:
- FP principles (pure functions, immutability, push I/O to edges)
- DDD (domain modeling, bounded contexts)
- Testability (functional core / imperative shell)
- Stack-specific patterns (Java records/sealed types/Either OR TypeScript discriminated unions/ts-pattern)

### 4. Design the Architecture

- Define component boundaries and responsibilities
- Design data flow between components
- Specify complete file structure (files to create/modify)
- Order implementation into dependency-based phases
- Consider security, performance, testability per component

### 5. Write the Plan Document

**Output location:** `.claude/plans/{date_slug}.md`

Find the loom plugin directory (`ls -d "$HOME/.claude/plugins/cache/plugins/loom"/*/` — use latest), then read `references/plan-template.md` from it and follow its structure.

**Required sections** (decompose agent parses these):

| Plan Section | What Decompose Extracts |
|---|---|
| **File Structure** | `file_list` per task |
| **Component Design** | Task `description` + boundary definitions |
| **Implementation Phases** | `wave` ordering + `depends_on` |
| **Architectural Decisions** | `plan_context` quoted to impl agents |
| **Testing Strategy** | `new_tests_required` per component |

Commit: `git add .claude/plans/ && git commit -m "plan: {date_slug}"`

### 6. Emit Architecture Decision Records (ADRs)

For each significant decision made in this design, write an ADR to `docs/adr/`.

**Trigger an ADR when ANY of the following:**
- You evaluated 2+ alternatives in Step 3 and chose one (record the tradeoff)
- The design introduces a new dependency, framework, or runtime
- The design changes the data model (new tables, schema changes)
- The design establishes a cross-cutting pattern (error model, logging, auth, retention)
- The design locks in a non-obvious constraint or invariant

**Skip ADRs for:**
- Trivial naming or file-placement choices
- Decisions fully determined by existing patterns

**Filename:** `docs/adr/{NNNN}-{slug}.md` where:
- `{NNNN}` = max existing ADR number + 1, zero-padded to 4 digits. Find via:
  ```bash
  ls docs/adr/ 2>/dev/null | grep -oE '^[0-9]{4}' | sort -n | tail -1
  ```
  If no ADRs exist yet, start at `0001`.
- `{slug}` = kebab-case topic (e.g., `eval-framework`).

**Structure:** Find the loom plugin directory (same approach as Step 5), then read `references/adr-template.md` and follow it exactly. Substitute all `{...}` placeholders. Status defaults to `Accepted`.

**Numbering across multiple ADRs in this run:** When emitting N ADRs, allocate consecutive numbers — do NOT re-scan between writes.

**Plan-alignment loop-back:** If re-running architecture with gap context, edit existing ADRs in place for changed decisions; create new ones for surfaced decisions; do not duplicate unchanged ADRs.

**Commit:** Single commit for the batch:
```bash
git add docs/adr/ && git commit -m "adr: add ADRs for {date_slug}"
```

---

## What NOT to Do

- Don't use the review process from your skill (no "Identify Testability Barriers" — there's no code to review yet)
- Don't produce review-format output (no "Issue/Impact/Root Cause" analysis)
- Don't write implementation code (that's impl agents' job)
- Don't design beyond spec scope (check Out of Scope section)

---

## Your Output Must Include

- Path to created plan file
- Implementation phases identified (count + names)
- Key architectural decisions with rationale
- List of ADRs emitted (paths) — empty list is fine if no decisions met the trigger criteria

The architecture-agent has the `architecture-tech-lead` skill preloaded which provides FP, DDD, testability, and stack-specific domain knowledge. Use that knowledge to **design**, not to **review**.
