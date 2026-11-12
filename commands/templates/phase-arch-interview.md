# Architecture Panel — Interview Stage Context

Template for spawning **arch-interviewer-agent** in `/loom --panel`. All template variables must be substituted before use.

Variables: `{feature_description}`, `{spec_file_path}`, `{interview_file_path}`, `{loom_dir}`.

---

## Architecture interview (panel mode): {feature_description}

**Spec:** {spec_file_path}
**Questionnaire:** `{loom_dir}/references/architecture-interview.md`
**Digest output:** {interview_file_path}

Run the interview once, as your agent definition describes:

1. Read the spec at {spec_file_path} and explore the codebase.
2. Read the questionnaire at the path above and ask every topic it lists, by its "How to ask" rules. `{loom_dir}` was resolved and verified by the parent orchestrator; do not look for the package anywhere else.
3. Write the digest to **{interview_file_path}** with the labels your agent definition lists, then the `## Notes` section.

You may write with Write/Edit only under the directory of {interview_file_path} (this run's panel directory under `.claude/specs/`).

Do not design approaches, write candidate files, write a plan or touch `.claude/plans/`.
