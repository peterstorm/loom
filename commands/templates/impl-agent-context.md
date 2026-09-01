# Implementation Agent Context

Template for spawning implementation agents during Execute phase. All template variables must be substituted before use.

---

## !! MANDATORY FINAL STEP — READ THIS FIRST !!

**Your LAST action before finishing MUST be running the required regression command via the Bash tool when the Verification Policy below says `regression: required`. Skip it only when that policy explicitly carries a typed regression waiver. New-test creation is independent: write new tests exactly when `new_tests: required`; a new-test waiver never waives regression execution.**

```
bun test          # TypeScript/Bun projects
npm test          # Node projects
npx vitest run    # Vitest projects
mvn test          # Java/Maven projects
pytest            # Python projects
```

Test evidence is resolved ledger-first: a PostToolUse hook records every Bash test run (real exit codes and report artifacts) into an evidence ledger, and the SubagentStop hook judges your task from that ledger — it falls back to transcript scanning whenever the ledger yields no trusted verdict (no ledger evidence at all, an exit-0 run with no report artifact, or a pass invalidated by later file writes), and that fallback is always labeled untrusted.
Either way, evidence only exists for tests EXECUTED via the Bash tool: if your task DOES require tests and you do not run them via Bash, the task's `test_result` will not show a pass and the wave gate FAILS.
Writing tests without executing them counts as failure.

**When regression is required: do NOT finish without Bash test output showing pass markers (e.g., "X passing", "0 fail", "BUILD SUCCESS").**

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
**Required Loom skill:** {required_skill}
**Dependencies:** {dependencies}

## Verification Policy

{verification_policy}

Regression execution and new-test creation are separate obligations. Follow each arm independently.

## Engine-Issued Implementation Retry Context

{implementation_retry_context}

When this is an exact `LOOM_IMPLEMENTATION_RETRY_CONTEXT` appendix, it is protected attempt-2 authority and the failure kinds are the previous attempt's deterministic diagnostics. Address them during this attempt. When it says `None — semantic attempt 1.`, no retry authority exists.

## Your Task

{task_description}

## Requirement Completion Claims (MUST fully satisfy in this Wave)

{spec_anchors_formatted}

These are the only Requirements in this Wave's spec-check completion scope.

## Requirement Contributions (partial traceability; not completion claims)

{spec_contributions_formatted}

Contributions identify partial work. Do not claim the Requirement is complete unless it also appears above as a Wave-owned Completion Claim.

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
- MUST fully satisfy Requirement Completion Claims listed above
- Implement only the assigned portion of Requirement Contributions; do not treat them as Wave completion authority

## Required Workflow

1. Read & apply the **Architecture & Language Rules** inlined above — binding constraints, not suggestions
2. Read the plan file and understand scope
3. Implement code following the plan's patterns AND the rules above
4. If `new_tests` is required, write NEW tests (hook git-diffs for @Test, it(, test(, describe( patterns — no new tests = wave blocked). If it is waived, preserve the stated waiver boundary rather than inventing unrelated tests.
5. If `regression` is required, **run tests via Bash tool** — fix failures, re-run until 0 failures. Skip only under the explicit regression waiver above.
6. Only then are you done
