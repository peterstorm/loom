---
description: "Review PR, adjudicate critical findings, plan fixes, implement, commit and push"
argument-hint: "[code|errors|tests|types|comments|architecture|simplify|all] [--files f1,f2] [--no-push] [--dry-run] [--commit-msg '...']"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Write", "Edit", "Task", "Agent"]
---

# Review and Fix

**Arguments:** "$ARGUMENTS"

Read `${CLAUDE_PLUGIN_ROOT}/skills/review-and-fix/SKILL.md` completely and run
that workflow with these arguments. The skill is the only description of the
workflow; do not improvise a second one from this file.
