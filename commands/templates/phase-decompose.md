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

1. **Impl tasks include tests.** Do NOT create separate test tasks for new code. `code-implementer-agent` and `frontend-agent` write both impl AND tests. Separate test tasks cause deadlocks. The one exception is a plan Contract's contract task (Rule 12): it writes acceptance tests that later tasks turn green, by design.
2. **Test-only agent** (`ts-test-agent`): only for adding tests to EXISTING code lacking coverage.
3. **Sizing** — decompose further if:
   - Task touches >5 files
   - Multiple unrelated concerns in one task
   - Description needs "and" to explain
4. **Verification policy** — emit `verification_policy` with independent requirements. The discriminated union shape is binding: each requirement is exactly `{"kind": "required"}` or `{"kind": "waived", "reason": "<reason>"}` with exact keys — never the `{"required": true}` / `{"waived": "..."}` spelling:
   - New behavior: `{"regression":{"kind":"required"},"new_tests":{"kind":"required"}}`.
   - Refactor, rename, config, schema, migration, interface update: `{"regression":{"kind":"required"},"new_tests":{"kind":"waived","reason":"existing-tests-sufficient"}}` when existing coverage is genuinely sufficient.
   - Docs/ADR-only: `{"regression":{"kind":"waived","reason":"documentation-only"},"new_tests":{"kind":"waived","reason":"documentation-only"}}`.
   - Deterministic generated artifacts: `{"regression":{"kind":"waived","reason":"generated-artifact"},"new_tests":{"kind":"waived","reason":"generated-artifact"}}`.
   Authored payloads may not claim the waiver reason `legacy-new-tests-required-false` (migration provenance — the engine rejects it).
5. **Wave scheduling:**
   - Wave 1: Tasks with no dependencies (run parallel)
   - Wave 2: Tasks depending on Wave 1
   - Wave N: Tasks depending on Wave N-1
   - Dependencies MUST be in earlier waves
6. **ADR tasks:** For each `### AD-N: <Title>` block in plan.md's `## Architectural Decisions` section, create exactly one task:
   - `agent`: `adr-writer-agent`
   - `wave`: `(max wave used by impl tasks) + 1` — ADRs run in a dedicated final wave AFTER all impl waves so they can document what actually shipped. Rule 5 requires dependencies be in earlier waves; ADRs depend on all impl tasks, so they cannot share a wave with any of them.
   - `depends_on`: all impl task IDs from prior waves (convention — not enforced by `validate-task-graph`; the wave-ordering rule is what gates execution)
   - `verification_policy`: `{"regression":{"kind":"waived","reason":"documentation-only"},"new_tests":{"kind":"waived","reason":"documentation-only"}}` (exact union shape — Rule 4)
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
   - `agent`: `code-implementer-agent`, `verification_policy`: `{"regression":{"kind":"required"},"new_tests":{"kind":"required"}}` (exact union shape — Rule 4)
   - `wave`: the earliest wave possible (usually 1) — the machine is a foundation.
   - `file_list`: MUST include the `**Machine file:**` path exactly as declared (plus its test file). The validator's tolerance is a one-directional suffix match: a task path counts when it equals the declared path or ends with `/<declared path>` (after `./` normalization) — so any deeper or absolute prefix on the task path is accepted. The reverse never holds: a shallower task path never satisfies a deeper declared path, a bare basename never satisfies a pathed declaration, and a declared path with no directory segment matches only exactly. Validation fails if no task's `file_list` contains it.
   - `plan_context`: the full LC-N block verbatim (states + transition table), PLUS this line so the implementing agent sees the test bar: `You are implementing this machine. Write property tests proving no undeclared transition is representable or accepted.`
   - Every other task that touches this lifecycle: add the machine task to its `depends_on` (later wave), and prepend the LC-N block to its `plan_context` with the line: `The lifecycle machine at <machine file path> is the single source of truth — import it; never re-implement transitions or duplicate state literals.`
8. **Pipeline tasks:** If the plan has a `## Pipeline` section with an `**AuthoredDag:**` path (skip rule if absent):
   - Read the AuthoredDag JSON file.
   - Create one wave-1 codegen task — description: `Pipeline codegen: run 'fugue new --from <dag path>' to generate the graph code` — `agent`: `code-implementer-agent`, `verification_policy`: `{"regression":{"kind":"waived","reason":"generated-artifact"},"new_tests":{"kind":"waived","reason":"generated-artifact"}}` (deterministic codegen, no hand-written code; exact union shape — Rule 4). `file_list`: the generated output paths if the dag declares them, else `[]`. `plan_context`: the AuthoredDag path plus this failure protocol: `If 'fugue new --from' fails its validation gauntlet, the authored dag itself is defective — report the failure verbatim and stop. Never hand-patch generated graph code to make it pass.`
   - Create one task per node needing a real body (fetch impls, `buildInput`, prompts), depending on the codegen task, with `verification_policy` `{"regression":{"kind":"required"},"new_tests":{"kind":"required"}}` (exact union shape — Rule 4). `plan_context` MUST include the node's purpose and declared input/output schemas from the AuthoredDag, plus the line: `Fill only the node body. Never hand-write or edit defineDag/graph wiring — it is generated. The declared schemas are binding contracts.`
9. **Invariant tasks: none — but owned families shape the graph.** Checkable `INV-N` invariants are already lint rules enforced on every edit — do NOT create tasks for them. For each OWNED invariant (`**Owner module:**` is a path):
   - Every task whose `file_list` includes a `**Sibling entry points:**` path must depend (directly or transitively) on the task whose `file_list` includes the `**Owner module:**`, whenever a task builds the owner. The owner exists before its callers.
   - Whenever any task's `file_list` includes the owner or a sibling, some task's `file_list` must include the `**Matrix test:**` path.
   - Do NOT copy invariant text into `plan_context`: the engine renders each Task's ownership role (owner, sibling, matrix-test author) and the whole family into its brief from the plan itself. Advisory invariants are never presented as enforced.

   Validation refuses a graph that breaks either rule, and refuses a declared path that neither exists nor is in any task's `file_list`.
10. **Requirement trace v2 (binding):**
    - Emit top-level `spec_trace_version: 2` and BOTH trace arrays on every Task.
    - `spec_contributions` records partial work only. It is traceability, never Wave Gate completion scope.
    - `spec_anchors` is a Requirement Completion Claim: the containing Wave MUST fully satisfy that Requirement. Assign it only to the culminating Task/Wave.
    - A Task cannot contribute to and complete the same Requirement. Multiple completion Tasks are allowed only in the same culmination Wave.
    - Every contribution must have exactly one completion Wave at or after it; no contribution may appear after completion.
    - Both arrays name only `FR-NNN` and `AS-NNN` ids the spec defines. Non-functional requirements, success criteria (`NFR-`, `SC-`) and Out-of-Scope entries cannot be claimed or contributed to; population refuses any id the Spec Index does not define as a completable entry, and refuses a spec that does not parse as canonical.
11. **Protected verification paths:** Decompose NEVER assigns the operator manifest `.loom/verification-manifest.json` or any engine report path beneath `.loom/completion-reports/` to a Task's `file_list`. These paths are engine/operator-owned, not implementation artifacts. This rule does not prohibit unrelated `.loom/` paths.
12. **Contract tasks (contracts before code):** For each `### CT-N:` block in the plan's `## Contracts` section (skip rule if section absent):
    - Create exactly one **contract task** in an early wave, before any task that completes a Requirement the contract's acceptance files list. `agent`: `code-implementer-agent`; `verification_policy`: `{"regression":{"kind":"required"},"new_tests":{"kind":"required"}}`.
    - Its `file_list` MUST include every frozen path: the `**Types file:**` (unless `none`) and every `**Acceptance tests:**` path, exactly as declared — plus the stub files the acceptance tests import. No other task may list a frozen path: the contract task is their only writer.
    - It lists the covered Requirements in `spec_contributions`, never in `spec_anchors`: it writes the tests, it does not satisfy them. Its wave gate passes only when every acceptance testcase is collected and FAILS.
    - When the contract declares an `**Entry point:**`, a task claiming a covered Requirement MUST write that file or depend, directly or transitively, on a task other than the contract task that does: its acceptance tests reach the code through it, so they cannot pass earlier. Put the claim on the task that builds the entry point, or on one after it.
    - Each task completing a covered Requirement (that Requirement in its `spec_anchors`) MUST depend, directly or transitively, on the contract task. Its tests are the frozen acceptance tests, so it MAY waive new tests: `"new_tests":{"kind":"waived","reason":"covered-by-acceptance-contract"}` — only when it claims a covered Requirement of a contract it depends on, and only when the frozen tests cover everything it adds.
    - Do NOT copy the contract into `plan_context`: the engine renders each task's role (contract task, claimant, or a task running beside not-yet-green acceptance tests) into its brief from the plan and the freeze.
    - Never author the regression waiver `acceptance-red-window`. The engine stamps it on every task from the contract wave through the last wave completing a covered Requirement that does not already carry its own regression waiver (an authored `documentation-only` or `generated-artifact` waiver is kept), because those tasks' full-suite runs see pending acceptance tests fail; the Wave Gate's suite is their regression authority.

    Validation refuses a contract no single task writes, a frozen path written by any other task, a contract task claiming a covered Requirement, a covered Requirement no task claims, a claimant that does not depend on the contract task, a claimant that neither writes the declared entry point nor waits for its writer, and a misused `covered-by-acceptance-contract` waiver. Population also refuses contracts unless `.loom/verification-manifest.json` has a project check writing a JUnit report (`"report": {"kind": "required-file", ...}`): RED and GREEN are observed only through that report.

---

## Required Output

Output ONLY valid JSON. No markdown, no explanation, no code fences. Pure JSON.

**TRANSPORT CONTRACT (binding):** your entire final message must be exactly ONE physical line of pure JSON — no newline characters anywhere inside the JSON, no markdown fences, no prose before or after. Multi-line final messages are silently dropped by the agent transport: the orchestrator receives no output and the run is lost. Single-line output returns even at ~100KB, so emit a long graph as one line anyway. (The shape example below is pretty-printed for readability; your emitted graph must be one physical line.)

```json
{
  "spec_trace_version": 2,
  "plan_title": "Short title for GH issue",
  "spec_file": "ABSOLUTE_SPEC_FILE_PATH",
  "plan_file": "ABSOLUTE_PLAN_FILE_PATH",
  "tasks": [
    {
      "id": "T1",
      "description": "What to implement (imperative)",
      "agent": "code-implementer-agent",
      "wave": 1,
      "depends_on": [],
      "spec_anchors": ["FR-001", "AS-001"],
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
| `verification_policy` | yes | object | Exact union shape per Rule 4: each requirement is `{"kind": "required"}` or `{"kind": "waived", "reason": "<typed reason>"}`; typed reasons are `existing-tests-sufficient`, `documentation-only`, `generated-artifact`, and (new tests only, Rule 12) `covered-by-acceptance-contract` |
| `plan_context` | yes | string | Key points from plan for this task (can be empty `""`) |
| `file_list` | yes | string[] | Files to create/modify (can be empty `[]`) |
