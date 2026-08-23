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
| java-test-agent | add missing tests to EXISTING Java code only |
| ts-test-agent | add missing tests to EXISTING TypeScript code only |
| security-agent | security, auth, jwt, oauth, vulnerability |
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
4. **Verification policy** — emit `verification_policy` with independent requirements:
   - New behavior: `regression: required`, `new_tests: required`.
   - Refactor, rename, config, schema, migration, interface update: keep `regression: required`; waive only `new_tests` with `existing-tests-sufficient` when existing coverage is genuinely sufficient.
   - Docs/ADR-only: waive both with `documentation-only`.
   - Deterministic generated artifacts: waive both with `generated-artifact`.
5. **Wave scheduling:**
   - Wave 1: Tasks with no dependencies (run parallel)
   - Wave 2: Tasks depending on Wave 1
   - Wave N: Tasks depending on Wave N-1
   - Dependencies MUST be in earlier waves
6. **ADR tasks:** For each `### AD-N: <Title>` block in plan.md's `## Architectural Decisions` section, create exactly one task:
   - `agent`: `adr-writer-agent`
   - `wave`: `(max wave used by impl tasks) + 1` — ADRs run in a dedicated final wave AFTER all impl waves so they can document what actually shipped. Rule 5 requires dependencies be in earlier waves; ADRs depend on all impl tasks, so they cannot share a wave with any of them.
   - `depends_on`: all impl task IDs from prior waves (convention — not enforced by `validate-task-graph`; the wave-ordering rule is what gates execution)
   - `verification_policy`: both regression and new tests waived with `documentation-only`
   - `plan_context`: the full AD-N block text (Choice / Why / Rejected verbatim)
   - `file_list`: `["docs/adr/<NNNN>-<slug>.md"]` where:
     - `<NNNN>` = pre-allocated. Read existing `docs/adr/` (use Glob/Read), find max 4-digit prefix, increment for first AD, then sequential for subsequent ADs in plan order. If no ADRs exist, start at `0001`.
     - `<slug>` = kebab-case from AD title (e.g., "Hono framework choice" → `hono-framework-choice`). Append `-2`, `-3` etc. on title collision within this run.
   - `description`: `"Write ADR-<NNNN>: <AD title>"`
   - `spec_anchors`: only requirements this final ADR Wave fully completes (normally empty `[]`)
   - `spec_contributions`: normally empty `[]` because this dedicated final Wave occurs after implementation completion; use only when the Spec explicitly makes the ADR precursor work for a Requirement completed in this same final Wave

   Skip ADR task creation if plan has no `## Architectural Decisions` section or it's empty.
7. **Lifecycle tasks:** For each `### LC-N:` block in the plan's `## Lifecycles` section (skip rule if section absent):
   - Create exactly one task that implements the declared `**Machine file:**` — the statechart/typed reducer plus its tests.
   - `agent`: `code-implementer-agent`, `verification_policy`: regression and new tests both required
   - `wave`: the earliest wave possible (usually 1) — the machine is a foundation.
   - `file_list`: MUST include the `**Machine file:**` path exactly as declared (plus its test file). The validator's tolerance is a one-directional suffix match: a task path counts when it equals the declared path or ends with `/<declared path>` (after `./` normalization) — so any deeper or absolute prefix on the task path is accepted. The reverse never holds: a shallower task path never satisfies a deeper declared path, a bare basename never satisfies a pathed declaration, and a declared path with no directory segment matches only exactly. Validation fails if no task's `file_list` contains it.
   - `plan_context`: the full LC-N block verbatim (states + transition table), PLUS this line so the implementing agent sees the test bar: `You are implementing this machine. Write property tests proving no undeclared transition is representable or accepted.`
   - Every other task that touches this lifecycle: add the machine task to its `depends_on` (later wave), and prepend the LC-N block to its `plan_context` with the line: `The lifecycle machine at <machine file path> is the single source of truth — import it; never re-implement transitions or duplicate state literals.`
8. **Pipeline tasks:** If the plan has a `## Pipeline` section with an `**AuthoredDag:**` path (skip rule if absent):
   - Read the AuthoredDag JSON file.
   - Create one wave-1 codegen task — description: `Pipeline codegen: run 'fugue new --from <dag path>' to generate the graph code` — `agent`: `code-implementer-agent`, `verification_policy`: regression and new tests both waived with `generated-artifact` (deterministic codegen, no hand-written code). `file_list`: the generated output paths if the dag declares them, else `[]`. `plan_context`: the AuthoredDag path plus this failure protocol: `If 'fugue new --from' fails its validation gauntlet, the authored dag itself is defective — report the failure verbatim and stop. Never hand-patch generated graph code to make it pass.`
   - Create one task per node needing a real body (fetch impls, `buildInput`, prompts), depending on the codegen task, with regression and new tests both required in `verification_policy`. `plan_context` MUST include the node's purpose and declared input/output schemas from the AuthoredDag, plus the line: `Fill only the node body. Never hand-write or edit defineDag/graph wiring — it is generated. The declared schemas are binding contracts.`
9. **Invariant tasks: none.** Checkable `INV-N` invariants are already lint rules enforced on every edit — do NOT create tasks for them. For tasks working in files an invariant governs, you may append the INV-N statement to `plan_context`. Advisory invariants may be quoted as guidance; never present them as enforced.
10. **Requirement trace v2 (binding):**
    - Emit top-level `spec_trace_version: 2` and BOTH trace arrays on every Task.
    - `spec_contributions` records partial work only. It is traceability, never Wave Gate completion scope.
    - `spec_anchors` is a Requirement Completion Claim: the containing Wave MUST fully satisfy that Requirement. Assign it only to the culminating Task/Wave.
    - A Task cannot contribute to and complete the same Requirement. Multiple completion Tasks are allowed only in the same culmination Wave.
    - Every contribution must have exactly one completion Wave at or after it; no contribution may appear after completion.

---

## Required Output

Output ONLY valid JSON. No markdown, no explanation, no code fences. Pure JSON:

```json
{
  "spec_trace_version": 2,
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
      "spec_contributions": [],
      "verification_policy": {
        "regression": { "kind": "required" },
        "new_tests": { "kind": "required" }
      },
      "plan_context": "Relevant section from plan (paste key points)",
      "file_list": ["src/models/User.ts", "src/models/User.test.ts"]
    }
  ]
}
```

### Top-Level Fields

| Field | Required | Format | Notes |
|---|---|---|---|
| `spec_trace_version` | yes | literal `2` | Fresh decomposition trace contract |
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
| `spec_anchors` | yes | string[] | Requirement Completion Claims fully satisfied by this Wave (can be empty `[]`) |
| `spec_contributions` | yes | string[] | Partial Requirement Contributions; never completion scope (can be empty `[]`) |
| `verification_policy` | yes | object | Independent `regression` and `new_tests` required/waived variants with typed waiver reasons |
| `plan_context` | yes | string | Key points from plan for this task (can be empty `""`) |
| `file_list` | yes | string[] | Files to create/modify (can be empty `[]`) |
