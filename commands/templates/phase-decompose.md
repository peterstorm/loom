# Decompose Phase Context

Template for spawning decompose-agent. All template variables must be substituted before use.

---

## Decompose: {feature_description}

**Spec:** {spec_file_path}
**Plan:** {plan_file_path}

Read the spec and the plan, then decompose the plan into a parallel task graph. You write no files. Do not read `.claude/hooks/` or `.claude/state/`.

---

## Available Agents

| Agent (subagent_type) | Use When |
|---|---|
| code-implementer-agent | implement, create, build, add, write code, model — **writes tests too** |
| java-test-agent | add missing tests to EXISTING Java code only |
| ts-test-agent | add missing tests to EXISTING TypeScript code only |
| security-agent | security, auth, jwt, oauth, vulnerability |
| frontend-agent | frontend, ui, react, next.js, component — **writes tests too** |
| adr-writer-agent | write a single ADR document, for the tasks that expand plan AD-N entries (one task per AD) |

Use only these agents; validation rejects any other name. Never assign `distill-agent`: the engine adds each Wave's distill pass itself at population, and a payload Task naming it is refused.

---

## Decompose Rules

1. **Impl tasks include tests.** `code-implementer-agent` and `frontend-agent` write both implementation and tests. Do not create a separate test task for new code; it deadlocks. The one exception is a plan Contract's contract task (rule 12), which writes acceptance tests that later tasks turn green.
2. **Test-only agents** (`ts-test-agent`, `java-test-agent`): only for adding tests to EXISTING code that lacks coverage.
3. **Sizing.** Decompose further when a task touches more than 5 files, mixes unrelated concerns, or needs "and" to describe.
4. **Verification policy.** Every task carries a `verification_policy` with two independent arms. Each arm is exactly `{"kind": "required"}` or `{"kind": "waived", "reason": "<typed reason>"}`; never `{"required": true}` or `{"waived": "..."}`. The other rules name these four policies:
   - **required / required** (new behavior): `{"regression":{"kind":"required"},"new_tests":{"kind":"required"}}`
   - **existing-tests-sufficient** (refactor, rename, config, schema, migration or interface update whose existing coverage is sufficient): `{"regression":{"kind":"required"},"new_tests":{"kind":"waived","reason":"existing-tests-sufficient"}}`
   - **documentation-only** (docs, ADRs): `{"regression":{"kind":"waived","reason":"documentation-only"},"new_tests":{"kind":"waived","reason":"documentation-only"}}`
   - **generated-artifact** (deterministic generated output): `{"regression":{"kind":"waived","reason":"generated-artifact"},"new_tests":{"kind":"waived","reason":"generated-artifact"}}`

   The typed reasons are `existing-tests-sufficient`, `documentation-only`, `generated-artifact` and, for `new_tests` only, `covered-by-acceptance-contract` (rule 12). Never author `legacy-new-tests-required-false` or `acceptance-red-window`; the engine rejects the first and stamps the second itself.
5. **Wave scheduling.** Wave 1 holds tasks with no dependencies; wave N holds tasks depending on earlier waves. A dependency is always in an earlier wave. Tasks in one wave run in parallel.
6. **ADR tasks.** For each `### AD-N: <Title>` block in the plan's `## Architectural Decisions` (skip the rule when the section is absent or empty), create exactly one task:
   - `agent`: `adr-writer-agent`
   - `wave`: the highest implementation wave plus 1. ADRs run in their own final wave so they document what shipped.
   - `depends_on`: every implementation task id
   - `verification_policy`: documentation-only
   - `plan_context`: the full AD-N block (Choice / Why / Rejected, verbatim)
   - `file_list`: one path under `docs/adr/` that follows the existing filename convention there. Read the directory (Glob), find the highest number in use, and continue the sequence in plan order with the same prefix, zero-padding and kebab-case slug style as the existing files. If the directory has no ADRs, use `docs/adr/0001-<slug>.md`. The slug comes from the AD title ("Hono framework choice" → `hono-framework-choice`); append `-2`, `-3` on a collision within this run.
   - `description`: `"Write ADR-<number>: <AD title>"`
   - `spec_anchors` and `spec_contributions`: normally `[]`. Claim or contribute only when the spec itself makes the ADR part of a Requirement completed in this final wave.
7. **Lifecycle tasks.** For each `### LC-N:` block in the plan's `## Lifecycles` (skip when absent):
   - Create exactly one task that implements the declared `**Machine file:**` (the statechart or typed reducer, plus its tests): `code-implementer-agent`, policy required / required, in the earliest possible wave (usually 1).
   - `file_list` includes the `**Machine file:**` path exactly as declared, plus its test file. A task path matches a declared path when it equals it or ends with `/<declared path>` (after `./` normalization): a deeper or absolute prefix on the task path is fine; a shallower path or a bare basename never matches a pathed declaration; a declaration with no directory segment matches only exactly.
   - `plan_context`: the full LC-N block verbatim, plus the line `You are implementing this machine. Write property tests proving no undeclared transition is representable or accepted.`
   - Every other task touching the lifecycle depends on the machine task (so it sits in a later wave) and has the LC-N block prepended to its `plan_context` with the line `The lifecycle machine at <machine file path> is the single source of truth — import it; never re-implement transitions or duplicate state literals.`
8. **Pipeline tasks.** If the plan has a `## Pipeline` section with an `**AuthoredDag:**` path (skip when absent), read the AuthoredDag JSON, then:
   - Create one wave-1 codegen task: `code-implementer-agent`, policy generated-artifact, description `Pipeline codegen: run 'fugue new --from <dag path>' to generate the graph code`. `file_list` is the generated output paths if the dag declares them, else `[]`. `plan_context` is the AuthoredDag path plus `If 'fugue new --from' fails its validation gauntlet, the authored dag itself is defective — report the failure verbatim and stop. Never hand-patch generated graph code to make it pass.`
   - Create one task per node that needs a real body (fetch implementations, `buildInput`, prompts), depending on the codegen task, policy required / required. Its `plan_context` includes the node's purpose and its declared input and output schemas from the AuthoredDag, plus `Fill only the node body. Never hand-write or edit defineDag/graph wiring — it is generated. The declared schemas are binding contracts.`
9. **Invariants create no tasks, but an owned family shapes the graph.** Checkable `INV-N` invariants are already lint rules. For each owned invariant (its `**Owner module:**` is a path):
   - Every task whose `file_list` includes a `**Sibling entry points:**` path depends, directly or transitively, on the task whose `file_list` includes the owner, whenever a task builds the owner.
   - Whenever a task's `file_list` includes the owner or a sibling, some task's `file_list` includes the `**Matrix test:**` path. Put that matrix-test change in the same wave as the owner or sibling change it covers: the Wave Gate judges the matrix test as that wave leaves it. Say in that task's description that the matrix test imports every sibling and covers the owner's changed lines.
   - Do not copy invariant text into `plan_context`. The engine renders each task's ownership role and duties into its brief from the plan.

   Validation refuses a sibling task that does not depend on the owner's task, a family change with no matrix-test task, and a declared path that neither exists nor is in any task's `file_list`. Population refuses a plan with a non-exempt owned invariant unless the verification manifest has an `affectedRunner`; do not work around that in the graph.
10. **Requirement trace v2 (binding):**
    - Emit top-level `spec_trace_version: 2` and BOTH trace arrays on every Task.
    - `spec_contributions` records partial work only. It is traceability, never Wave Gate completion scope.
    - `spec_anchors` is a Requirement Completion Claim: the containing Wave MUST fully satisfy that Requirement. Assign it only to the culminating Task/Wave.
    - A Task cannot contribute to and complete the same Requirement. Multiple completion Tasks are allowed only in the same culmination Wave.
    - Every contribution must have exactly one completion Wave at or after it; no contribution may appear after completion.
    - Both arrays name only `FR-NNN` and `AS-NNN` ids the spec defines. Non-functional requirements, success criteria (`NFR-`, `SC-`) and Out-of-Scope entries cannot be claimed or contributed to; population refuses any id the Spec Index does not define as a completable entry, and refuses a spec that does not parse as canonical.
11. **Protected verification paths:** Decompose NEVER assigns the operator manifest `.loom/verification-manifest.json` or any engine report path beneath `.loom/completion-reports/` to a Task's `file_list`. These paths are engine/operator-owned, not implementation artifacts. This rule does not prohibit unrelated `.loom/` paths.
12. **Contract tasks.** For each `### CT-N:` block in the plan's `## Contracts` (skip when absent):
    - Create exactly one **contract task**: `code-implementer-agent`, policy required / required, in an early wave, before any task that completes a Requirement the contract's acceptance files list.
    - Its `file_list` includes every frozen path, exactly as declared: the `**Types file:**` (unless `none`) and every `**Acceptance tests:**` path. No other task lists a frozen path.
    - **The engine writes the contract stubs; the contract task never writes a stub.** A bound path never goes in the contract task's `file_list`.
    - **Export bindings.** The plan's `## File Structure` carries `**Export bindings:**` lines, one file per line and one contract per file. Put each bound path in the `file_list` of exactly one non-contract task, the one that implements it, and make that task depend, directly or transitively, on the contract task of the binding's CT. That task may not waive regression as `documentation-only` or `generated-artifact`. If a task's `plan_context` mentions its bindings, copy the `**Export bindings:**` lines verbatim; the engine stamps them from the plan and refuses a brief that drifted.
    - **Frozen ADTs.** A type the contract's types file declares is a frozen ADT. Never plan a task that adds its own copy of one.
    - The contract task lists the covered Requirements in `spec_contributions`, never in `spec_anchors`: it writes the tests, it does not satisfy them.
    - Each task completing a covered Requirement (that Requirement in its `spec_anchors`) depends, directly or transitively, on the contract task. When the contract declares an `**Entry point:**`, that task also writes the entry-point file or depends on a task other than the contract task that does; put the claim on the task that builds the entry point, or on one after it.
    - Such a task may waive new tests with `"new_tests":{"kind":"waived","reason":"covered-by-acceptance-contract"}`, but only when it claims a covered Requirement of a contract it depends on and the frozen tests cover everything it adds.
    - Do not copy the contract into `plan_context`. The engine renders each task's role into its brief.

    Validation refuses a contract no single task writes, a frozen path written by any other task, a bound path on the contract task, a bound path no non-contract task lists, a holder that does not depend on the contract task, a bound path on a task with a `documentation-only` or `generated-artifact` regression waiver, a contract task claiming a covered Requirement, a covered Requirement no task claims, a claimant that does not depend on the contract task, a claimant that neither writes the declared entry point nor waits for its writer, and a misused `covered-by-acceptance-contract` waiver.

---

## Required Output

Your entire final message is exactly ONE physical line of pure JSON: no newline characters anywhere inside it, no markdown fences, no prose before or after. A multi-line final message is dropped by the agent transport and the run is lost. Single-line output returns even at about 100KB, so emit a long graph as one line too. The shape example below is pretty-printed only for reading.

In your output, replace `ABSOLUTE_SPEC_FILE_PATH` and `ABSOLUTE_PLAN_FILE_PATH` with the absolute spec and plan paths given at the top of this prompt.

<!-- wire-example: decompose-task-graph -->
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
| `verification_policy` | yes | object | One of the policies of rule 4, or a rule 12 new-tests waiver |
| `plan_context` | yes | string | Key points from plan for this task (can be empty `""`) |
| `file_list` | yes | string[] | Files to create/modify (can be empty `[]`) |
