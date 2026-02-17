---
description: "Comprehensive PR review using specialized agents"
argument-hint: "[code|errors|tests|types|comments|architecture|simplify|all] [--files file1,file2] [--task T1]"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Task"]
---

# Comprehensive PR Review

Run a comprehensive pull request review using multiple specialized agents, each focusing on a different aspect of code quality.

**Arguments:** "$ARGUMENTS"

## Review Workflow

### 1. Determine Review Scope

**Parse arguments for:**
- `--files file1,file2,...` - Explicit file list (comma-separated)
- `--task T1` - Task ID for wave-gate integration
- Review aspects: code, errors, tests, types, comments, architecture, simplify, all

**If --files provided:** Use those files instead of git diff
**Otherwise:** Check git status to identify changed files

### 2. Available Review Aspects

- **code** - General code review for project guidelines and bugs
- **errors** - Check error handling for silent failures (Either patterns)
- **tests** - Review test coverage quality and completeness
- **types** - Analyze type design and invariants
- **comments** - Analyze code comment accuracy
- **architecture** - FC/IS adherence, coupling, testability, service design
- **simplify** - Simplify code for clarity (run after other reviews pass)
- **all** - Run all applicable reviews (default)

### 3. Identify Changed Files

**If --files provided:**
Use the explicit file list directly.

**Otherwise:**
```bash
git diff --name-only
git diff --cached --name-only
```

Check if PR already exists: `gh pr view`

### 4. Determine Applicable Reviews

Based on changes:
- **Always**: code-reviewer (general quality)
- **If error handling changed**: silent-failure-hunter
- **If test files changed or new logic added**: pr-test-analyzer
- **If types added/modified**: type-design-analyzer
- **If comments/docs added**: comment-analyzer
- **If large PR (>500 additions OR >10 files) OR new services/packages/migrations**: architecture-agent (FC/IS, coupling, testability)
- **After other reviews pass**: code-simplifier (polish)

**To determine PR size, run:**
```bash
git diff main...HEAD --stat | tail -1
# Example output: "23 files changed, 5843 insertions(+), 35 deletions(-)"
# Parse additions count and file count to decide architecture trigger
```

### 5. Launch Review Agents

**For comprehensive review, launch these agents in parallel using the Task tool.**

Each agent MUST be spawned via `Task` with the `subagent_type` shown below. Do NOT perform reviews inline — always dispatch to specialized agents.

1. **`loom:code-reviewer`** - CLAUDE.md compliance, bugs, architecture
   - Will recommend delegation to: security-expert, keycloak-skill, frontend-design-skill

2. **`loom:silent-failure-hunter`** - Error handling, Either patterns, silent failures

3. **`loom:pr-test-analyzer`** - Test coverage, property tests, gaps
   - Will recommend delegation to: java-test-engineer, ts-test-engineer

4. **`loom:type-design-analyzer`** - Invariants, encapsulation, sealed types

5. **`loom:comment-analyzer`** - Comment accuracy, rot, documentation

6. **`loom:architecture-agent`** *(auto-triggered for large PRs)* - FC/IS adherence, coupling, testability, service layer design, brand duplication, I/O boundary placement
   - **Auto-trigger:** >500 additions OR >10 files changed OR new services/packages/DB migrations
   - **Always included** when `all` or `architecture` aspect requested
   - Prompt must include: file list, diff stats, architecture principles from CLAUDE.md
   - Reviews: FC/IS pattern, coupling, testability score, service design, refactoring priorities, unresolved questions

**After fixes applied:**
7. **`loom:code-simplifier`** - Clarity, FP patterns, maintainability

### 6. Aggregate Results

After agents complete, summarize:

```markdown
# PR Review Summary

## Critical Issues (must fix before merge)
- [agent-name]: Issue description [file:line]

## Important Issues (should fix)
- [agent-name]: Issue description [file:line]

## Suggestions (nice to have)
- [agent-name]: Suggestion [file:line]

## Delegation Recommendations
- [ ] security-expert: [reason]
- [ ] keycloak-skill: [reason]
- [ ] java-test-engineer: [reason]
- [ ] ts-test-engineer: [reason]

## Strengths
- What's well-done in this PR

## Recommended Action
1. Fix critical issues first
2. Address important issues
3. Consider suggestions
4. Run delegated reviews if recommended
5. Run code-simplifier after fixes

### Machine Summary
CRITICAL_COUNT: {number of critical issues}
ADVISORY_COUNT: {number of important + suggestion issues}
CRITICAL: {each critical finding on its own line}
ADVISORY: {each non-critical finding on its own line}
```

**IMPORTANT:** The `### Machine Summary` block is MANDATORY. It MUST appear at the end of every review output, even if counts are zero. This block is parsed by automated hooks — do NOT omit it.

## Usage Examples

**Full review (default):**
```
/review-pr
```

**Specific aspects:**
```
/review-pr code errors
/review-pr tests types
/review-pr architecture
/review-pr simplify
```

**With explicit files (for wave-gate):**
```
/review-pr --files components/foo.tsx,lib/bar.ts --task T3
/review-pr code --files src/User.java --task T1
```

**Parallel review:**
```
/review-pr all parallel
```

## Tips

- **Run early**: Before creating PR, not after
- **Focus on changes**: Agents analyze git diff by default (unless --files)
- **Address critical first**: Fix high-priority issues before lower priority
- **Re-run after fixes**: Verify issues are resolved
- **Use delegation**: When agents recommend specialized skills, invoke them
- **Simplify last**: Run code-simplifier after other issues are fixed
- **Architecture auto-triggers**: For PRs with >500 additions or >10 files, architecture-agent launches automatically with `all`

## Workflow Integration

**Before committing:**
```
1. Write code
2. Run: /review-pr code errors
3. Fix critical issues
4. Commit
```

**Before creating PR:**
```
1. Stage all changes
2. Run: /review-pr all
3. Address critical and important issues
4. Run delegated reviews (security-expert, java-test-engineer, ts-test-engineer, etc.)
5. Run: /review-pr simplify
6. Create PR with /finalize
```

**Wave-gate integration:**
```
# Wave-gate spawns review sub-agents directly per task
# Each sub-agent reviews scoped files and produces Machine Summary output
```
