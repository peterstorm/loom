---
name: specify
version: "1.0.0"
description: "This skill should be used when the user asks to 'specify a feature', 'write requirements', 'define what we're building', 'capture requirements', 'document the spec', or before invoking the architecture-tech-lead skill (`/skill:architecture-tech-lead` in Pi) for non-trivial features. Produces formal specifications (WHAT/WHY) that feed into architecture and planning phases."
argument-hint: "[$feature description] [--update] [--status]"
---

# Specify - Requirements Before Design

Formalize requirements into structured specifications before architecture/planning. Focus exclusively on WHAT and WHY - never HOW.

**Position in flow:** `/brainstorming` → `/specify` → `/clarify` (auto) → architecture-tech-lead skill (`/skill:architecture-tech-lead` in Pi) → `/loom`

**Arguments:** "$ARGUMENTS"

---

## Package resources

Resolve this command's owning package once. Claude Code expands the token in
source; Loom's Pi adapter renders it from the extension module's `import.meta.url`:

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/references/spec-template.md" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR"; exit 1; }
```

Never infer package identity from cwd or scan another harness's cache.

## Arguments

- `/specify "feature description"` - Create new specification
- `/specify --update` - Update existing spec with new info
- `/specify --status` - Show spec completeness

---

## Output

Creates `.claude/specs/{YYYY-MM-DD}-{slug}/spec.md`

Structure:
```
.claude/specs/2025-01-29-user-auth/
├── spec.md          # Main specification
└── clarifications/  # Resolved uncertainty log (created by /clarify)
```

---

## Specification Process

### 1. Extract Short Name

From description, derive 2-4 word slug:
- Action-noun format: `user-auth`, `email-validation`, `payment-flow`
- Preserve technical terms
- Lowercase, hyphenated

### 2. Explore Context

Before writing spec:
- Check existing specs: `ls .claude/specs/`
- Review related code areas
- Understand current state

### 3. Write Specification

Read `$LOOM_DIR/references/spec-template.md` from the package resolved above and populate its sections.

**Critical constraint:** Spec describes WHAT users need and WHY. NO implementation details:
- No tech stack mentions
- No API designs
- No database schemas
- No framework references
- No code patterns

If tempted to write HOW, mark as `[NEEDS CLARIFICATION: technical approach TBD]` and move on.

### 4. Mark Uncertainties

For ANY ambiguity, use marker syntax:

```markdown
- FR-003: System MUST validate user input [NEEDS CLARIFICATION: validation rules undefined]
```

Categories of uncertainty:
- **Business logic** - rules, thresholds, behaviors
- **Scope boundaries** - what's in/out
- **Edge cases** - error states, limits
- **Technical** - feasibility questions (arch-lead resolves these)
- **User expectations** - unclear acceptance criteria

### 5. Auto-Trigger Clarify

After writing spec, count markers:

```bash
# At least one spec must exist before counting; a missing spec is fatal, not a zero count.
ls .claude/specs/*/spec.md >/dev/null 2>&1 || { echo "FATAL: no spec found under .claude/specs/ — run /specify first"; exit 1; }
# grep -c prints one count per spec.md file (per-file, not a total) — including
# specs with zero markers. It exits 1
# when no spec has any markers (a good state for the spec) and 2 on a real error
# (an unreadable or vanished spec) — only the good state is masked, so a real
# I/O failure aborts set -e shells with grep's stderr visible.
grep -c "NEEDS CLARIFICATION" .claude/specs/*/spec.md || [ $? -eq 1 ]
```

If count > 3: Invoke `/clarify` before proceeding.

If count <= 3: Note markers for arch-lead to address during research phase.

---

## Spec Template Reference

See `{LOOM_DIR}/references/spec-template.md` for full template. Key sections:

### User Scenarios (Required)

```markdown
## User Scenarios

### US1: [P1] Account Creation
**As a** new user
**I want to** create an account with email
**So that** I can access personalized features

**Why P1:** Core functionality, blocks all other features

**Acceptance Scenarios:**
- AS-001: Given valid email and password, When I submit, Then account is created and confirmation sent
- AS-002: Given existing email, When I submit, Then error shown with login link
- AS-003: Given weak password, When I submit, Then requirements shown inline
```

Every acceptance scenario must have one unique canonical `AS-NNN:` ID across the specification.

Priority levels:
- **P1** - Must have, blocks other work
- **P2** - Should have, significant value
- **P3** - Nice to have, defer if needed

### Functional Requirements (Required)

```markdown
## Functional Requirements

- FR-001: System MUST allow email/password registration
- FR-002: System MUST send confirmation email within 60 seconds
- FR-003: System MUST enforce password policy [NEEDS CLARIFICATION: policy rules]
- FR-004: System SHOULD support OAuth providers [NEEDS CLARIFICATION: which providers?]
```

Use MUST/SHOULD/MAY (RFC 2119):
- **MUST** - Absolute requirement
- **SHOULD** - Strong recommendation, exceptions need justification
- **MAY** - Optional, nice-to-have

### Success Criteria (Required)

```markdown
## Success Criteria

- SC-001: 95% of registrations complete without error
- SC-002: Confirmation emails delivered within 60 seconds (p95)
- SC-003: Password validation feedback in <100ms
- SC-004: Zero accounts created with invalid email format
```

Criteria MUST be:
- **Measurable** - specific numbers, not "fast" or "reliable"
- **Verifiable** - can write test/metric for it
- **Technology-agnostic** - no "Redis cache hit rate"

### Out of Scope (Required)

Every exclusion must have one unique canonical `OOS-NNN:` ID.

```markdown
## Out of Scope

Explicitly NOT part of this feature:
- OOS-001: Social login (separate spec)
- OOS-002: Account deletion (future work)
- OOS-003: Profile editing (separate spec)
- OOS-004: Admin user management
```

Prevents scope creep during implementation.

### Appendix: Glossary (Required)

```markdown
## Appendix: Glossary

| Term | Definition |
|------|------------|
| {domain term} | {meaning in this context} |
```

Every glossary row must have exactly two non-empty cells, and every term must be unique (case-insensitive). Data rows whose term is the reserved header term `Term` fail the structural parse (the canonical header is table furniture, not data).

---

## Quality Checks

Before finalizing spec, verify:

| Check | Criteria |
|-------|----------|
| No HOW | Zero tech stack, API, or implementation mentions |
| Testable | Every FR has clear pass/fail condition |
| Measurable | Every SC has specific metric |
| Scoped | Out of Scope section populated |
| Glossary | Appendix: Glossary populated with non-empty, unique term/definition rows |
| Prioritized | All user scenarios have P1/P2/P3 |
| Uncertain marked | Ambiguities use `[NEEDS CLARIFICATION]` |

---

## Handoff to Architecture

When spec is ready (markers <= 3 or clarified):

1. Commit spec: `git add .claude/specs/ && git commit -m "spec: {slug}"`
2. Invoke arch-lead: `/architecture-tech-lead`
3. Arch-lead reads spec, produces plan with technical decisions

Arch-lead resolves technical uncertainties during research phase.

---

## Constraints

- NEVER include implementation details
- NEVER skip User Scenarios section
- NEVER use vague success criteria ("fast", "reliable")
- ALWAYS mark uncertainties explicitly
- ALWAYS include Out of Scope section
- Auto-trigger /clarify if >3 markers
