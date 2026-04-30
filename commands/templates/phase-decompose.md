# Decompose Phase Context

Template for spawning decompose-agent. All template variables must be substituted before use.

---

## CRITICAL: Scope Boundaries

**You are a subagent. Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you.**
Focus ONLY on reading the spec and plan, then producing the task graph JSON.

---

## Decompose: {feature_description}

**Spec:** {spec_file_path}
**Plan:** {plan_file_path}

Read the spec and plan, then decompose into parallel task graph.

---

## Available Agents

| Agent (subagent_type) | Use When |
|---|---|
| code-implementer-agent | implement, create, build, add, write code, model — **writes tests too** |
| ts-test-agent | add missing tests to EXISTING TypeScript code only |
| security-agent | security, auth, jwt, oauth, vulnerability |
| dotfiles-agent | nix, nixos, home-manager, sops |
| frontend-agent | frontend, ui, react, next.js, component — **writes tests too** |
| adr-writer-agent | write a single ADR document — used for tasks expanding plan AD-N entries (one task per AD) |

Fallback: `general-purpose`

---

## Decompose Rules

1. **Impl tasks include tests.** Do NOT create separate test tasks for new code. `code-implementer-agent` and `frontend-agent` write both impl AND tests. Separate test tasks cause deadlocks.
2. **Test-only agent** (`ts-test-agent`): only for adding tests to EXISTING code lacking coverage.
3. **Sizing** — decompose further if:
   - Task touches >5 files
   - Multiple unrelated concerns in one task
   - Description needs "and" to explain
4. **Test requirements** — set `new_tests_required: false` for:
   - migration, config, schema, rename, bump, version, refactor, cleanup, typo, docs
   - Patterns: `→`, `->`, `interface update`
5. **Wave scheduling:**
   - Wave 1: Tasks with no dependencies (run parallel)
   - Wave 2: Tasks depending on Wave 1
   - Wave N: Tasks depending on Wave N-1
   - Dependencies MUST be in earlier waves
6. **ADR tasks:** For each `### AD-N: {Title}` block in plan.md's `## Architectural Decisions` section, create exactly one task:
   - `agent`: `adr-writer-agent`
   - `wave`: `(max wave used by impl tasks) + 1` — ADRs run in a dedicated final wave AFTER all impl waves so they can document what actually shipped. Rule 5 requires dependencies be in earlier waves; ADRs depend on all impl tasks, so they cannot share a wave with any of them.
   - `depends_on`: all impl task IDs from prior waves
   - `new_tests_required`: `false`
   - `plan_context`: the full AD-N block text (Choice / Why / Rejected verbatim)
   - `file_list`: `["docs/adr/{NNNN}-{slug}.md"]` where:
     - `{NNNN}` = pre-allocated. Read existing `docs/adr/` (use Glob/Read), find max 4-digit prefix, increment for first AD, then sequential for subsequent ADs in plan order. If no ADRs exist, start at `0001`.
     - `{slug}` = kebab-case from AD title (e.g., "Hono framework choice" → `hono-framework-choice`). Append `-2`, `-3` etc. on title collision within this run.
   - `description`: `"Write ADR-{NNNN}: {AD title}"`
   - `spec_anchors`: any FR/SC/US referenced in the AD's Why text (can be empty `[]`)

   Skip ADR task creation if plan has no `## Architectural Decisions` section or it's empty.

---

## Required Output

Output ONLY valid JSON. No markdown, no explanation, no code fences. Pure JSON:

```json
{
  "plan_title": "Short title for GH issue",
  "spec_file": "{spec_file_path}",
  "plan_file": "{plan_file_path}",
  "tasks": [
    {
      "id": "T1",
      "description": "What to implement (imperative)",
      "agent": "code-implementer-agent",
      "wave": 1,
      "depends_on": [],
      "spec_anchors": ["FR-001", "SC-001"],
      "new_tests_required": true,
      "plan_context": "Relevant section from plan (paste key points)",
      "file_list": ["src/models/User.ts", "src/models/User.test.ts"]
    }
  ]
}
```

### Top-Level Fields

| Field | Required | Format | Notes |
|---|---|---|---|
| `plan_title` | yes | string | Short title for GitHub issue |
| `spec_file` | yes | string | Absolute path to spec.md |
| `plan_file` | yes | string | Absolute path to plan.md |

### Per-Task Fields

| Field | Required | Format | Notes |
|---|---|---|---|
| `id` | yes | `T` + digits (T1, T2, ...) | Sequential |
| `description` | yes | string | Imperative, concise |
| `agent` | yes | string | Must be from agent table above |
| `wave` | yes | int >= 1 | Tasks in same wave run in parallel |
| `depends_on` | yes | string[] | Task IDs from earlier waves only |
| `spec_anchors` | yes | string[] | FR/SC/US IDs from spec (can be empty `[]`) |
| `new_tests_required` | yes | boolean | false for config/migration/docs tasks |
| `plan_context` | yes | string | Key points from plan for this task (can be empty `""`) |
| `file_list` | yes | string[] | Files to create/modify (can be empty `[]`) |
