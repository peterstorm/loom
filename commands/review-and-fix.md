---
description: "Review PR, plan fixes, implement, commit and push — end-to-end"
argument-hint: "[code|errors|tests|types|comments|architecture|all] [--files f1,f2] [--no-push] [--dry-run] [--commit-msg '...']"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Write", "Edit", "Task", "Agent"]
---

# Review and Fix — End-to-End PR Remediation

Automated workflow: review → plan → implement → commit → push.

**Arguments:** "$ARGUMENTS"

---

## Phase 1: Review

### 1a. Parse Arguments

- Extract aspects: `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all` (default: `all`)
- Extract flags: `--files`, `--no-push`, `--dry-run`, `--commit-msg`

### 1b. Determine Scope

**If --files provided:** Use those files directly.

**Otherwise:**
```bash
git diff --name-only
git diff --cached --name-only
git diff main...HEAD --name-only
git diff main...HEAD --stat | tail -1
```

Identify: file count, insertion count, languages involved.

### 1c. Launch Review Agents (Parallel via Task)

Spawn ALL applicable review agents in a **single message with multiple Task calls**:

1. **`loom:code-reviewer`** — Always
   - Prompt: "Review these files for project guideline compliance and bugs: {file_list}"

2. **`loom:silent-failure-hunter`** — Always (unless only docs changed)
   - Prompt: "Hunt for silent failures, swallowed errors, missing Result handling in: {file_list}"

3. **`loom:pr-test-analyzer`** — If source files changed
   - Prompt: "Analyze test coverage and quality for changes in: {file_list}"

4. **`loom:type-design-analyzer`** — If types/interfaces changed
   - Prompt: "Review type design, invariants, and encapsulation in: {file_list}"

5. **`loom:comment-analyzer`** — If comments/docs present
   - Prompt: "Check comment accuracy and documentation quality in: {file_list}"

6. **`loom:architecture-agent`** — If >500 additions OR >10 files OR `architecture` aspect requested
   - Prompt: "Review FC/IS adherence, coupling, testability, service design in: {file_list}. Diff stats: {stats}"

Each agent MUST produce output containing:
```
### Machine Summary
CRITICAL_COUNT: N
ADVISORY_COUNT: M
CRITICAL: {finding}
ADVISORY: {finding}
```

### 1d. Aggregate Results

Parse Machine Summary from each agent. Deduplicate overlapping findings.
Build unified findings list:
- **CRITICAL** — must fix
- **ADVISORY** — should fix

**If zero findings:** Report "✅ Clean review — no issues found" and EXIT. Done.

**If `--dry-run`:** Output findings summary and EXIT. Don't proceed to Phase 2.

---

## Phase 2: Plan

### 2a. Write Remediation Doc

Create `.claude/plans/{date}-pr-remediation.md` with:

```markdown
# PR Remediation Plan

**Date:** {YYYY-MM-DD}
**Branch:** {branch}
**Findings:** {N} critical, {M} advisory

## Critical Fixes

### Fix 1: {title from finding}
- **Source:** {agent-name}
- **File:** {path}:{line}
- **Issue:** {description}
- **Fix:** {concrete change description}

...

## Advisory Fixes

### Fix N: {title}
...

## Validation Commands
\```bash
{typecheck command for this project}
{test command for this project}
\```
```

### 2b. Prioritize

Order fixes:
1. Build/type errors (unblock everything)
2. Implicit `any` / missing types
3. Error handling gaps
4. Unused imports / dead code
5. Architecture / coupling
6. Comments / docs

---

## Phase 3: Implement

### 3a. Load Implementation Rules

Read the relevant rules for the languages in scope:

- **Always:** `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md`
- **TypeScript:** `${CLAUDE_PLUGIN_ROOT}/rules/typescript-patterns.md`
- **Java:** `${CLAUDE_PLUGIN_ROOT}/rules/java-patterns.md`
- **Rust:** `${CLAUDE_PLUGIN_ROOT}/rules/rust-patterns.md`

### 3b. Apply Fixes

For each fix in the plan (ordered by priority):

1. Read the target file
2. Make the **minimal** edit using the Edit tool
3. Do NOT refactor surrounding code — fix exactly what was found
4. Log what was changed

### 3c. Validate

After ALL fixes applied:

```bash
# Type check (detect project type and run appropriate command)
bun run typecheck 2>&1 | tail -20
# OR: npx tsc --noEmit / mvn compile / cargo check

# Tests
bun test 2>&1 | tail -30
# OR: npm test / mvn test / cargo test
```

**If validation fails:**
- Read error output
- Fix the newly introduced issue
- Re-run validation
- Max 3 retry iterations per fix
- If still failing: REVERT that fix, mark as "deferred", continue

### 3d. Deferred Fixes

If any fix couldn't be applied cleanly, document why in the plan:
```markdown
## Deferred

### {title}
- **Reason:** {why it couldn't be fixed — e.g. "requires upstream framework change"}
- **Recommendation:** {what to do about it}
```

---

## Phase 4: Commit & Push

### 4a. Stage

```bash
git add -A
git status
```

### 4b. Commit Message

**If `--commit-msg` provided:** Use that message verbatim.

**Otherwise, auto-generate:**
```
fix: remediate PR review findings

Critical:
- {one-line per critical fix applied}

Advisory:
- {one-line per advisory fix applied}

Reviewed-by: {comma-separated agent names that found issues}
```

### 4c. Commit

```bash
git commit -m "{message}"
```

### 4d. Push

**Unless `--no-push`:**
```bash
git push
```

If push fails (auth, no remote, force needed):
- Log the commit SHA
- Inform user of the situation
- Do NOT force-push without explicit user approval

---

## Phase 5: Summary

Output:

```markdown
## ✅ Review & Fix Complete

| Metric | Value |
|--------|-------|
| Critical found | {N} |
| Critical fixed | {X} |
| Advisory found | {M} |
| Advisory fixed | {Y} |
| Deferred | {Z} |
| Commit | `{short-sha}` |
| Branch | `{branch}` |
| Pushed | {yes/no} |

### Changes Made
| File | Change |
|------|--------|
| {path} | {description} |
| ... | ... |

### Validation
- Typecheck: ✅ / ❌
- Tests: ✅ {N} pass, 0 fail / ❌ {details}

### Deferred Items
- {item}: {reason}
```

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No findings | Report clean, exit early |
| Only advisory | Ask user "Fix advisories? [Y/n]" before proceeding |
| Fix breaks tests | Revert fix, mark deferred, continue |
| Push fails | Report commit SHA, suggest manual push |
| Agent timeout | Log which agent failed, continue with available findings |
| `--dry-run` | Review + plan only, no edits |

---

## Usage Examples

```bash
# Full end-to-end (default)
/review-and-fix

# Review + fix but don't push
/review-and-fix --no-push

# Only code + error handling review
/review-and-fix code errors

# Review specific files
/review-and-fix --files src/host.ts,src/config.ts

# Dry run — see findings without fixing
/review-and-fix --dry-run

# Custom commit message
/review-and-fix --commit-msg "fix: resolve type errors in host package"
```
