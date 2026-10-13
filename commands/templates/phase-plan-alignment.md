# Plan Alignment Phase Context

Template for spawning plan-alignment-agent. All template variables must be substituted before use.

---

## CRITICAL: You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write — scoped to this phase's artifact directory** (`.claude/specs/{date_slug}/` or `.claude/plans/`); write only there.
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

### 2.5 Read Every Supporting Document

- List `{spec_dir}` and read every supporting document in it other than the spec and this report: `feasibility.md`, research notes, probe records, interview digests, ADR drafts
- From each, extract the recorded **discoveries**: measured or observed facts about the harness, providers, libraries, or existing code that constrain what can be built (e.g. "the harness retries an invalid tool call inside the child", "provider X ignores `strict`")
- If `{spec_dir}` holds no supporting documents, say so in the report and skip step 3.6

### 3. Match Requirements to Plan Coverage

For each requirement from the spec, determine if the plan addresses it **by meaning** (semantic match, not literal text).

A requirement is **covered** if the plan's design would implement or satisfy it.
A requirement is **a gap** if the plan does not address it, or addresses it so vaguely that an implementer would not know how to proceed.

### 3.5 Check the Executable-Models Policy

Loom's standing policy: a model either executes or it doesn't exist (documented in the loom plugin's `references/executable-models.md`; the criteria below are self-contained — you do not need to read it). Flag as a gap (ID `MODEL-N`):

- The plan describes a domain **lifecycle** in prose (state lists, transition narratives) WITHOUT a `## Lifecycles` section binding it to a `**Machine file:**`
- The plan describes a multi-stage **pipeline** WITHOUT either a `## Pipeline` AuthoredDag binding or an explicit statement that the fugue bridge was declined
- An `## Invariants` entry tiered `checkable` whose stated property a regex lint rule could not actually check (mis-tiered — should be `advisory`)
- A `## Contracts` entry whose `**Types file:**` is an existing or implementation file rather than a new declarations-only file, or whose `**Acceptance tests:**` list a Requirement no test can decide (a measured or calibration Requirement)

Do NOT flag the mere absence of these sections — they are opt-in; most features need none.

Then check invariant ownership. Flag as a gap (ID `OWN-N`):

- The plan describes one rule applied at two or more sites (the same check, guard, parse or policy in several modules) with no `## Invariants` entry that owns it
- An owned invariant's `**Sibling entry points:**` list leaves out a file from the plan's own File Structure or Component Design that its `**Statement:**` says applies the rule
- One invariant bundles several distinct rules (each needs its own invariant and owner)
- An `**Owner module:** none` invariant whose reason does not explain why no module can own it (a prohibition or an unobservable SLA is a reason; "spread across modules" is a missing owner)

Each `OWN-N` gap names the rule, the sites the plan describes, and the missing or contradicting declaration.

### 3.6 Check Requirements Against Recorded Discoveries

Coverage is not enough: a plan can cover a Requirement that the recorded facts make unsatisfiable. For **each** Requirement and plan decision, check it against **every** discovery from step 2.5. Flag as a gap (ID `FEAS-N`) any pair where:

- the Requirement or plan decision assumes behavior a discovery contradicts (the harness, provider, or library does something else)
- a discovery makes a Requirement unreachable or unmeasurable on every route the plan qualifies
- a discovery names a constraint the plan neither honors nor explicitly rejects

Each `FEAS-N` gap names the Requirement or decision, the document and discovery it conflicts with, and why. Never write "No gaps found." while a `FEAS-N` contradiction stands.

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
- **FEAS-N** — (Requirement or decision) vs `(document)`: (the discovery it contradicts, and why)
- **OWN-N** — (the rule): (the sites the plan applies it at, and the missing or contradicting ownership declaration)

(Write "None." if no gaps)

## Supporting Documents Checked

- `(document)` — (number of discoveries checked)

(Write "None in {spec_dir}." if there were none)

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
