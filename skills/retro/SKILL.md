---
name: retro
version: "1.0.0"
description: "Retrospective of a Loom Wave, a whole Loom run, or any session: engine-recorded friction first, then root-cause findings fixed at the right layer. Use when status suggests /retro, before complete-orchestration, or when the user asks to step back."
---

# Retro

A retrospective improves the agent's **environment**, not just the code: what it can find, what checks catch
its mistakes, what it is told, and how cheaply it can act. Each finding names a root cause and the layer that
fixes it, so the same failure does not come back in another shape (ADR-0083).

**Arguments:** `[--wave <N>]` for one Wave of a Loom run; none for the whole run, or for a session outside Loom.

## 1. Gather the facts before the story

**Inside a Loom run** (a TaskGraph exists), read what the engine recorded first:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" helper retro-facts [--wave <N>]
```

It prints, per Wave, the gate runs, reopenings, plan edits (added and withdrawn Tasks included), legacy Forward Fixes, retries, escalations, remediations,
Finding counts and the Tasks with friction and their failure kinds, plus which Waves crossed a retro threshold.
After `complete-orchestration` the live graph is gone; pass `--graph <archived completed_task_graph-*.json>`.

Then read the **why** behind each fact, and only then:

- the session transcript around each escalation, reopening and plan edit;
- the run directories under `.claude/reviews/` for Review Run retries and refused reviewer payloads;
- the operator notes and reasons the audits carry (`retro-facts` names the Tasks; the State File holds the reasons).

**Outside a Loom run**, the facts are the session itself: commands that failed or were retried, corrections the
user made, tools that were slow or wasteful, instructions that were wrong or ignored.

Every fact that cost time must be explained. A fact you cannot explain is itself a finding (missing information).

## 2. Find root causes, not instances

Group facts into failures. For each one write a finding with all four parts:

- **Evidence:** facts with ids: Task ids, receipt ids, run ids, commits, file paths, quoted errors.
- **Class:** the class of failure, not this instance, and every other place it appeared or would appear.
- **Prevention test:** would the proposed fix have prevented every occurrence in the class? If not, label the
  finding a **patch**, and name the root fix it defers to.
- **Fix tier**, preferred in this order:
  1. an engine invariant or a type that makes the failure unrepresentable;
  2. a deterministic check: a lint rule, a test, a CI job, population-time validation, a hook;
  3. a coding standard enforced at review (`rules/`, a reviewer's rubric);
  4. a navigation pointer (`CLAUDE.md`, `AGENTS.md`).

A **mechanical** mistake (a wrong path, a forgotten flag, a format slip) gets a deterministic check, never a
written rule: rules are read under context pressure and skipped.

Also review the environment itself:

- **Navigation:** could the agent find the right file, doc and command without searching? Missing pointers.
- **Automated checks:** which mistakes reached review, or the user, that a check could have caught?
- **Standards placement:** standards belong in review, where context pressure is lowest; `CLAUDE.md` and
  `AGENTS.md` hold pointers only. Flag steering-file bloat and instructions that change nothing (no-ops).
- **Tool economy:** repeated slow or failing commands, polling that a monitor would replace, missing helpers.
- **Information access:** facts the agent needed but could not read (a log, a run directory, an API).

## 3. Send each finding where it is fixed

- **Project findings** become changes in the project: a Loom lint rule or test, a project rule or standard, a
  `CLAUDE.md` pointer, a CI job. Present them by severity and apply the ones the user approves.
- **Loom findings** (the orchestration itself failed the run) become Loom issues. Search the open issues first
  (`gh issue list --repo <loom repo> --search "<keywords>"`): extend an issue that covers the class rather than
  opening a duplicate, and link related issues. Each issue states the evidence, the class, the root fix and the
  patches it replaces.
- Present all findings by severity: what broke the run, what cost the most time, then the rest.

## 4. Write and record the retro

Write the retro to `.claude/retros/<YYYY-MM-DD>-<slug>[-wave-<N>].md`. While a TaskGraph is live, Loom's
direct-edit guard admits exactly this: a Markdown file directly in the repository's `.claude/retros/`.

```markdown
# Retro: <run or session> [Wave N]

## Facts
<the friction digest and the facts behind each finding, with ids>

## Findings
### <severity>: <title>
- Evidence: …
- Class: …
- Prevention test: … (patch → defers to …)
- Fix tier: …
- Destination: project change | Loom issue #… | deferred (why)

## Applied
<changes made, issues opened or extended>
```

Inside a Loom run, record it so the run can complete:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" helper record-retro --file .claude/retros/<name>.md [--wave <N>]
```

`complete-orchestration` refuses until a whole-run retro is recorded. A run with nothing to learn from (a
one-Wave spike, say) may skip it, with a reason the audit keeps:

```bash
bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" helper record-retro --skip --reason "<why this run needs no retro>"
```

A whole-run retro after per-Wave ones reads them and the digests instead of redoing them, and adds what only
the whole run shows. Save the durable lessons to the user's long-term notes as well.
