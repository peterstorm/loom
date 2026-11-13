---
name: brainstorming
description: "Use when the user wants to explore or shape an idea before building it - a new feature, component or behavior change whose intent, scope or approach is not yet settled. Explores user intent, requirements and design before implementation."
argument-hint: "[$idea]"
---

# Brainstorming Ideas Into Designs

**Arguments:** "$ARGUMENTS"

Turn an idea into a settled intent and a chosen approach through dialogue with the user.

This skill runs two ways:

- **Standalone (`/brainstorming`).** Follow the whole file and finish with a written design.
- **Inside `/loom`.** The brainstorm-agent preloads this skill. Run "Understanding the idea" and "Exploring approaches" only, then stop: `/loom` has its own specify and architecture phases, and the phase prompt says how to ask and where to write. The sections marked *standalone only* do not apply.

## Understanding the idea

- Look at the current project state first: files, docs, recent commits.
- Ask questions one at a time to refine the idea. One question per message; if a topic needs more, ask a follow-up.
- Prefer multiple choice; open-ended is fine when the options are not knowable.
- Aim to understand purpose, constraints and success criteria.

## Exploring approaches

- Propose 2-3 different approaches with their trade-offs.
- Lead with the one you recommend and say why.
- Remove features the idea does not need (YAGNI).

## Presenting the design (standalone only)

- Once you understand what is being built, present the design in sections of 200-300 words.
- After each section, ask whether it looks right so far, and go back when something does not.
- Cover architecture, components, data flow, error handling and testing.

## After the design (standalone only)

- Write the validated design to `docs/plans/YYYY-MM-DD-<topic>-design.md` and commit it.
- Ask: "Ready to set up for implementation?" If yes, use `/loom`. It runs its own brainstorm, specify and clarify phases from the same description; pass `--skip-brainstorm` when this session already settled the approach.
