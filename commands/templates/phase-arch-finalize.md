# Architecture Panel — Finalize Stage Context

Template for spawning **architecture-agent** (finalize mode) in `/loom --panel`. The agent name is load-bearing: only architecture-agent's SubagentStop advances the phase. All template variables must be substituted before use.

Variables: `{feature_description}`, `{spec_file_path}`, `{interview_file_path}`, `{candidate_manifest_path}`, `{judge_verdicts}`, `{panel_ranking}`, `{date_slug}`, `{loom_dir}`.

Uses the design knowledge from the preloaded `architecture-tech-lead` skill (FP, DDD, testability, stack-specific patterns).

---

## Architecture finalize (panel mode): {feature_description}

**Spec:** {spec_file_path}
**Interview digest:** {interview_file_path}
**Candidate manifest:** {candidate_manifest_path}

You are running the **finalize stage** of a panel-mode architecture run. The interview is complete and the manifest identifies the exact candidates from this run. Run the approach gate, synthesize the user's selection, and write the plan using the preloaded `architecture-tech-lead` skill.

## Panel mode: interview is done — do NOT re-interview

The interview digest at {interview_file_path} already captures the user's priorities. **Never re-run the questionnaire.** The approach gate remains mandatory: panel ranking is a recommendation, never an automatic decision.

## CRITICAL: You CAN Write Files

You are a subagent — Write/Edit is allowed, scoped to this phase's artifact directory (`.claude/plans/`, and panel-run dirs under `.claude/specs/{date_slug}/panel-runs/`). Do NOT read `.claude/hooks/` or `.claude/state/`. Write the plan only after the gate is resolved.

## Validated judge verdicts

{judge_verdicts}

These verdicts were schema-validated against the exact manifest candidate set and sanitized before inlining.

## Computed panel ranking

{panel_ranking}

This ranking was computed by `helper panel-contract aggregate`, which re-read and re-validated every verdict from the run directory, matched each to its criterion **by name**, and applied the tie-break below deterministically. It is authoritative — do not recompute it.

## Process

### 1. Read exact inputs

- Read the interview digest at {interview_file_path}.
- Read the manifest at {candidate_manifest_path}, then read exactly its `candidates[].path` files. Never discover candidates by scanning a directory.
- Cross-reference the validated verdicts above.

### 2. Read the computed ranking — do NOT recompute it

The **Computed panel ranking** above is already sorted best → worst, with `rank`, `total_score`, and per-criterion `scores`. Its `ranking[0]` is the panel recommendation. Use it as given.

For reference, the rule the helper applied is: highest total score; on a tie, each criterion in order (the first being the primary axis, the second the testability bar); then lexicographically smallest candidate filename. Do not invent another weighting rule, and do not re-derive the ranking by hand — hand arithmetic over the verdicts is exactly what this step replaced.

If the ranking is missing, empty, or lists candidates absent from the manifest, **stop and report the error** rather than falling back to computing it yourself.

### 3. Approach gate — MANDATORY

Present the **top 2–3 ranked candidates** via `AskUserQuestion` (single question, 2–3 options). Each option preview must concisely include the candidate's approach summary, trade-offs, testability impact, codebase fit, and effort. State which candidate the panel recommends and give a one-sentence justification grounded in the verdicts. **If the user picks another candidate, accept it without argument.**

### 4. Synthesize

Take the user's chosen candidate as the base. Graft each judge's `strongest_idea` from losing candidates **only where compatible** with the chosen approach. Record what was grafted.

### 5. Proceed with the standard architecture flow (§5–6)

Read `{loom_dir}/commands/templates/phase-architecture.md` (§5–6), `{loom_dir}/references/executable-models.md`, and `{loom_dir}/references/plan-template.md`. `{loom_dir}` was resolved and verified by the parent orchestrator; do not re-scan the plugin cache. Follow standard mode's design/plan requirements, executable-model rules, and commit behavior exactly.

**Output location:** `.claude/plans/{date_slug}.md`

### 6. Record the panel outcome — MANDATORY AD block

In `## Architectural Decisions`, add `### AD-1: Approach selection (panel)` with: the exact candidate manifest path; run id and lenses from the manifest; one-line verdict summary per criterion; the computed ranking verbatim (candidate, rank, total score); the user's choice; the panel recommendation if different; and grafted `strongest_idea`s. Canonical verdict files and the aggregate ranking remain in the run directory, while AD-1 is the durable plan-level summary.

Commit per standard §6.

## What NOT to do

- Do NOT re-run the interview.
- Do NOT skip the approach gate.
- Do NOT write the plan before the user picks.
- Do NOT scan the candidates directory or include files absent from the manifest.
- Do NOT design beyond spec scope.

## Your output must include

- Path to the created plan file.
- Candidate the user picked and panel recommendation, if different.
- What was grafted in synthesis.
- Implementation phases and any executable models declared.
