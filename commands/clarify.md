---
name: clarify
version: "1.0.0"
description: "This skill should be used when the user asks to 'clarify requirements', 'resolve uncertainties', 'answer spec questions', or when auto-triggered by /specify with >3 NEEDS CLARIFICATION markers. Systematically surfaces and resolves ambiguities in specifications."
argument-hint: "[path/to/spec.md]"
---

# Clarify - Systematic Uncertainty Resolution

Find the ambiguities in one specification and resolve them with the user, so that architecture starts from a spec with no open markers.

**Arguments:** "$ARGUMENTS"

**Triggers:** `/specify` invokes this when its spec has more than 3 `[NEEDS CLARIFICATION]` markers; `/clarify` reviews the current spec; `/clarify path/to/spec.md` reviews a named one. Inside `/loom` the clarify-agent preloads this skill, and its phase prompt governs wherever it sets a rule.

---

## Process

### 1. Pick the one spec

Use the path given as the argument or in your prompt. With no path, take the most recent spec and confirm it with the user before going on:

```bash
ls -t .claude/specs/*/spec.md | head -1
```

Everything below reads and counts that one file, called `$SPEC` here. Never count across several specs.

### 2. Extract the markers

```bash
grep -n "NEEDS CLARIFICATION" "$SPEC"
```

For each marker note the line, the requirement ID (FR-xxx, SC-xxx, …), the section and the question.

### 3. Scan for implicit ambiguities

| Pattern | Example | Issue |
|---------|---------|-------|
| Vague adjectives | "fast", "reliable", "user-friendly" | Not measurable |
| Undefined terms | "admin user", "valid input" | Domain-specific |
| Missing edge cases | Only the happy path is defined | Incomplete |
| Passive voice | "data is validated" | Who validates, and when? |
| Unbounded lists | "users can upload files" | Which types, what size limit? |

Add what you find to the question queue.

### 4. Sort each item

- **Business (WHAT):** a rule, threshold, scope boundary, edge case or user expectation. The user decides it. Ask.
- **Technical (HOW):** which database, sync or async, API design. Do not ask. Rewrite the marker as `[DEFERRED TO ARCHITECTURE: <the open question>]`.
- **Unanswerable for now:** rewrite it as `[DEFERRED: <what is open> until <what unblocks it>]`. A deferral always names what unblocks it.

A deferral replaces the marker text, so the literal `NEEDS CLARIFICATION` is gone from that line.

### 5. Order the questions

Score each business item `Impact × Uncertainty`: how much it affects architecture, data model, task breakdown or testing, and how unclear it is now. Ask in descending order. There is no limit on the number of questions; stop when the completion criterion below holds.

For coverage, think across: functional scope, data model, UX flows, performance, integration, edge cases, constraints, terminology and definition of done.

### 6. Ask

- Multiple choice (2-5 options) wherever possible; give each option's trade-off.
- An open-ended question asks for an answer of five words or fewer.
- Quote the spec line the question is about.
- Inside `/loom`, ask with `AskUserQuestion`. Standalone, ask one question per message.

```markdown
**Context:** FR-003 states "System MUST validate user input"

**Question:** What validation rules apply to email addresses?

A) RFC 5322 strict validation
B) Simple format check (contains @ and .)
C) Format check + DNS MX record verification
D) Custom business rules (please specify)

**Impact:** Affects error messages, test cases, and integration complexity.
```

Other shapes: a constrained open question ("Maximum file upload size? (≤5 words)"), or a binary with a follow-up ("Should inactive users be auto-deleted? A) Yes, after [duration]  B) No. If yes, what defines inactive?").

### 7. Apply each answer at once

After each answer, replace the marker in the spec with the resolved requirement, then log the decision in `clarifications/log.md` beside the spec.

Before:
```markdown
- FR-003: System MUST validate email [NEEDS CLARIFICATION: validation rules]
```

After:
```markdown
- FR-003: System MUST validate email format (RFC 5322) and verify domain has MX record
```

Log entry:
```markdown
## 2025-01-29: Email Validation Rules

**Question:** What validation rules apply to email addresses?
**Answer:** RFC 5322 + MX verification (Option C)
**Updated:** FR-003
**Rationale:** Balance strictness with user experience, catch typos in domain
```

Log deferrals the same way, with their unblock condition.

### 8. Report

```markdown
## Clarification Summary

| Category | Status |
|----------|--------|
| Functional scope | Resolved |
| Data model | Resolved |
| UX flows | Resolved |
| Performance | Clear |
| Integration | Deferred (vendor selection pending) |
| Edge cases | Resolved |

**Remaining `NEEDS CLARIFICATION` markers:** 0
**Deferred to architecture:** 2
**Ready for architecture:** Yes
```

---

## Completion criterion

The session is complete when both hold:

1. `grep -c "NEEDS CLARIFICATION" "$SPEC"` prints `0`: every marker is resolved or rewritten as a deferral. Inside `/loom` the engine counts the same literal string and will not advance to architecture while one remains.
2. No implicit ambiguity is left in a P1 scenario.

## Output

- The spec, with markers replaced by answers or deferrals
- `clarifications/log.md` beside it, with the decision history

Commit the result:

```bash
git add .claude/specs/{slug}/
git commit -m "clarify: resolve {N} uncertainties in {slug}"
```
