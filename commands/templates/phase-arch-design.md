# Architecture Panel — Design Stage Context

Template for spawning **arch-designer-agent** in `/loom --panel`. All template variables must be substituted before use.

Variables: `{feature_description}`, `{lens_name}`, `{lens_prompt}`, `{spec_file_path}`, `{interview_file_path}`, `{candidate_output_path}`.

Uses the design knowledge from the preloaded `architecture-tech-lead` skill.

---

## Architecture candidate (panel mode): {feature_description}

**Lens:** {lens_name}
**Spec:** {spec_file_path}
**Interview digest:** {interview_file_path}

You are ONE of several parallel designers. Produce **exactly one** candidate, viewed entirely through your assigned lens. You run **headless** — there is no user to ask. Other designers cover other lenses; commit fully to yours rather than hedging toward a balanced middle.

## Your lens

{lens_prompt}

## CRITICAL: You CAN Write Files

You are a subagent — Write/Edit is allowed. Do NOT read `.claude/hooks/` or `.claude/state/`. Do NOT use `AskUserQuestion` — you are headless.

## Process

1. **Read the interview digest** at {interview_file_path}. Scope, sensitive boundaries, and explicit codebase restrictions are hard constraints. The primary axis and testability bar are evaluation preferences: optimize for them, but state honestly where your assigned lens trades against them.
2. **Read the spec** at {spec_file_path} — design only for what's in scope.
3. **Explore the codebase** enough to ground reuse and file-structure decisions.
4. **Design one candidate through your lens.** Let the lens drive every trade-off. State honestly what your lens sacrifices and its characteristic failure mode — never strawman your own approach.

## Output — the candidate

Write to **{candidate_output_path}** in this fixed format (it mirrors the approach-gate preview format so the finalizer can lift previews directly):

```
# Candidate: {lens_name}

## Approach summary
<1–2 sentences: how it works.>

## Component boundaries
<Components and responsibilities.>

## Data flow
<How data moves between components.>

## File-structure sketch
<Files to create/modify, tree form.>

## Trade-offs
Pros:
+ <concrete>
+ <concrete>
+ <concrete>
Cons:
- <concrete — including what this lens sacrifices>
- <concrete>
- <concrete>

## Testability impact
<How testable, given the interview's testability bar.>

## Codebase fit
<How this conforms to, extends, or intentionally diverges from the existing codebase.>

## Effort
<Rough estimate.>

## Lens fit
<One line: why this is the honest expression of your lens, and its characteristic risk.>
```

## What NOT to do

- Do NOT use `AskUserQuestion` — headless.
- Do NOT write `.claude/plans/` or any plan file.
- Do NOT author executable-model artifacts (statechart machine files, AuthoredDag sidecars, lint rules) — that is finalizer work, after the user picks.
- Do NOT produce more than one candidate; do NOT hedge across lenses.

## Your output must include

- The path to the written candidate file.
- Your lens name and a one-line self-assessment of its biggest risk.
