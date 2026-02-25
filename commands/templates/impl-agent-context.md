# Implementation Agent Context

Template for spawning implementation agents during Execute phase. All template variables must be substituted before use.

---

## !! MANDATORY FINAL STEP — READ THIS FIRST !!

**Your LAST action before finishing MUST be running tests via the Bash tool.**

```
bun test          # TypeScript/Bun projects
npm test          # Node projects
npx vitest run    # Vitest projects
mvn test          # Java/Maven projects
pytest            # Python projects
```

A hook reads your transcript and extracts test evidence ONLY from Bash tool_result blocks.
If you do not run tests via Bash, `tests_passed = false` and the wave gate FAILS.
Writing tests without executing them counts as failure.

**Do NOT finish without Bash test output showing pass markers (e.g., "X passing", "0 fail", "BUILD SUCCESS").**

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

1. Read the plan file and understand scope
2. Implement code following the plan's patterns
3. Write NEW tests (hook git-diffs for @Test, it(, test(, describe( patterns — no new tests = wave blocked)
4. **Run tests via Bash tool** — fix failures, re-run until 0 failures
5. Only then are you done
