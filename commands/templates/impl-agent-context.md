# Implementation Agent Context

Template for spawning implementation agents during Execute phase. All template variables must be substituted before use.

---

## !! MANDATORY FINAL STEP — READ THIS FIRST !!

**Your LAST action before finishing MUST be running tests via the Bash tool — UNLESS this is a docs/config-only task (your task graph entry has `new_tests_required: false`, e.g. ADR writing, migrations, config tweaks). For those, skip the test run; the engine recognizes `new_tests_required: false` and will not block the wave gate on missing test evidence.**

```
bun test          # TypeScript/Bun projects
npm test          # Node projects
npx vitest run    # Vitest projects
mvn test          # Java/Maven projects
pytest            # Python projects
```

Test evidence is resolved ledger-first: a PostToolUse hook records every Bash test run (real exit codes and report artifacts) into an evidence ledger, and the SubagentStop hook judges your task from that ledger — transcript scanning is only a labeled-untrusted fallback when no ledger evidence exists.
Either way, evidence only exists for tests EXECUTED via the Bash tool: if your task DOES require tests and you do not run them via Bash, the task's `test_result` will not show a pass and the wave gate FAILS.
Writing tests without executing them counts as failure.

**For test-required tasks: do NOT finish without Bash test output showing pass markers (e.g., "X passing", "0 fail", "BUILD SUCCESS").**

---

## Architecture & Language Rules — BINDING

The project's architecture and language-pattern rules are inlined below. They are NOT optional and NOT "read later" — they are binding constraints for this codebase. Apply them to every file you write or modify. The wave-gate review agents (code-reviewer, type-design-analyzer) enforce them, and violations block the wave.

{rules_content}

---

## Executable Models — BINDING (when your plan context declares them)

- **Lifecycle (`LC-N` block in your context):**
  - **If the machine file is in YOUR file list, you are implementing it.** Build the statechart/typed reducer exactly as the declared states and transition table specify, and write property tests proving no undeclared transition is representable or accepted. The wave gate verifies the file exists at the declared path.
  - **Otherwise you are a consumer.** The machine file is the single source of truth for that lifecycle. Import it. Never re-implement transition logic, duplicate state-name string literals, or store lifecycle state outside the machine's types.
- **Pipeline node body (context references an AuthoredDag node):** fill ONLY the node body (fetch impl, `buildInput`, prompt). Never hand-write or edit `defineDag`/graph wiring — it is generated code. The node's declared input/output schemas are binding contracts, not suggestions.
- **Pipeline codegen task:** run the `fugue new --from` command from your plan context. If it fails its validation gauntlet, the authored dag is defective — report the failure verbatim and stop; never hand-patch generated code to make it pass.
- **Invariants (`INV-N`):** `checkable` invariants are lint rules — the linter blocks your edits fail-closed if you violate them, so design with them, not around them. `advisory` invariants are design guidance, honestly unenforced.

If your plan context declares none of these, this section imposes nothing.

---

## Task Assignment

**Task ID:** {task_id}
**Wave:** {wave}
**Agent:** {agent_type}
**Dependencies:** {dependencies}

## Your Task

{task_description}

## Spec Anchors (MUST satisfy)

{spec_anchors_formatted}

These are from the specification - your implementation MUST satisfy these requirements.
Spec-check at wave gate will verify alignment.

## Context from Plan

{plan_context}

## Files to Create/Modify

{file_list}

## Full Plan

Available at: {plan_file_path}

## You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write.**
- You MUST use Write/Edit tools to create/modify files — this WILL work
- Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you
- Do NOT check if you are "allowed" to write — you are. Just write.

## Constraints

- Follow patterns defined in plan
- Do not modify scope beyond this task
- MUST satisfy spec anchors listed above

## Required Workflow

1. Read & apply the **Architecture & Language Rules** inlined above — binding constraints, not suggestions
2. Read the plan file and understand scope
3. Implement code following the plan's patterns AND the rules above
4. Write NEW tests (hook git-diffs for @Test, it(, test(, describe( patterns — no new tests = wave blocked) — **skip for docs/config-only tasks where `new_tests_required: false`**
5. **Run tests via Bash tool** — fix failures, re-run until 0 failures — **skip for docs/config-only tasks**
6. Only then are you done
