# Plan Alignment Phase Context

Template for spawning plan-alignment-agent. All template variables must be substituted before use.

---

## CRITICAL: You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write.**
- You MUST use Write/Edit tools to create the gap report file — this WILL work
- Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you
- Do NOT check if you are "allowed" to write — you are. Just write.

---

## Plan Alignment: {spec_file_path}

Compare the architecture plan against the specification and produce a gap report.

**Spec:** {spec_file_path}
**Plan:** {plan_file_path}
**Output:** {spec_dir}/plan-alignment.md

---

## Process

### 1. Read the Specification

- Read `{spec_file_path}` in full
- Extract every numbered requirement: `FR-xxx`, `SC-xxx`, `US-xxx` (or `US x`)
- Note out-of-scope items — do NOT flag gaps for out-of-scope items

### 2. Read the Architecture Plan

- Read `{plan_file_path}` in full
- Understand what components are designed, how data flows, what files are created

### 3. Match Requirements to Plan Coverage

For each requirement from the spec, determine if the plan addresses it **by meaning** (semantic match, not literal text).

A requirement is **covered** if the plan's design would implement or satisfy it.
A requirement is **a gap** if the plan does not address it, or addresses it so vaguely that an implementer would not know how to proceed.

### 4. Write Gap Report

Write to: `{spec_dir}/plan-alignment.md`

The report MUST always be written — even when no gaps are found.

**Required format:**

```markdown
# Plan Alignment Report

**Spec:** {spec_file_path}
**Plan:** {plan_file_path}
**Date:** (today's date)

## Summary

(N gaps found.) OR (No gaps found.)

## Gaps

- **FR-xxx** — (requirement description): (why it is not addressed)
- **SC-xxx** — (requirement description): (what is missing)

(Write "None." if no gaps)

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| FR-001 | ... | Covered |
| FR-003 | ... | Gap |
...
```

**Constraints:**
- ALWAYS write the file — never skip, even for no-gap runs
- When no gaps: Summary = "No gaps found." and Gaps section = "None."
- Flat list — no severity grouping
- Do NOT modify `{spec_file_path}` or `{plan_file_path}`

### 5. Report Completion

After writing the file, output:
- Path to the gap report: `{spec_dir}/plan-alignment.md`
- Total requirements checked
- Total gaps found
- Gap IDs (if any)

The plan-alignment-agent has tools: Read, Glob, Grep, Write, Edit. Use them to read files and write the report.
