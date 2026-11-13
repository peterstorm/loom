# Architecture Panel — Design Stage Context

Template for spawning **arch-designer-agent** in `/loom --panel`. All template variables must be substituted before use.

Variables: `{feature_description}`, `{lens_name}`, `{lens_prompt}`, `{spec_file_path}`, `{interview_file_path}`, `{candidate_output_path}`.

---

## Architecture candidate (panel mode): {feature_description}

**Lens:** {lens_name}
**Spec:** {spec_file_path}
**Interview digest:** {interview_file_path}
**Candidate output:** {candidate_output_path}

Produce exactly one candidate through the lens below, following your agent definition's process and its candidate format, with the preloaded `architecture-tech-lead` skill as design knowledge. Title the file `# Candidate: {lens_name}`.

## Your lens

{lens_prompt}

## Writing

Write the candidate to **{candidate_output_path}**. You may write with Write/Edit only there (this run's panel directory under `.claude/specs/`).
