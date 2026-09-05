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

### Which path you are on — decide ONCE, here

Two execution paths exist, and every step below depends on which one you are on. Decide now and carry it through; do not re-decide per step.

| | **Projected** | **Unprojected** |
|---|---|---|
| When | `LOOM_CONTEXT_PATH` is set AND the `requirement-coverage` section does **not** say `UNAVAILABLE` | `LOOM_CONTEXT_PATH` is absent (standalone), OR the section says `UNAVAILABLE` |
| Requirement checklist | the projection's rows | grep the spec for the claimed identifiers |
| Requirement text | the projection's `Requirement` column | read it from the spec at `specFile` |
| Acceptance scenarios | the projection's unclaimed-scenario list | grep the spec for `Given … When … Then` |
| Out-of-Scope list | the projection's typed `OOS-NNN` entries | grep the spec's Out of Scope section |
| Glossary | the projection's typed terms | grep the spec's Appendix table |
| Who settles a row | `Decided by: engine` rows are settled | nothing is settled; you assess everything |

**On the Unprojected path you MUST say so in the summary**, and state why (no registered packet, or the projection's stated `UNAVAILABLE` reason). An unprojected run is a weaker run; reporting it as if structural verdicts were available is the one failure this whole step exists to prevent.

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

Save the exact `specFile`, `wave`, and `tasks` values. Each Task contains `completionAnchors`, `contributions`, `declaredFiles`, and `modifiedFiles`. This roster is immutable authority even if the live graph changes later.

**Then read the Requirement Coverage Projection from the same packet.** The engine has already joined the Spec Index against this exact roster; Steps 2, 4, 5, 6 and 7 consume that projection instead of re-deriving it.

```bash
bun -e '
const path = process.env.LOOM_CONTEXT_PATH;
const packet = JSON.parse(await Bun.file(path).text());
const section = packet.fixedContext?.find((entry) => entry.label === "requirement-coverage");
if (!section) throw new Error("immutable packet lacks the Requirement Coverage Projection");
console.log(new TextDecoder("utf-8", {fatal:true}).decode(Uint8Array.from(section.bytes)));
'
```

The projection is engine-derived authority, not advice, and it states its own rules in its header — those rules win over anything restated here. Two facts travel per row and must not be confused:

- **`Decided by`** — `engine` means the row is settled: copy it into your report verbatim, do not re-litigate it. `agent` means an assessment is still owed **regardless of severity**.
- **`Severity`** — how bad the structural fact is. A `MEDIUM` (drifted) or `CRITICAL` (altered hash) row can still be `Decided by: agent`; severity never excuses you from reading the code.

The projection's last line states the settled CRITICAL count. **Your report may not fall below it** — the engine re-derives that count at capture and fails evidence capture if you do.

If it renders `UNAVAILABLE` you are on the **Unprojected** path: nothing is settled, and the projection carries no Requirement text, no scenario roster, no exclusion list and no glossary.

**Standalone `/spec-check` only (`LOOM_CONTEXT_PATH` is absent): Run the live-graph fallback:**

```bash
SPEC=$(ls -t .claude/specs/*/spec.md | head -1) && echo "$SPEC"
```

```bash
jq -r '.current_wave' .claude/state/active_task_graph.json
```

```bash
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | {id, description, completionAnchors:(.spec_anchors // []), contributions:(.spec_contributions // []), declaredFiles:(.file_list // []), modifiedFiles:(.files_modified // [])}' .claude/state/active_task_graph.json
```

Normalize this fallback to the same SPEC path, WAVE number, and Task scope shape. **The standalone path has no engine-derived projection** — there is no registered packet to carry one — so it performs the model-read assessment for every claim, exactly as before. Say so in the summary rather than implying structural verdicts were available.

### Step 2: Take the Requirement checklist

**Projected:** the projection's rows ARE the checklist — one row per Requirement Completion Claim in the frozen roster, already joined against the Spec Index. Do not grep the spec for identifiers and do not re-count: the row set is engine-derived and complete by construction. `contributions` are partial traceability evidence only and never enter it.

Carry each row forward with both of its facts:

```
<task> | <anchor> | <decided by> | <severity> | SETTLED-or-PENDING
```

`Decided by: engine` → **SETTLED**, goes straight to Step 4's output. `Decided by: agent` → **PENDING** your assessment, whatever its severity.

**Unprojected:** build the checklist by grepping the spec for every identifier named by `completionAnchors`. A Completion Claim absent from the spec is a critical trace-contract failure, not an item to skip. Every row is PENDING.

### Step 3: Get changed files (deterministic)

**Run:**
```bash
git diff --name-only origin/main...HEAD
```

For a registered Wave Gate, use only each frozen Task's `declaredFiles` for Task-to-file assignment; do not query mutable task fields. For standalone fallback, `declaredFiles` was normalized from the live graph in Step 1.

### Step 4: Coverage check — per-Requirement verdicts

**SETTLED rows (`Decided by: engine`) — copy, do not assess.** The projection decided these from structure, and reading files cannot change them. Emit each verbatim:

| Projected detail | Emit | Severity |
|---|---|---|
| names no entry in the Spec Index | `<anchor>: FAIL — names no entry in the Spec Index` | CRITICAL |
| claims completion of an excluded item | `<anchor>: FAIL — claims completion of an explicitly excluded item` | CRITICAL |
| the Task declared no artifacts | `<anchor>: FAIL — the Task declared no artifacts` | CRITICAL |
| the Task modified no files | `<anchor>: FAIL — the Task modified no files` | CRITICAL |

You MUST NOT overturn a settled row. If you believe one is wrong, the defect is in the engine's join or in the graph, and it belongs in the summary as a note — not as a softened verdict.

**PENDING rows (`Decided by: agent`) — assess.** This includes rows already carrying a severity: a `MEDIUM` drifted row and a `CRITICAL` altered-hash row are both still yours to assess, and the drifted one *most* of all, because its Requirement text moved after the claim was made.

1. **Read the Requirement text.** On the Projected path the row's `Requirement` column carries it. On the Unprojected path, read it from the spec at `specFile`.
2. **Read the relevant source file(s)** — use the changed files list and the Task's `declaredFiles`/`modifiedFiles`. Use Read tool.
3. **Assess**: Does the code satisfy the Requirement as written *now*?
4. **Emit verdict**: `<anchor>: PASS` or `<anchor>: FAIL — <specific reason>`, and for a drifted or altered-hash row also emit the projection's severity line beside it.

**Rules:**
- MUST emit exactly one verdict line per checklist row — settled and pending together. The projection's row count is the expected total.
- "Soft compliance" is not PASS. If spec says "MUST do X" and code doesn't do X, it's FAIL.
- MUST/SHALL requirements that are unimplemented = CRITICAL
- SHOULD requirements that are unimplemented = HIGH
- MAY requirements that are unimplemented = MEDIUM

**Then emit both unclaimed lists from the projection** — Functional Requirements and Acceptance Scenarios — each entry as CRITICAL: a Requirement or Scenario whose completion no Task claims at any Wave is planned by nobody. (Requirement Contributions are deliberately not counted as claims; if a listed item has contributing work planned, say so beside the finding rather than dropping it.)

### Step 5: Acceptance scenario coverage

Acceptance Scenarios are canonical `AS-NNN` entries in the Spec Index — a Task claims one exactly as it claims an `FR-NNN`, and a claimed scenario already has its row in Step 4. This step covers the scenarios in scope that **no** Task claimed.

**Projected — the scenario roster is the projection's "Acceptance Scenarios whose completion no Task claims" section.** For each identifier it lists, grep the changed test files:

```bash
grep -rn "AS-001" --include=*.test.ts --include=*.spec.ts --include=*Test.java .
```

The convention is `it('AS-001: …')` — an identifier in a test name is a structural link, not prose matching.

1. **Emit verdict**: `AS-NNN: COVERED — <test file>` or `AS-NNN: NOT COVERED — <reason>`
2. When the grep finds a name, **Read the test** to confirm it exercises the scenario rather than merely naming it.

If that section says every scenario is claimed, this step is genuinely empty — say so; do not leave the scenario table blank.

**Unprojected:** grep the spec for `Given .* When .* Then` lines and assess each, as before.

**Severity for uncovered scenarios:**
- Happy path not tested = HIGH
- Error path not tested = MEDIUM
- Edge case not tested = LOW

### Step 6: Terminology check

**Projected:** the projection carries the typed glossary — term and definition, parsed, not grepped. Do not re-extract the table.

**Unprojected:** grep the spec for the Glossary/Appendix table and extract the terms yourself. The projection carries no glossary on this path, and skipping the step because it "should have" is exactly how the terminology check goes dark.

**Run (both paths):** extract from the spec's Dependencies section — note specific technology names (e.g., "Voyage AI", "Haiku", "FTS5"). This section is not part of the Spec Index, so it always needs a read.

For each glossary term and technology name, grep the changed source files for that term AND common variants. Flag mismatches where the spec uses one name but the code uses another.

Severity: MEDIUM for terminology drift.

### Step 7: Scope creep check

**Projected:** the projection carries the typed exclusion list as canonical `OOS-NNN` entries. Do not grep for the section.

**Unprojected:** grep the spec's "Out of Scope" section and extract the exclusion list yourself. Where the section has no canonical identifiers, quote the exclusion text instead of naming an id you do not have.

Review the changed files list from step 3. For each new exported function/class/command not traceable to an in-scope Completion Claim:
- If it matches an `OOS-NNN` entry = CRITICAL, and **name the identifier** (`OOS-003`), not a paraphrase of the section text
- If it's a helper/utility supporting an in-scope Requirement = OK (not scope creep)
- If it's a new feature with no Spec requirement = HIGH

A Task that *claimed* an `OOS-NNN` as completed was already settled CRITICAL in Step 4; this step is about code that drifted into an exclusion without claiming it.

---

## Output Format

### Per-Requirement Verdicts (MANDATORY)

`Decided by` is copied from the projection, not judged by you, so a reader can tell a structural refutation from an assessment without re-running anything.

```
## Requirement Coverage — Wave {N}

| Anchor | Description | Task | Decided by | Verdict |
|----|-------------|------|--------|---------|
| FR-001 | System MUST extract memories... | T15 | agent | PASS |
| FR-004 | System MUST track cursor... | T15 | agent | PASS |
| FR-039 | System MUST prefix query... | T17 | agent | FAIL — buildQueryEmbeddingText returns raw query |
| FR-041 | System MUST retry on 429... | T17 | agent | PASS — MEDIUM: spec text drifted since the claim; reassessed against the current wording |
| FR-042 | System MUST rotate keys... | T18 | engine | FAIL — the Task modified no files |
| OOS-002 | Symbol-level indexing | T19 | engine | FAIL — claims completion of an explicitly excluded item |
| FR-050 | System MUST cap batches... | — | engine | FAIL — no Task in the graph claims its completion |
| AS-004 | Given a stale cursor, When... | — | engine | FAIL — no Task in the graph claims its completion |
...

Total: {X}/{Y} PASS ({Z} FAIL) — {S} settled by the engine, {A} assessed.
Settled CRITICAL floor: {F}. Reported CRITICAL: {R}.
```

On the Unprojected path every row reads `agent` and the summary MUST say why no structural verdicts were available. `Decided by` is the projection's own column, not a judgement you make: copy it.

### Per-Scenario Verdicts

```
## Acceptance Scenarios — Wave {N}

| Scenario | Verdict |
|----------|---------|
| AS-001: Given session with decisions, When ends, Then extracted | COVERED — engine/tests/extract.test.ts |
| AS-003: Given indexed function, When search prose, Then code returned | NOT COVERED |
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
- The Requirement Coverage Projection is engine-derived authority: `Decided by: engine` rows are copied, never overturned or softened
- Severity is not settlement. A `MEDIUM` or `CRITICAL` row that reads `Decided by: agent` still needs you to read the code
- Your CRITICAL count may never fall below the projection's stated settled floor; the engine re-derives it at capture and fails evidence capture if it does
- An UNAVAILABLE projection puts you on the Unprojected path: nothing is settled, and the glossary and Out-of-Scope list must be read from the specification — say so in the summary
- Requirement Contributions are traceability only and never enter completion scope
- MUST use tool calls (Grep, Read, Bash) for evidence — no assessing from memory, and no re-deriving what the projection already decided
- Different from code review: Alignment vs quality are separate concerns
