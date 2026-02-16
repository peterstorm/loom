---
name: loom
version: "3.2.0"
description: "This skill should be used when the user asks to 'plan this', 'orchestrate', 'break down', 'split into phases', 'coordinate tasks', 'create a plan', 'multi-step feature', or has complex tasks needing structured decomposition. Decomposes work into wave-based parallel tasks, assigns specialized agents, creates GitHub Issue for tracking, and manages execution through automated hooks."
---

# Loom - Full Orchestration Skill

Orchestrates the COMPLETE feature lifecycle: brainstorm → specify → clarify → architecture → decompose → execute.

**This is the SINGLE ENTRY POINT** for multi-step features. Spawns specialized agents for each phase.

## Prerequisites

**BEFORE starting any phase**, run this check:
```bash
command -v bun || echo "FATAL: bun not found. Run: nix develop ./.claude"
```
If `bun` is missing, **STOP and tell the user**. Loom hooks require bun for TypeScript transcript parsing. Dev shell: `nix develop ./.claude`

## Setup: Resolve Plugin Path

**FIRST STEP of every `/loom` invocation** — resolve loom plugin install path:
```bash
LOOM_DIR=$(ls -d "$HOME/.claude/plugins/cache/plugins/loom"/*/ 2>/dev/null | tail -1 | sed 's:/$::')
[ -z "$LOOM_DIR" ] && echo "FATAL: loom plugin not installed" && exit 1
echo "LOOM_DIR=$LOOM_DIR"
```

Store the printed path. **All subsequent references use it:**
- Templates: `{LOOM_DIR}/commands/templates/<name>.md`
- Engine CLI: `bun {LOOM_DIR}/engine/src/cli.ts`
- References: `{LOOM_DIR}/references/<name>.md`

---

## Arguments

- `/loom "description"` - Start new plan (runs full flow)
- `/loom --skip-brainstorm` - Skip brainstorm phase (scope already clear)
- `/loom --skip-clarify` - Skip clarify phase (accept markers as-is)
- `/loom --skip-specify` - Skip brainstorm/specify/clarify (use existing spec)
- `/loom --status` - Show current task graph status *(planned — use jq commands in Observability section)*
- `/loom --complete` - Finalize, clean up state *(planned — manually remove state file for now)*
- `/loom --abort` - Cancel mid-execution, clean state *(planned — manually remove state file for now)*

**Note:** All phases are MANDATORY by default. Skip flags allow explicit bypass with user acknowledgment.

**Clarify threshold:** Markers > 3 triggers mandatory clarify phase. Source of truth: `{LOOM_DIR}/engine/src/config.ts`

---

## Full Orchestration Flow

```
/loom "feature description"
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 0: BRAINSTORM [MANDATORY]                         │
│   Agent: brainstorm-agent                               │
│   Output: .claude/specs/{slug}/brainstorm.md            │
│   Skip: --skip-brainstorm                               │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 1: SPECIFY [MANDATORY]                            │
│   Agent: specify-agent                                  │
│   Output: .claude/specs/{slug}/spec.md                  │
└─────────────────────────────────────────────────────────┘
        │
        ▼ (if >3 markers, else skip to ARCHITECTURE)
┌─────────────────────────────────────────────────────────┐
│ Phase 2: CLARIFY [MANDATORY if markers > 3]             │
│   Agent: clarify-agent                                  │
│   Output: Updated spec.md with resolved uncertainties   │
│   Skip: --skip-clarify                                  │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 3: ARCHITECTURE                                   │
│   Agent: architecture-agent                             │
│   Output: .claude/plans/{slug}.md                       │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 4: DECOMPOSE                                      │
│   Extract tasks, assign agents, schedule waves          │
│   Output: Task graph + GitHub Issue                     │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 5: EXECUTE (wave by wave)                         │
│   Spawn impl agents → wave-gate → advance               │
│   Output: Working implementation                        │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 0: Brainstorm (MANDATORY)

**Always run** unless `--skip-brainstorm` flag provided.

**Hook enforcement:** `validate-phase-order.sh` blocks specify-agent if brainstorm not complete (unless skipped).

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-brainstorm.md`

Substitute variables:
- `{feature_description}` - User's original request
- `{prior_context}` - Any notes from prior exploration

**Spawn brainstorm-agent** with the substituted template as prompt.

**Wait for agent completion.** Agent writes `.claude/specs/{date_slug}/brainstorm.md`.
Hook detects the file and advances phase to `specify`.

**User checkpoint:** Read brainstorm.md, present summary, ask:
> "Approach: {selected approach}. Proceed to specification?"

If user wants changes → re-spawn brainstorm-agent with feedback.
If approved → pass brainstorm.md path as `{brainstorm_file}` to Phase 1.

---

## Phase 1: Specify

**Always run** (unless `--skip-specify` or spec already exists).

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-specify.md`

Substitute variables:
- `{feature_description}` - Refined description (from brainstorm or original)
- `{date_slug}` - Same slug as brainstorm (agent reads brainstorm.md from this dir)
- `{date_slug}` - `YYYY-MM-DD-feature-name` format

**Spawn specify-agent** with the substituted template as prompt.

**Wait for agent completion.** Extract:
- Spec file path
- Count of `[NEEDS CLARIFICATION]` markers

If markers > 3: Proceed to Phase 2.
If markers <= 3: Skip to Phase 3.

---

## Phase 2: Clarify (MANDATORY if markers > 3)

**Run if:** spec has >3 `[NEEDS CLARIFICATION]` markers. Skip via `--skip-clarify` if accepting markers as-is.

**Hook enforcement:** `validate-phase-order.sh` blocks architecture-agent if markers > 3 (unless clarify skipped).

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-clarify.md`

Substitute variables:
- `{spec_file_path}` - Path to spec from Phase 1
- `{marker_count}` - Number of `[NEEDS CLARIFICATION]` markers

**Spawn clarify-agent** with the substituted template as prompt.

**IMPORTANT: Do NOT pre-resolve markers in the agent prompt.** The clarify agent MUST ask the user via AskUserQuestion. Pass only the spec path and marker count — let the agent drive the questioning.

**Wait for agent completion.** Verify markers resolved.

If still >3 markers: Ask user to resolve remaining, or proceed with caveats.

---

## Phase 3: Architecture

**Always run.**

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-architecture.md`

Substitute variables:
- `{feature_description}` - Feature name/description
- `{spec_file_path}` - Path to spec from Phase 1
- `{date_slug}` - `YYYY-MM-DD-feature-name` format

**Spawn architecture-agent** with the substituted template as prompt.

**Wait for agent completion.** Extract:
- Plan file path
- Implementation phases

---

## Phase 4: Decompose

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-decompose.md`

Substitute variables:
- `{feature_description}` - Feature name/description
- `{spec_file_path}` - Path to spec from Phase 1
- `{plan_file_path}` - Path to plan from Phase 3

**Spawn decompose-agent** with the substituted template as prompt.

**Wait for agent completion.** Agent outputs pure JSON task graph.

### 4a. Validate Output

Run schema validator on agent output:

```bash
echo "$DECOMPOSE_OUTPUT" | bun ${LOOM_DIR}/engine/src/cli.ts helper validate-task-graph -
```

If validation fails → re-spawn decompose-agent with error details.

### 4b. Map Spec Anchors

If decompose-agent didn't set anchors, use helper:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper suggest-spec-anchors "task description" .claude/specs/*/spec.md
```

Returns JSON with suggested anchors and confidence scores:
```json
[{"anchor":"FR-003","score":0.85,"text":"System MUST validate email format"},...]
```

Review suggestions, adjust as needed, store as `spec_anchors: ["FR-003", "SC-002", "US1.acceptance"]`

### 4c. User Approval

Present plan summary:
- Spec path
- Plan path
- Task breakdown with agents
- Wave schedule
- GitHub Issue will be created

Ask: "Proceed with this plan?"

### 4d. Create Artifacts

On approval:

**A. GitHub Issue:**
```bash
gh issue create --title "Plan: {title}" --body "$(cat .claude/plans/{slug}.md)"
```

**B. State File:** Populate `.claude/state/active_task_graph.json` with tasks.

Use the `populate-task-graph.sh` helper (whitelisted in guard-state-file.sh):

```bash
echo "$DECOMPOSE_OUTPUT" | bun ${LOOM_DIR}/engine/src/cli.ts helper populate-task-graph --issue ISSUE_NUMBER --repo OWNER/REPO
```

This helper:
- Reads existing state (phase tracking fields)
- Merges with validated decompose output (tasks, waves)
- Adds `github_issue`, `spec_file`, `plan_file`, `current_wave: 1`
- Initializes `wave_gates`, `executing_tasks`
- Writes via `StateManager` (chmod 444 protection)

**C. Set state file read-only:**
```bash
chmod 444 .claude/state/active_task_graph.json
```
State file stays chmod 444 at rest. Only hooks can write via `StateManager` (temporarily toggles to 644).

---

## Phase 5: Execute

For each wave:

1. Get pending tasks in current wave (includes `failed` tasks with `retry_count < 2`)
2. Spawn ALL wave tasks in parallel (single message, multiple Task calls)
3. Wait for all to reach "implemented"
4. If any tasks `failed`: auto-retry up to 2 times (re-spawn with error context)
5. Invoke `/wave-gate` (test + spec-check + review)
6. If passed: advance to next wave
7. If blocked: fix issues, re-run `/wave-gate`

**Auto-retry logic:** After spawning, check for `failed` tasks:
```bash
jq -r ".tasks[] | select(.wave == $WAVE and .status == \"failed\" and (.retry_count // 0) < 2) | .id" .claude/state/active_task_graph.json
```
Re-spawn each with additional context: `"RETRY (attempt {retry_count+1}): {failure_reason}"`

**Load template:** Read `{LOOM_DIR}/commands/templates/impl-agent-context.md`

Substitute variables:
- `{task_id}`, `{wave}`, `{agent_type}`, `{dependencies}`
- `{task_description}` - From task breakdown
- `{spec_anchors_formatted}` - Formatted anchor list with requirement text
- `{plan_context}` - Relevant section from plan
- `{file_list}` - Files to create/modify
- `{plan_file_path}` - Path to full plan

**Spawn implementation agent** with the substituted template as prompt.

---

## Quick Start Examples

### Full flow (recommended):
```
/loom "Add user authentication with email/password"
```
Runs: brainstorm → specify → clarify → arch → decompose → execute

### Skip to architecture (spec exists):
```
/loom --skip-specify "Add user authentication"
```
Runs: arch → decompose → execute (uses existing spec)

### Simple feature (clear scope):
```
/loom "Add logout button to navbar"
```
Detects simple → may skip brainstorm, minimal spec

---

## State Management

### State File Lifecycle

The state file `.claude/state/active_task_graph.json` is created **before Phase 0** with minimal phase-tracking fields. This activates hook enforcement for the entire lifecycle.

```bash
# Initial state — computed from skip flags, validates spec.md exists for --skip-specify
mkdir -p .claude/state .claude/specs/{date_slug}
bun ${LOOM_DIR}/engine/src/cli.ts init-state \
  [--skip-brainstorm] [--skip-clarify] [--skip-specify] \
  --spec-dir .claude/specs/{date_slug} \
  --output .claude/state/active_task_graph.json
```

<!-- Schema reference (for understanding the state shape):
{
  "current_phase": "init",       // or "specify"/"architecture" depending on skip flags
  "phase_artifacts": {},
  "skipped_phases": [],          // e.g. ["brainstorm","specify","clarify"] for --skip-specify
  "spec_dir": ".claude/specs/{date_slug}",
  "spec_file": null,             // set automatically for --skip-specify
  "plan_file": null,
  "tasks": [],
  "wave_gates": {}
}
-->

**IMPORTANT:** Set `chmod 444` immediately after creation. This activates OS-level write protection — subagent Write tool calls will get EACCES. Only hooks writing via `StateManager` can modify the file.

After Phase 4 (Decompose), the task graph is populated with tasks, waves, and GitHub issue info. This is done by passing decompose output through `validate-task-graph.sh` and writing the full state.

**Hook activation timeline:**
- State file created → all PreToolUse hooks activate (block-direct-edits, guard-state-file, validate-phase-order, validate-task-execution)
- Phase agents complete → SubagentStop hooks fire (advance-phase updates current_phase)
- Execute phase → full wave enforcement active

### On `/loom "description"`:
1. Create minimal state file (hooks activate)
2. Run phases 0-4 (hooks enforce order, advance-phase tracks progress)
3. Populate state with tasks after decompose
4. Execute waves with full enforcement

### On `/loom --status`:
```
Plan: Issue #42 - User Authentication
Phase: Execute (Wave 2/3)
Spec: .claude/specs/2025-01-29-user-auth/spec.md
Plan: .claude/plans/2025-01-29-user-auth.md

[✓] T1: User model (code-implementer) — tests: PASS
[✓] T2: JWT service (code-implementer) — tests: PASS
[→] T3: Login endpoint (code-implementer) — tests: pending
```

### On `/loom --complete`:
1. Verify all tasks completed
2. Optionally close GitHub Issue
3. Remove state file
4. Invoke `/finalize` for PR

### On `/loom --abort`:
1. Ask: close issue or leave open?
2. Remove state file
3. Hooks deactivate

---

## Hook Integration

Hooks auto-activate when `active_task_graph.json` exists:

| Hook | Event | Purpose |
|------|-------|---------|
| `block-direct-edits.sh` | PreToolUse: Edit/Write/MultiEdit | Forces Task tool |
| `guard-state-file.sh` | PreToolUse: Bash | Blocks state writes (whitelisted helpers only) |
| `validate-task-execution.sh` | PreToolUse: Task | Validates wave order |
| `validate-phase-order.sh` | PreToolUse: Task | Enforces phase sequencing |
| `validate-template-substitution.sh` | PreToolUse: Task | Blocks unsubstituted `{variable}` patterns |
| `dispatch.sh` | SubagentStop | Routes to hooks below by agent type |
| ↳ `advance-phase.sh` | via dispatch | Advances phase + captures spec_file/plan_file from transcript |
| ↳ `update-task-status.sh` | via dispatch | Marks "implemented" or "failed" + test evidence + new-test verification |
| ↳ `store-reviewer-findings.sh` | via dispatch | Parses review findings |
| ↳ `store-spec-check-findings.sh` | via dispatch | Parses spec-check findings |
| ↳ `validate-review-invoker.sh` | via dispatch | Validates /review-pr skill was invoked |
| ↳ `cleanup-subagent-flag.sh` | via dispatch | Cleans up subagent tracking (always runs) |

**NEVER call helpers yourself.** All helpers (`mark-tests-passed.sh`, `complete-wave-gate.sh`, `StateManager`, `populate-task-graph.sh`, etc.) run automatically via hooks or `/wave-gate`. Only exception: `populate-task-graph.sh` during Phase 4d.

---

## Operations Reference

### Status Transitions

```
pending → in_progress    (task spawned to agent)
in_progress → implemented (agent completes, hook extracts test evidence)
in_progress → failed      (agent crash: no task ID in output, retry_count incremented)
failed → in_progress      (auto-retry if retry_count < 2)
implemented → completed   (wave gate passed: tests + review + no critical findings)
```

### Observability

```bash
# Current state
jq '.' .claude/state/active_task_graph.json

# Per-task status
jq '.tasks[] | {id, status, tests_passed, review_status}' .claude/state/active_task_graph.json

# Wave gate status
jq '.wave_gates' .claude/state/active_task_graph.json
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Task `failed` | Agent crash detected | Auto-retried up to 2x; check `retry_count` |
| Task stuck `in_progress` | Agent hung (no crash) | Re-spawn same task |
| `tests_passed` missing | No recognizable output | Re-spawn, ensure test markers in output |
| Wave not advancing | Gate blocked | Check `wave_gates[N].blocked`, run `/wave-gate` |
| State write blocked | Guard hook active | State writes via hooks only; reads OK |
| Test task blocked, impl wrote tests | Separate test task for new code | Don't create separate test tasks; mark superseded or merge |

### Fixing Blocked Waves

When blocked (critical findings), Edit/Write blocked too. To fix:
1. **Re-spawn via Task** — create fix agent with findings context (subagent CAN Edit/Write)
2. **Run `/wave-gate`** — re-reviews only blocked tasks
3. **Override false positives** — pipe corrected findings through whitelisted helpers (guard hook allows these):
   ```bash
   # Override spec-check (e.g. FRs covered in later waves flagged as missing)
   echo 'SPEC_CHECK_WAVE: N
   SPEC_CHECK_CRITICAL_COUNT: 0
   SPEC_CHECK_VERDICT: PASSED
   MEDIUM: reason for override' | bun ${LOOM_DIR}/engine/src/cli.ts helper store-spec-check

   # Override review findings (e.g. downgrade false critical to advisory)
   echo 'ADVISORY: original finding — reason for downgrade' | bun ${LOOM_DIR}/engine/src/cli.ts helper store-review-findings --task T1
   ```
   Then run `complete-wave-gate` to advance. Use only when findings are genuinely false positives — requires user approval.
4. **Emergency**: remove state file, fix manually, rebuild from GH issue

---

## Constraints

- **ALL phases via agents** - brainstorm, specify, clarify, architecture, decompose agents
- **ALL implementation via Task tool** - Edit/Write/MultiEdit blocked
- **ALL state writes via hooks** - Bash writes blocked (exception: `start_sha` PreToolUse write)
- **NEVER skip phases** unless explicit `--skip-X` flag provided
- **NEVER proceed with >3 unresolved markers** without user acknowledgment or `--skip-clarify`
- Only ONE active plan at a time

---

## Phase Enforcement (Hooks)

Two hooks enforce phase ordering:

### PreToolUse: `validate-phase-order.sh`
Blocks agent spawns if prerequisite phases not complete.

| Target Agent | Requires |
|--------------|----------|
| specify-agent | brainstorm complete OR `--skip-brainstorm` |
| clarify-agent | spec.md exists |
| architecture-agent | spec.md exists + markers ≤ 3 OR `--skip-clarify` |
| impl agents | plan.md exists |

### SubagentStop: `advance-phase.sh`
Advances `current_phase` when phase agents complete.

| Agent Completes | Next Phase |
|-----------------|------------|
| brainstorm-agent | specify |
| specify-agent | clarify (if markers > 3) OR architecture |
| clarify-agent | architecture |
| architecture-agent | decompose |

**Artifact verification:** `advance-phase.sh` verifies expected files exist on disk before advancing:
- After `specify`: checks `spec_file` exists
- After `architecture`: checks `plan_file` exists

### State Tracking

```json
{
  "current_phase": "specify",
  "phase_artifacts": {
    "brainstorm": "completed",
    "specify": null,
    "clarify": null,
    "architecture": null
  },
  "skipped_phases": ["clarify"]
}
```

### Skip Flags

- `--skip-brainstorm` - Adds "brainstorm" to `skipped_phases`, starts at specify
- `--skip-clarify` - Adds "clarify" to `skipped_phases`, proceeds to architecture regardless of markers
- `--skip-specify` - Adds brainstorm, specify, clarify to skipped; requires existing spec.md

---

## Error Recovery

| Failure | Recovery |
|---------|----------|
| Brainstorm agent unclear | Re-spawn with more specific prompt |
| Specify agent too technical | Re-spawn with "focus on WHAT not HOW" |
| Clarify agent stuck | Ask user to resolve remaining markers |
| Architecture agent off-spec | Re-spawn referencing spec requirements |
| Implementation agent fails tests | Re-spawn with error context |
| Wave gate blocked | Fix issues, re-run `/wave-gate` |

---

## Plan Limits

- **Max tasks:** 8-12 (split if larger)
- **Max waves:** 4-5
- **Max parallel tasks per wave:** 4-6

---

## CRITICAL: Agent Spawning

Each phase spawns ONE agent (except Execute which spawns wave tasks in parallel).

**Sequential phases:** brainstorm → specify → clarify → architecture
**Parallel within wave:** T1, T2, T3 in same message

Pass context forward between phases via agent outputs.
