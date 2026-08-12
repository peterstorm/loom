---
description: "Comprehensive PR review using specialized agents"
argument-hint: "[code|errors|tests|types|comments|architecture|simplify|all] [--files file1,file2] [--task T1]"
allowed-tools: ["Bash", "Glob", "Grep", "Read", "Task", "Agent"]
---

# Comprehensive PR Review

Run a comprehensive pull request review using multiple specialized agents, each focusing on a different aspect of code quality.

**Resolve the active package first.** Claude Code expands the shared-source
token; Loom's Pi adapter renders it from the extension module's `import.meta.url`:

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR"; exit 1; }
```

Never infer package identity from cwd or another harness's install cache.

**Model policy:** resolve every Loom agent before spawning with
`bun ${LOOM_DIR}/engine/src/cli.ts helper model-profiles agent --agent <name>`.
Claude Code MUST pass the returned `claudeCode.model`; Pi MUST use the generated
agent definition carrying the returned exact OpenAI model pattern. Never inherit
the orchestrator's current model.

**Arguments:** "$ARGUMENTS"

## Review Workflow

### 1. Determine Review Scope

**Parse arguments for:**
- `--files file1,file2,...` - Explicit file list (comma-separated)
- `--task T1` - Task ID for wave-gate integration
- Review aspects: code, errors, tests, types, comments, architecture, simplify, all

**If --files provided:** Use those files instead of git diff
**Otherwise:** Use the sorted union of unstaged tracked files, untracked non-ignored files, staged files, and `main...HEAD` changed paths. An empty union is a hard stop.

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
{ git diff --name-only; git ls-files --others --exclude-standard; git diff --cached --name-only; git diff --name-only main...HEAD; } \
  | LC_ALL=C sort -u | awk 'NF'
```

This includes new untracked files and clean-worktree commits already on the branch. Stop if the resulting scope is empty. Compute additions against the merge base plus untracked file additions so committed, staged, and unstaged layers are counted exactly once.

Check if PR already exists: `gh pr view`

### 4. Determine Applicable Reviews

Based on changes:
- **Always**: code-reviewer (general quality)
- **If error handling changed**: silent-failure-hunter
- **If test files changed or new logic added**: pr-test-analyzer
- **If types added/modified**: type-design-analyzer
- **If comments/docs added**: comment-analyzer
- **If large PR (>500 additions OR >10 files) OR new services/packages/migrations**: architecture-tech-lead (FC/IS, coupling, testability)
- **After other reviews pass**: code-simplifier (polish)

**To determine PR size, run:**
```bash
git diff main...HEAD --stat | tail -1
# Example output: "23 files changed, 5843 insertions(+), 35 deletions(-)"
# Parse additions count and file count to decide architecture trigger
```

### 5. Launch Review Agents

Before spawning, decide the lifecycle context from the already-parsed arguments.
When `--task` is absent, create and initialize the Standalone Review Run now
(per the canonical skill protocol) and prepend the exact
`LOOM_REVIEW_CONTEXT: standalone` marker to every reviewer prompt. Do not wait
until aggregation—the completion hook runs as each reviewer exits. When
`--task` is present, do not add the marker.

**For comprehensive review, launch these agents in parallel using the Task tool.**

Each agent MUST be spawned via `Task` with the `subagent_type` shown below. Do NOT perform reviews inline — always dispatch to specialized agents.

1. **`loom:code-reviewer`** - CLAUDE.md compliance, bugs, architecture
   - Will recommend delegation to: security-expert, java-test-engineer, ts-test-engineer, nextjs-frontend-design

2. **`loom:silent-failure-hunter`** - Error handling, Either patterns, silent failures

3. **`loom:pr-test-analyzer`** - Test coverage, property tests, gaps
   - Will recommend delegation to: java-test-engineer, ts-test-engineer

4. **`loom:type-design-analyzer`** - Invariants, encapsulation, sealed types

5. **`loom:comment-analyzer`** - Comment accuracy, rot, documentation

6. **`loom:architecture-tech-lead`** *(auto-triggered for large PRs)* - FC/IS adherence, coupling, testability, service design, boundary placement
   - **Auto-trigger:** >500 additions OR >10 files changed OR new services/packages/DB migrations
   - **Always included** when `all` or `architecture` aspect requested
   - Prompt must include: file list, diff stats, architecture principles from CLAUDE.md
   - Reviews: FC/IS pattern, coupling, testability score, service design, refactoring priorities, unresolved questions

**After fixes applied:**
7. **`loom:code-simplifier`** - Clarity, FP patterns, maintainability

### 6. Aggregate and adjudicate results

**When `--task` is present:** this invocation is feeding the wave gate. Do not
run a per-task panel; SubagentStop stores each raw finding and `/wave-gate`
performs one wave-wide Refutation Panel after all task reviewers finish.

**When `--task` is absent:** this is a standalone review. Before presenting any
result, read the `Phase 1 — Review and adjudicate` protocol in
`${LOOM_DIR}/skills/review-and-fix/SKILL.md` and execute it over this command's
already-selected reviewer batch:

1. Persist every raw transcript in a fresh Standalone Review Run.
2. Run `helper standalone-review aggregate`.
3. If canonical criticals exist, run `review-panel brief --standalone`,
   `manifest`, `lenses`, the exact Panel Program verifier batch, `verdict`, and
   `tally`.
4. For zero criticals run `helper standalone-review finalize`; for critical-bearing
   runs, `review-panel tally` atomically publishes `result.json` itself.
5. Build the summary only from `result.json`: surviving criticals remain
   critical, advisories remain advisory, and refuted criticals are listed in a
   separate audit section with lenses and reasoning.

Any missing evidence or panel failure aborts the review; never report an
unadjudicated result. Do not text-deduplicate before the panel.

After adjudication, summarize:

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
- [ ] java-test-engineer: [reason]
- [ ] ts-test-engineer: [reason]
- [ ] nextjs-frontend-design: [reason]

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
ADVISORY_COUNT: {number of advisory findings}
CRITICAL: {each critical finding on its own line}
ADVISORY: {each non-critical finding on its own line}
```

**IMPORTANT:** The `### Machine Summary` block is MANDATORY. It MUST appear at the end of every review output, even if counts are zero. This block is parsed by automated hooks — do NOT omit it.

### Structured findings block (optional, strongly preferred)

Immediately after the marker lines, inside the same `### Machine Summary`
section, emit a fenced ` ```findings ` block holding a JSON array — one entry
per finding, in the same order as the `CRITICAL:` / `ADVISORY:` lines:

````
### Machine Summary
CRITICAL_COUNT: 1
ADVISORY_COUNT: 1
CRITICAL: unchecked cast in the reducer
ADVISORY: prefer a named constant over the literal

```findings
[
  { "severity": "critical", "file": "src/reducer.ts", "line": 88, "claim": "unchecked cast in the reducer" },
  { "severity": "advisory", "file": "src/reducer.ts", "line": 12, "claim": "prefer a named constant over the literal" }
]
```
````

- `severity` — exactly `"critical"` or `"advisory"`. No other value is accepted.
- `file` / `line` — omit or use `null` when you genuinely cannot locate the issue.
  Do not guess: a wrong location is worse than none.
- `claim` — the **single assertion a reviewer of your review would try to
  refute**. One claim per entry; no bundling.
- Never invent an `id`. Ids are derived from (agent, emission order) by the
  engine so they are stable and need no trust.

`CRITICAL_COUNT` and `ADVISORY_COUNT` are the authority on how many findings you
made, and the block must **account for every finding you reported — advisories
included**: when it parses and is long enough, it becomes the source of findings,
so every `CRITICAL:` line **and** every `ADVISORY:` line must also appear in the
block with the matching `"severity"`. A block listing fewer findings of
**either** severity than the marker lines loses to them. If the block is absent
or malformed, the marker lines are parsed instead. Either way the claims survive
and only the locations are at risk: verification quality degrades, nothing
breaks.

Counts per severity choose which representation is the primary source; claim
text still drives the subsequent reconciliation. The engine cannot tell a
reworded claim from a substituted one, so it reconciles both sources **by
value**. Neither side is ever deleted for losing: any marker claim the winning
block does not name is carried over beside it without a location, and any block
claim the marker lines do not name survives a losing block the same way. The
operator is told how many claims were carried over.

So a renamed claim is not lost — but it does arrive **twice**, once from each
side, and a verifier then spends a vote on the duplicate. Write the same claim
text in both places.

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
- **Architecture auto-triggers**: For PRs with >500 additions or >10 files, architecture-tech-lead launches automatically with `all`

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
