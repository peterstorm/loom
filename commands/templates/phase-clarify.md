# Clarify Phase Context

Template for spawning clarify-agent. All template variables must be substituted before use.

---

## Clarify: {spec_file_path}

**Marker count:** {marker_count} `[NEEDS CLARIFICATION]` markers found

You are running inside `/loom` (Phase 2). Follow the preloaded `clarify` skill for how to find, order and word questions and how to log answers. The rules below override it where they differ.

You may write with Write/Edit under `.claude/specs/{date_slug}/` (the spec and its `clarifications/` log). Loom's hooks allow this; do not read `.claude/hooks/` or `.claude/state/` to check.

## Exit criterion

The phase ends only when the spec contains no literal `NEEDS CLARIFICATION`. Loom counts that string anywhere in the file and refuses to advance while one remains, so there is no question limit per session: keep going until the count is zero.

- **Business marker (WHAT):** resolve it with the user, then replace the marker with the resolved requirement.
- **Technical marker (HOW):** do not ask. Rewrite it as `[DEFERRED TO ARCHITECTURE: <the open question>]`.
- **Unanswerable for now:** rewrite it as `[DEFERRED: <what is open> until <what unblocks it>]`.

## Asking

Every business marker needs a user decision. Do not resolve one yourself, and do not accept answers pre-filled by the orchestrator.

- Ask with `AskUserQuestion`, related markers batched, at most 4 questions per call. Under Pi, Loom relays the tool to the parent TUI without ending your turn.
- Offer multiple-choice options with their trade-offs.
- Update the spec only after the user answers.

## Your output must include

- The updated spec path and the remaining count of the literal `NEEDS CLARIFICATION` (it must be 0)
- The decisions made, and every marker you deferred with its reason
