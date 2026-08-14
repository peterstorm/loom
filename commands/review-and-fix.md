---
description: "Review PR, adjudicate critical findings, plan fixes, implement, commit and push"
argument-hint: "[code|errors|tests|types|comments|architecture|simplify|all] [--files f1,f2] [--no-push] [--dry-run] [--commit-msg '...']"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Write", "Edit", "Task", "Agent"]
---

# Review and Fix — Adjudicated End-to-End Remediation

**Arguments:** "$ARGUMENTS"

Read `${CLAUDE_PLUGIN_ROOT}/skills/review-and-fix/SKILL.md` completely and execute
that canonical workflow with these arguments. Do not reproduce or improvise a
second workflow from this command file.

In particular:

- create a fresh Standalone Review Run;
- aggregate every selected reviewer's raw transcript through
  `helper standalone-review aggregate`;
- when canonical critical findings exist, run the complete Refutation Panel
  (`brief --standalone` → `manifest` → `lenses` → Panel Program verifier batch
  → `verdict` → `tally`); the tally atomically publishes `result.json`;
- for a zero-critical run, run `helper standalone-review finalize`; otherwise
  use the tally-authored result, always plan/fix every
  `result.json.surviving_critical_findings`, and autonomously decide which
  advisories to accept by default;
- retain and report every `refuted_critical_findings` entry with its evidence;
- disposition every advisory as accepted, deferred, or dismissed with a reason;
  do not ask the user to choose advisory IDs unless the user explicitly requests
  control of a specific advisory;
- stop before editing on any evidence or panel failure;
- for `--dry-run`, stop after adjudication and the remediation plan.
