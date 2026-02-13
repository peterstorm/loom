---
name: spec-check
version: "2.0.0"
description: "This skill should be used when the user asks to 'check spec alignment', 'verify requirements coverage', 'detect drift', 'spec audit', or automatically at wave gates. Verifies implementation aligns with specification - different from code review which checks quality."
---

# Spec-Check - Drift Detection

Read-only verification that implementation aligns with specification. Mechanically extracts requirements, forces per-FR verdicts, detects coverage gaps and scope creep.

**Not what this does:** Check code quality, style, security (that's code-reviewer's job).

---

## Process — FOLLOW EXACTLY

Every step below that says "Run:" is a command you MUST execute via Bash/Grep/Read tool. Do NOT skip tool calls. Do NOT assess from memory alone.

### Step 1: Load artifacts

**Run:**
```bash
SPEC=$(ls -t .claude/specs/*/spec.md | head -1) && echo "$SPEC"
```

**Run:**
```bash
WAVE=$(jq -r '.current_wave' .claude/state/active_task_graph.json) && echo "Wave: $WAVE"
```

**Run:**
```bash
WAVE=$(jq -r '.current_wave' .claude/state/active_task_graph.json)
jq -r ".tasks[] | select(.wave == $WAVE) | {id, description, spec_anchors}" .claude/state/active_task_graph.json
```

Save: SPEC path, WAVE number, task list with spec_anchors.

### Step 2: Extract the FR checklist (deterministic)

**Run:** Use Grep to extract all `FR-\d+:` lines from the spec file. This is the master FR list.

Then from step 1 output, collect all `spec_anchors` across wave tasks into a flat list. These are the **in-scope FRs** for this wave.

**Build a checklist** — one row per in-scope FR:

```
FR-XXX | <description from spec> | <assigned task> | PENDING
```

You MUST have one row for every FR in spec_anchors. Count them. You will emit a verdict for every single row.

### Step 3: Get changed files (deterministic)

**Run:**
```bash
git diff --name-only origin/main...HEAD
```

Also check per-task files_modified if available:
```bash
WAVE=$(jq -r '.current_wave' .claude/state/active_task_graph.json)
jq -r ".tasks[] | select(.wave == $WAVE) | {id, files_modified}" .claude/state/active_task_graph.json
```

### Step 4: Coverage check — per-FR verdicts

For EACH FR in the checklist from step 2:

1. **Read the FR description** from spec (you already have it)
2. **Read the relevant source file(s)** — use the changed files list and task assignment to identify which files implement this FR. Use Read tool.
3. **Assess**: Does the code satisfy the requirement as written in spec?
4. **Emit verdict**: `FR-XXX: PASS` or `FR-XXX: FAIL — <specific reason>`

**Rules:**
- MUST emit exactly one verdict line per in-scope FR. If checklist has 12 FRs, output has 12 verdict lines.
- "Soft compliance" is not PASS. If spec says "MUST do X" and code doesn't do X, it's FAIL.
- MUST/SHALL requirements that are unimplemented = CRITICAL
- SHOULD requirements that are unimplemented = HIGH
- MAY requirements that are unimplemented = MEDIUM

**After all verdicts, count:** How many in-scope FRs from the checklist did you emit? Does it match the total from step 2? If not, you skipped one — go back.

### Step 5: Acceptance scenario coverage

**Run:** Use Grep to extract lines matching `Given .* When .* Then` or `- Given` from the spec file. These are acceptance scenarios.

Filter to scenarios belonging to User Stories that map to in-scope tasks (US numbers referenced in spec near the in-scope FRs).

For EACH acceptance scenario:

1. Identify which test file should cover it (from changed files, `*.test.ts` or `*.spec.ts`)
2. **Read the test file** — use Read tool
3. **Assess**: Is there a test that exercises this scenario (happy path, error path, edge case)?
4. **Emit verdict**: `US-X scenario N: COVERED` or `US-X scenario N: NOT COVERED — <reason>`

**Severity for uncovered scenarios:**
- Happy path not tested = HIGH
- Error path not tested = MEDIUM
- Edge case not tested = LOW

### Step 6: Terminology check (deterministic)

**Run:** Use Grep to find the Glossary/Appendix table in the spec. Extract key terms.

**Run:** Also extract from spec Dependencies section — note specific technology names (e.g., "Voyage AI", "Haiku", "FTS5").

For each key term/technology name, grep the changed source files for that term AND common variants. Flag mismatches where spec uses one name but code uses another.

Severity: MEDIUM for terminology drift.

### Step 7: Scope creep check

**Run:** Use Grep to find the "Out of Scope" section in the spec. Extract the exclusion list.

Review the changed files list from step 3. For each new exported function/class/command not traceable to an in-scope FR:
- If it's in the Out of Scope list = CRITICAL (explicitly excluded)
- If it's a helper/utility supporting an in-scope FR = OK (not scope creep)
- If it's a new feature with no FR = HIGH

---

## Output Format

### Per-FR Verdicts (MANDATORY)

```
## FR Coverage — Wave {N}

| FR | Description | Task | Verdict |
|----|-------------|------|---------|
| FR-001 | System MUST extract memories... | T15 | PASS |
| FR-004 | System MUST track cursor... | T15 | PASS |
| FR-039 | System MUST prefix query... | T17 | FAIL — buildQueryEmbeddingText returns raw query |
...

Total: {X}/{Y} PASS ({Z} FAIL)
```

### Per-Scenario Verdicts

```
## Acceptance Scenarios — Wave {N}

| Scenario | Verdict |
|----------|---------|
| US1: Given session with decisions, When ends, Then extracted | COVERED |
| US3: Given indexed function, When search prose, Then code returned | NOT COVERED |
...
```

### Findings Summary

```
## Findings

### CRITICAL ({count})
1. **Coverage Gap:** FR-039 — query embedding metadata prefix not implemented
   - Spec: "System MUST prefix query embeddings with metadata"
   - Code: buildQueryEmbeddingText returns raw query
   - Task: T17

### HIGH ({count})
...

### MEDIUM ({count})
...

### Summary

| Severity | Count |
|----------|-------|
| CRITICAL | N |
| HIGH | N |
| MEDIUM | N |
| LOW | N |

**Verdict:** PASSED | BLOCKED
```

### Machine-Readable Footer (MANDATORY — parsed by hooks)

The SubagentStop hook parses these exact patterns from the transcript. Emit them **exactly** as shown — no markdown formatting, no indentation, no code fences around them.

```
SPEC_CHECK_WAVE: {N}

CRITICAL: {one-line description of critical finding}
CRITICAL: {another critical finding}
HIGH: {one-line description of high finding}
MEDIUM: {one-line description of medium finding}

SPEC_CHECK_CRITICAL_COUNT: {N}
SPEC_CHECK_HIGH_COUNT: {N}
SPEC_CHECK_VERDICT: PASSED | BLOCKED
```

**Rules for machine-readable lines:**
- Each `CRITICAL:` / `HIGH:` / `MEDIUM:` line MUST start at column 0 (no leading spaces)
- One finding per line, no line breaks within a finding
- Counts MUST match the number of CRITICAL/HIGH/MEDIUM lines above them
- Even if counts are zero, emit the SPEC_CHECK_CRITICAL_COUNT and SPEC_CHECK_VERDICT lines
- These lines appear AFTER the human-readable report, as the very last output

---

## Severity Definitions

| Severity | Meaning | Blocks Wave? |
|----------|---------|--------------|
| CRITICAL | MUST requirement unimplemented, explicit out-of-scope violation | Yes |
| HIGH | SHOULD requirement gap, happy-path scenario untested | No (advisory) |
| MEDIUM | Terminology drift, MAY gaps, error-path untested | No (advisory) |
| LOW | Minor inconsistencies, edge-case untested | No (informational) |

---

## Constraints

- Read-only: NEVER modify code or spec
- Findings only: Report issues, don't fix them
- Spec is source of truth: Code must align to spec, not vice versa
- CRITICAL blocks waves: Non-negotiable
- MUST emit one verdict per in-scope FR — no skipping
- MUST use tool calls (Grep, Read, Bash) for evidence — no assessing from memory
- Different from code review: Alignment vs quality are separate concerns
