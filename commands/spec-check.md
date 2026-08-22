---
name: spec-check
version: "2.0.0"
description: "This skill should be used when the user asks to 'check spec alignment', 'verify requirements coverage', 'detect drift', 'spec audit', or automatically at wave gates. Verifies implementation aligns with specification - different from code review which checks quality."
argument-hint: "[scope or instructions]"
---

# Spec-Check - Drift Detection

Read-only verification that implementation aligns with specification. Mechanically extracts requirements, forces one verdict per Requirement Completion Claim, and detects coverage gaps and scope creep.

**Arguments:** "$ARGUMENTS"

**Not what this does:** Check code quality, style, security (that's code-reviewer's job).

---

## Process — FOLLOW EXACTLY

Every step below that says "Run:" is a command you MUST execute via Bash/Grep/Read tool. Do NOT skip tool calls. Do NOT assess from memory alone.

### Step 1: Load artifacts and freeze scope authority

**Registered Wave Gate (`LOOM_CONTEXT_PATH` is set): Run this decoder.** It reads the immutable packet only; do NOT read `active_task_graph.json` on this path.

```bash
bun -e '
const path = process.env.LOOM_CONTEXT_PATH;
if (!path) throw new Error("LOOM_CONTEXT_PATH is required for registered spec-check");
const packet = JSON.parse(await Bun.file(path).text());
const section = packet.fixedContext?.find((entry) => entry.label === "wave-review-authority");
if (!section) throw new Error("immutable packet lacks wave-review-authority");
const authority = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(Uint8Array.from(section.bytes)));
if (authority.subject?.role !== "spec-check-invoker" || !Array.isArray(authority.specCheckScope)) {
  throw new Error("immutable packet lacks registered spec-check scope authority");
}
console.log(JSON.stringify({specFile: authority.specFile, wave: authority.wave, tasks: authority.specCheckScope}, null, 2));
'
```

Save the exact `specFile`, `wave`, and `tasks` values. Each Task contains `completionAnchors`, `contributions`, and `declaredFiles`. This roster is immutable authority even if the live graph changes later.

**Standalone `/spec-check` only (`LOOM_CONTEXT_PATH` is absent): Run the live-graph fallback:**

```bash
SPEC=$(ls -t .claude/specs/*/spec.md | head -1) && echo "$SPEC"
```

```bash
jq -r '.current_wave' .claude/state/active_task_graph.json
```

```bash
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | {id, description, completionAnchors:(.spec_anchors // []), contributions:(.spec_contributions // []), declaredFiles:(.file_list // [])}' .claude/state/active_task_graph.json
```

Normalize this fallback to the same SPEC path, WAVE number, and Task scope shape.

### Step 2: Extract the Requirement checklist (deterministic)

**Run:** Use Grep to locate every identifier named by `completionAnchors` in the spec (including FR, SC, and US/scenario anchors). A Completion Claim absent from the Spec is a critical trace-contract failure, not an item to skip.

Collect only `completionAnchors` across the frozen Wave Task roster into a flat list. These are the **in-scope Requirements** for this wave. `contributions` are partial traceability evidence only and MUST NOT enter the completion checklist.

**Build a checklist** — one row per in-scope Requirement:

```
<anchor> | <description from spec> | <assigned task(s)> | PENDING
```

You MUST have one row for every Requirement Completion Claim in `completionAnchors`. Count them. You will emit a verdict for every single row. Use `contributions` to understand precursor work, never to broaden the checklist.

### Step 3: Get changed files (deterministic)

**Run:**
```bash
git diff --name-only origin/main...HEAD
```

For a registered Wave Gate, use only each frozen Task's `declaredFiles` for Task-to-file assignment; do not query mutable task fields. For standalone fallback, `declaredFiles` was normalized from the live graph in Step 1.

### Step 4: Coverage check — per-Requirement verdicts

For EACH Requirement Completion Claim in the checklist from step 2:

1. **Read the Requirement description** from spec (you already have it)
2. **Read the relevant source file(s)** — use the changed files list and Task assignment to identify which files implement this Requirement. Use Read tool.
3. **Assess**: Does the code satisfy the Requirement as written in spec?
4. **Emit verdict**: `<anchor>: PASS` or `<anchor>: FAIL — <specific reason>`

**Rules:**
- MUST emit exactly one verdict line per in-scope Completion Claim. If the checklist has 12 anchors, output has 12 verdict lines.
- "Soft compliance" is not PASS. If spec says "MUST do X" and code doesn't do X, it's FAIL.
- MUST/SHALL requirements that are unimplemented = CRITICAL
- SHOULD requirements that are unimplemented = HIGH
- MAY requirements that are unimplemented = MEDIUM

**After all verdicts, count:** How many in-scope Completion Claims from the checklist did you emit? Does it match the total from step 2? If not, you skipped one — go back.

### Step 5: Acceptance scenario coverage

**Run:** Use Grep to extract lines matching `Given .* When .* Then` or `- Given` from the spec file. These are acceptance scenarios.

Filter to scenarios belonging to User Stories that map to the in-scope Completion Claims.

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

Review the changed files list from step 3. For each new exported function/class/command not traceable to an in-scope Completion Claim:
- If it's in the Out of Scope list = CRITICAL (explicitly excluded)
- If it's a helper/utility supporting an in-scope Requirement = OK (not scope creep)
- If it's a new feature with no Spec requirement = HIGH

---

## Output Format

### Per-Requirement Verdicts (MANDATORY)

```
## Requirement Coverage — Wave {N}

| Anchor | Description | Task | Verdict |
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
- Even if counts are zero, emit the SPEC_CHECK_CRITICAL_COUNT, SPEC_CHECK_HIGH_COUNT, and SPEC_CHECK_VERDICT lines — all three are required, and a missing marker fails evidence capture rather than reading as zero
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
- MUST emit one verdict per in-scope Requirement Completion Claim — no skipping
- Registered Wave Gate scope comes only from `LOOM_CONTEXT_PATH`; never reread mutable `active_task_graph.json`
- Requirement Contributions are traceability only and never enter completion scope
- MUST use tool calls (Grep, Read, Bash) for evidence — no assessing from memory
- Different from code review: Alignment vs quality are separate concerns
