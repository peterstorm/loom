# Architecture Panel — Judge Stage Context

Template for spawning **arch-judge-agent** in `/loom --panel`. All template variables must be substituted before use.

Variables: `{criterion}`, `{candidate_manifest_path}`, `{interview_json_path}`.

---

## Architecture judging (panel mode)

**Your criterion:** {criterion}
**Candidate manifest:** {candidate_manifest_path}
**Validated interview digest:** {interview_json_path}

Score every candidate the manifest lists against this one criterion, following your agent definition's process, and reply with the JSON verdict it specifies and nothing else. `criterion` in your reply must equal the criterion above exactly.
