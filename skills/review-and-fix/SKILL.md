---
name: review-and-fix
version: "1.0.0"
description: "This skill should be used when the user asks to 'review and fix', 'fix the PR', 'review then implement fixes', 'clean up the PR', 'run review and commit', 'remediate findings', or wants an automated end-to-end workflow that reviews code, plans fixes, implements them, and commits+pushes. Chains: /review-pr → remediation plan → implementation → commit+push."
---

# Review and Fix — End-to-End PR Remediation

Automated workflow that chains review → plan → implement → commit → push.

**Single command** that does what would otherwise take 3+ manual steps.

## Arguments

```
/review-and-fix [aspects] [--files file1,file2] [--no-push] [--commit-msg "..."]
```

- **aspects**: `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all` (default: `all`)
- `--files file1,file2,...` — Explicit file list (skips git diff detection)
- `--no-push` — Commit but don't push
- `--commit-msg "..."` — Custom commit message (default: auto-generated from findings)
- `--dry-run` — Review + plan only, don't implement or commit

## Workflow

### Phase 1: Review (via sub-agents)

Spawn review agents in parallel using the Task tool. Each agent MUST be spawned as a sub-agent — do NOT perform reviews inline.

**Determine scope:**
```bash
git diff --name-only
git diff --cached --name-only
git diff main...HEAD --stat | tail -1
```

**Launch review agents (parallel via Task tool):**

1. **`loom:code-reviewer`** — CLAUDE.md compliance, bugs, patterns
2. **`loom:silent-failure-hunter`** — Error handling, Either patterns, silent failures
3. **`loom:pr-test-analyzer`** — Test coverage, property tests, gaps
4. **`loom:type-design-analyzer`** — Invariants, encapsulation, sealed types
5. **`loom:comment-analyzer`** — Comment accuracy, rot, documentation
6. **`loom:architecture-agent`** — FC/IS adherence, coupling, testability (auto for >500 additions or >10 files)

Each agent gets:
- The file list (from git diff or `--files`)
- Instruction to produce Machine Summary output

**Aggregate findings** into a unified list:
- CRITICAL issues (must fix)
- ADVISORY issues (should fix)
- SUGGESTIONS (nice to have)

**If zero CRITICAL + zero ADVISORY:** Report clean review, skip remaining phases. Done.

### Phase 2: Plan (write remediation doc)

Write a remediation plan to `.claude/plans/YYYY-MM-DD-pr-remediation.md`.

**Plan structure:**
```markdown
# PR Remediation Plan

**Date:** YYYY-MM-DD
**Branch:** {current branch}
**Scope:** {N} critical, {M} advisory findings

## Critical Fixes (must do)

### Fix 1: {title}
- **Finding:** {agent}: {description}
- **File:** {path}:{line}
- **Fix:** {concrete description of the change}
- **Validation:** {how to verify — test command or type check}

### Fix 2: ...

## Advisory Fixes (should do)

### Fix N: ...

## Deferred (not fixing now)

- {reason for deferral}

## Validation

Run after all fixes:
```bash
{typecheck command}
{test command}
```
```

**Prioritization rules:**
1. Type errors / build failures first (blocks everything)
2. Silent failures / error handling gaps second
3. Code quality / architecture third
4. Comments / style last

### Phase 3: Implement (using code-implementer patterns)

**Before implementing, load rules:**
- Read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md`
- Read `${CLAUDE_PLUGIN_ROOT}/rules/typescript-patterns.md` (for TS projects)
- Read `${CLAUDE_PLUGIN_ROOT}/rules/java-patterns.md` (for Java projects)

**Implement each fix from the plan sequentially:**

For each fix:
1. Read the target file
2. Make the minimal, precise edit
3. Verify the edit doesn't break surrounding code

**After all fixes applied:**
```bash
# Run type check
bun run typecheck  # or equivalent

# Run tests
bun test  # or equivalent
```

**If tests/typecheck fail after fixes:** Iterate — read error, fix, re-run. Max 3 iterations per fix.

### Phase 4: Commit and Push

**Stage all changes:**
```bash
git add -A
```

**Generate commit message** (unless `--commit-msg` provided):
```
fix: remediate PR review findings

- {summary of critical fixes}
- {summary of advisory fixes}

Reviewed by: code-reviewer, silent-failure-hunter, type-design-analyzer
Fixes: {N} critical, {M} advisory findings
```

**Commit:**
```bash
git commit -m "{message}"
```

**Push** (unless `--no-push`):
```bash
git push
```

### Phase 5: Summary

Output final summary:
```markdown
## Review & Fix Complete

**Findings:** {N} critical, {M} advisory
**Fixed:** {X} critical, {Y} advisory
**Deferred:** {Z} items (with reasons)
**Commit:** {short sha}
**Branch:** {branch name}

### Changes Made
- {file}: {what changed}
- ...

### Validation
- Typecheck: ✅ PASS
- Tests: ✅ PASS ({N} tests, {M} assertions)
```

## Handling Edge Cases

### No findings
Report clean review. No changes needed. Exit early.

### Only ADVISORY findings
Ask user: "Only advisory findings (no critical). Fix them? [Y/n]"
If yes → proceed. If no → exit.

### Fix introduces new failure
Revert that specific fix, log it as "deferred", continue with remaining fixes.

### Cannot push (no remote, auth failure)
Log the commit SHA, inform user, suggest manual push.

## Integration with Loom

This skill can be invoked:
- **Standalone:** `/review-and-fix` — for ad-hoc PR cleanup
- **From wave-gate:** When wave-gate blocks on critical findings, spawn a `loom:code-implementer` agent with the findings as context
- **Pre-merge:** As a final quality gate before `/finalize`

## Constraints

- **Never skip review phase** — always run sub-agents first
- **Never implement without a plan** — plan doc is mandatory (enables audit trail)
- **Minimal edits** — fix exactly what's reported, don't refactor adjacent code
- **Preserve semantics** — fixes must not change behavior unless fixing a bug
- **Run validation** — typecheck + tests MUST pass before commit
- **Atomic commit** — all fixes in one commit (reviewable as a unit)
