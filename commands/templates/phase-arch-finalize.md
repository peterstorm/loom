# Architecture Panel — Finalize Stage Context

Template for spawning **architecture-agent** (finalize mode) in `/loom --panel`. The agent name is load-bearing: only architecture-agent's SubagentStop advances the phase to plan-alignment. All template variables must be substituted before use.

Variables: `{feature_description}`, `{spec_file_path}`, `{interview_file_path}`, `{candidates_dir}`, `{judge_verdicts}`, `{date_slug}`.

Uses the design knowledge from the preloaded `architecture-tech-lead` skill (FP, DDD, testability, stack-specific patterns).

---

## Architecture finalize (panel mode): {feature_description}

**Spec:** {spec_file_path}
**Interview digest:** {interview_file_path}
**Candidates directory:** {candidates_dir}

You are running the **finalize stage** of a panel-mode architecture run. The interview is ALREADY DONE and N designer candidates already exist. Your job: run the approach gate over the candidates, synthesize the winner, and write the plan — using the design knowledge from your preloaded `architecture-tech-lead` skill.

## Panel mode: interview is done — do NOT re-interview

The interview digest at {interview_file_path} already captures the user's priorities. **Never re-run the questionnaire.** The approach gate below, however, is STILL MANDATORY — the panel's ranking is a recommendation, never silently applied.

## CRITICAL: You CAN Write Files

You are a subagent — Write/Edit is allowed. Do NOT read `.claude/hooks/` or `.claude/state/`. Just write the plan when the gate is resolved.

## Judge verdicts (inlined — adversarial rankings by criterion)

{judge_verdicts}

Each verdict ranks candidates on one criterion and names each candidate's `strongest_idea`. Use these to (a) recommend a winner and (b) drive synthesis.

## Process

### 1. Read the inputs

- Read the interview digest at {interview_file_path}.
- Read every candidate in {candidates_dir}.
- Cross-reference the judge verdicts above.

### 2. Approach gate — MANDATORY

Present the **top 2–3 ranked candidates** via `AskUserQuestion` (single question, 2–3 options). Use the `preview` field on each option to show the candidate's trade-off block in monospace — lift it straight from the candidate file (the candidate format mirrors the preview format). In the question text, state which candidate the panel recommends and give a one-sentence justification grounded in the verdicts (e.g. "wins on the primary axis and testability; only loses on X"). **If the user picks a candidate you did not recommend, take it.** Don't argue.

### 3. Synthesize

Take the user's chosen candidate as the base. Graft each judge's `strongest_idea` from the losing candidates **only where compatible** with the chosen approach — never force an idea that fights the base design. Note what you grafted; it goes in the AD block below.

### 4. Proceed with the standard architecture flow (§5–6)

Resolve the loom plugin dir and follow `phase-architecture.md` **§5 (Design the Architecture) and §6 (Write the Plan Document)** unchanged — executable models (Lifecycles / Pipeline / Invariants), the plan template, required sections, and commit:

```bash
LOOM_DIR=$(ls -d "$HOME/.claude/plugins/cache/"*"/loom"/*/ 2>/dev/null | tail -1 | sed 's:/$::')
```

Read `$LOOM_DIR/commands/templates/phase-architecture.md` (§5–6), `$LOOM_DIR/references/executable-models.md`, and `$LOOM_DIR/references/plan-template.md`, and apply them exactly as standard mode does. Executable-model artifacts (machine files, AuthoredDag sidecars, checkable lint rules) are authored HERE, now that the approach is locked — never by the designers.

**Output location:** `.claude/plans/{date_slug}.md`

### 5. Record the panel outcome — MANDATORY AD block

In the plan's `## Architectural Decisions` section, add a `### AD-1: Approach selection (panel)` block capturing: the lenses that ran, a one-line verdict summary per judge criterion, the candidate the user chose (and which the panel recommended, if different), and what `strongest_idea`s were grafted in synthesis. This is the durable audit trail — the judge verdicts are not persisted as files. Additional `### AD-N` blocks follow the normal rules for other decisions worth recording.

Commit per §6.

## What NOT to do

- Do NOT re-run the interview or re-ask the questionnaire — it is done.
- Do NOT skip the approach gate — it remains mandatory.
- Do NOT write the plan before the user picks at the gate.
- Do NOT design beyond spec scope.

## Your output must include

- Path to the created plan file.
- Which candidate the user picked (and which the panel recommended, if different).
- What was grafted in synthesis.
- Implementation phases identified, and any executable models declared (LC-N / Pipeline / INV-N with tiers and rule files).
