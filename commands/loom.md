---
name: loom
version: "3.2.0"
description: "This skill should be used when the user asks to 'plan this', 'orchestrate', 'break down', 'split into phases', 'coordinate tasks', 'create a plan', 'multi-step feature', or has complex tasks needing structured decomposition. Decomposes work into wave-based parallel tasks, assigns specialized agents, creates GitHub Issue for tracking, and manages execution through automated hooks."
---

# Loom - Full Orchestration Skill

Orchestrates the COMPLETE feature lifecycle: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute.

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
LOOM_DIR=$(ls -d "$HOME/.claude/plugins/cache/"*"/loom"/*/ 2>/dev/null | tail -1 | sed 's:/$::')
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
- `/loom --skip-plan-alignment` - Skip plan-alignment phase (proceed directly to decompose)
- `/loom --panel` - Architecture panel mode: N designer agents generate candidates in parallel (each with a lens), adversarial judges rank them against interview-derived criteria, the finalizer synthesizes and presents them at the approach gate. Opt-in; standard mode is untouched. `--panel=N` sets the designer count (default `PANEL_DESIGNERS_DEFAULT` in `engine/src/config.ts`). N is capped at the number of distinct lenses (5) — each designer takes exactly one lens (see [panel-lenses.md](../references/panel-lenses.md)). Only affects Phase 3. See [Phase 3 (panel mode)](#phase-3-panel-mode-loom---panel).
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
│   --panel: interviewer → N designers ∥ → judges ∥ →     │
│            finalize (architecture-agent)                │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ Phase 3.5: PLAN ALIGNMENT                               │
│   Agent: plan-alignment-agent                           │
│   Output: .claude/specs/{slug}/plan-alignment.md        │
│   Skip: --skip-plan-alignment                           │
│   Loop: gaps found → re-run architecture (with context) │
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
- Executable models declared, if any (LC-N lifecycles, Pipeline AuthoredDag, INV-N invariants + rule files) — these are validated against the task graph in Phase 4a

**If `--panel` was passed, use [Phase 3 (panel mode)](#phase-3-panel-mode-loom---panel) below instead of the single-agent spawn above.** Everything downstream (extraction, plan-alignment, decompose) is identical — panel mode still produces exactly one `plan.md` via one architecture-agent completion.

---

## Phase 3 (panel mode): `/loom --panel`

Runs only when `--panel` (or `--panel=N`) is passed. The `current_phase` stays `"architecture"` throughout — the engine recognizes the panel agents (`arch-interviewer-agent`, `arch-designer-agent`, `arch-judge-agent`) as architecture-phase work but never advances the phase on their completion; only the final `architecture-agent` spawn advances to plan-alignment, exactly as standard mode does.

Defaults: **N designers** = `PANEL_DESIGNERS_DEFAULT` (`engine/src/config.ts`, currently 3) or the `clampPanelDesigners(--panel=N)` value, **K = `PANEL_JUDGES_DEFAULT` judges** (`engine/src/config.ts`, currently 3 — one per criterion, not user-configurable). The candidate/interview artifacts live under the spec dir; they are NOT guarded state.

### Step 1 — Interview (once, interactive)

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-interview.md`. Substitute `{feature_description}`, `{spec_file_path}`, `{interview_file_path}` (= `.claude/specs/{date_slug}/interview.md`).

**Spawn `arch-interviewer-agent`.** Wait for completion. **Verify `interview.md` exists** at the path — if not, re-spawn. Read it: the labeled fields (`**Primary axis:**`, `**Testability bar:**`, `**Sensitive boundaries:**`, `**Codebase maturity:**`, …) drive lens and judge selection below.

### Step 2 — Select lenses

Read the lens fragments from `{LOOM_DIR}/references/panel-lenses.md`. Choose N lenses:

- **Always include** `simplicity-first` and `type-driven-fp`.
- **Third lens (and any beyond N=3) from interview signals**, in priority order:
  - `**Sensitive boundaries:**` = `flagged` → `risk-security-first`
  - `**Primary axis:**` = performance → `performance-first`
  - `**Codebase maturity:**` = brownfield → `codebase-conventionist`
  - If none apply (or you need a 4th/5th for larger N), fill from the remaining lenses in the table order.

Take the first N distinct lenses. Each designer gets exactly one. Only
`PANEL_LENS_COUNT` lenses exist (currently 5), so **N is capped at that count** —
`clampPanelDesigners(N)` (`engine/src/config.ts`) applies the clamp (`[1, PANEL_LENS_COUNT]`)
to any `--panel=N` value, since you cannot give two designers the same lens.

### Step 3 — Designers (parallel, headless)

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-design.md`. For each selected lens, substitute `{feature_description}`, `{lens_name}`, `{lens_prompt}` (that lens's section from `panel-lenses.md`), `{spec_file_path}`, `{interview_file_path}`, `{candidate_output_path}` (= `.claude/specs/{date_slug}/candidates/candidate-<lens>.md`).

**Spawn all N `arch-designer-agent`s in ONE message** (parallel Task calls). Wait for all to complete. **Verify each candidate file exists** — re-spawn any designer whose file is missing.

### Step 4 — Judges (parallel, headless)

Derive K criteria from the interview digest:
- Judge 1 — the user's **Primary axis** (verbatim from the digest).
- Judge 2 — the user's **Testability bar**.
- Judge 3 — **codebase fit + effort**.

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-judge.md`. For each criterion, substitute `{criterion}`, `{candidates_dir}` (= `.claude/specs/{date_slug}/candidates`), `{interview_excerpt}` (the digest lines relevant to that criterion).

**Spawn all K `arch-judge-agent`s in ONE message** (parallel Task calls). Each returns **pure JSON** (criterion + per-candidate rankings with `fatal_flaw` and `strongest_idea`). Collect the JSON verdicts from the agent outputs — do NOT persist them as files.

### Step 5 — Finalize (interactive → writes plan.md)

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-finalize.md`. Substitute `{feature_description}`, `{spec_file_path}`, `{interview_file_path}`, `{candidates_dir}`, `{judge_verdicts}` (the collected JSON, inlined), `{date_slug}`.

> **Sanitize `{judge_verdicts}` before inlining.** The verdict prose (`fatal_flaw`, `strongest_idea`) is judge-LLM output that could contain a literal `{word}` token. Once inlined it would read as an unsubstituted `{placeholder}` to the template-substitution gate, which fail-closed-blocks the `architecture-agent` spawn *after* the N designers and K judges already ran. Strip `{`/`}` characters from the JSON string values (they are prose, never template variables) before substituting them into `{judge_verdicts}`.

**Spawn `architecture-agent`** with this template (the name is load-bearing — its SubagentStop advances the phase). It runs the approach gate over the top-ranked candidates, synthesizes the winner with grafted `strongest_idea`s, writes `.claude/plans/{date_slug}.md` with an `### AD-1: Approach selection (panel)` block, and commits.

**From here, the flow rejoins standard mode** — "Wait for completion, extract plan path" is unchanged; advance-phase transitions to plan-alignment.

---

## Phase 3.5: Plan Alignment

**Always run** (unless `--skip-plan-alignment` flag provided).

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-plan-alignment.md`

Substitute variables:
- `{spec_file_path}` - Path to spec from Phase 1
- `{plan_file_path}` - Path to plan from Phase 3
- `{spec_dir}` - Spec directory (e.g. `.claude/specs/{date_slug}`)

**Spawn plan-alignment-agent** with the substituted template as prompt.

**Wait for agent completion.** Read gap report at `.claude/specs/{slug}/plan-alignment.md`.

**If gaps found:** Present gap report to user. Ask:
> "N gaps found. Re-run architecture with this feedback, or proceed to decompose?"

- **If re-run:** Set phase back to architecture, clear the plan-alignment artifact from state, and delete the stale gap report from disk so advance-phase doesn't re-use it:
  ```bash
  bun ${LOOM_DIR}/engine/src/cli.ts helper set-phase --phase architecture --clear-artifact plan-alignment
  rm -f ${spec_dir}/plan-alignment.md
  ```
  Re-spawn architecture-agent with gap report appended to prompt as additional context. When architecture completes, advance-phase transitions to plan-alignment again automatically.

  **Panel-mode loop-back:** even if the plan was produced in `--panel` mode, a gap-report re-run uses the **standard single-agent architecture flow** (`phase-architecture.md`) — never re-panel. Mention the candidates dir (`.claude/specs/{date_slug}/candidates/`) in the re-spawn prompt as available context so the agent can revisit the losing designs, but the panel does not run again.
- **If proceed:** Continue to Phase 4.

**Loop-back warning:** If the user has chosen to re-run architecture 2 or more times, warn: "This is loop-back attempt N. Consider proceeding to decompose or refining the spec directly."

**If no gaps:** Proceed to Phase 4.

**Note:** The gap report is always written (even when no gaps). Its existence at `.claude/specs/{slug}/plan-alignment.md` is required by validate-phase-order to gate decompose entry.

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

The validator also cross-checks executable-model bindings when the plan declares them (`## Lifecycles` / `## Pipeline` / `## Invariants`): every LC-N machine file must appear in a task's `file_list`, the AuthoredDag sidecar must exist and be structurally sound, every checkable INV-N rule file must exist, and near-miss declarations (typo'd headings/labels) are errors. See `references/executable-models.md`. These same checks run fail-closed inside `populate-task-graph` (4d), so they cannot be skipped.

**Routing validation failures — read the error text:**
- Errors about the *task graph* (unknown agent, wave ordering, or an LC machine file "not in any task's file_list") → **re-spawn decompose-agent** with the error details. Decompose can fix these.
- Errors about the *plan or its artifacts* (missing `**Machine file:**` / `**Tier:**` / `**Rule file:**` lines, "Model declaration problem" / near-miss headings, AuthoredDag or rule file missing/malformed, plan_file unreadable) → decompose can NEVER fix these; re-spawning it just loops. **Loop back to Phase 3** with the same mechanics as the plan-alignment loop-back:
  ```bash
  bun ${LOOM_DIR}/engine/src/cli.ts helper set-phase --phase architecture --clear-artifact plan-alignment
  rm -f ${spec_dir}/plan-alignment.md
  ```
  Re-spawn architecture-agent with the validator errors appended as additional context.

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

Use the `populate-task-graph` helper (one of the state-writing helpers whitelisted in `engine/src/config.ts` and enforced by the guard-state-file hook). It re-runs the executable-model binding checks fail-closed before writing:

```bash
echo "$DECOMPOSE_OUTPUT" | bun ${LOOM_DIR}/engine/src/cli.ts helper populate-task-graph --issue ISSUE_NUMBER --repo OWNER/REPO
```

This helper:
- Reads existing state (phase tracking fields)
- Merges with validated decompose output (tasks, waves)
- Adds `github_issue`, `spec_file`, `plan_file`, `current_wave: 1`
- Initializes `wave_gates`, `executing_tasks`
- Writes via `StateManager` (chmod 444 protection)

**C. Read-only protection (automatic):** The helper leaves the file chmod 444 — do **not** run `chmod` yourself; `chmod` is not an allowlisted read-only command, so the guard-state-file hook blocks it. State file stays chmod 444 at rest. Hooks and whitelisted helpers (`populate-task-graph`, `complete-wave-gate`, `set-phase`, …) write via `StateManager` (temporarily toggles to 644).

### 4e. Context Checkpoint (Recommended)

After populating the task graph and creating the GitHub issue, all planning artifacts are on disk.
The planning conversation is no longer needed for execution.

**Suggest to user:**
> "Planning complete. All artifacts on disk. Run `/clear` to shed planning context before execution, or continue in current context."

If user runs `/clear`: SessionStart hook auto-injects execution context. Continue from Phase 5.
If user continues: Proceed to Phase 5 normally.

---

## Phase 5: Execute

For each wave:

1. Get pending tasks in the current wave (crashed tasks remain `pending` and are re-spawned)
2. Spawn ALL wave tasks in parallel (single message, multiple Task calls)
3. Wait for all to reach "implemented"
4. If any wave task never reached `implemented` (agent crashed): re-spawn it (still `pending`, `executing_tasks` was cleared)
5. **RUN `/wave-gate` — MANDATORY, via subagents** (see below)
6. If blocked (critical findings): spawn fix agents with the findings, re-run `/wave-gate`
7. **Triage advisory findings and fix the RELEVANT ones** before advancing (see [Addressing Advisories](#addressing-advisories)). Advisories do not block the gate, but must not be silently dropped.
8. Once the gate passes AND relevant advisories are addressed: advance to next wave

### Wave-Gate Enforcement (NON-NEGOTIABLE)

**You MUST invoke `/wave-gate` by spawning review subagents.** You are NEVER allowed to:
- Review code yourself inline and declare it "passed"
- Skip the wave-gate and proceed to the next wave
- Manually set `reviews_complete: true` in state

**The wave-gate spawns these agents (see `commands/wave-gate.md` for full protocol):**
1. `spec-check-invoker` — verifies implementation satisfies spec anchors (1 per wave)
2. Per task: `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`

**All spawned in parallel via Task/subagent tool.** SubagentStop hooks automatically update state. Then `complete-wave-gate` helper advances the wave.

**The `validate-task-execution` hook enforces this:** it blocks next-wave impl agents if `wave_gates[N-1].reviews_complete == false`. Even if you try to skip, the hook will BLOCK.

**Re-spawn logic:** After spawning, check for pending wave tasks whose agent did not complete (a crashed agent leaves the task `pending` with `executing_tasks` cleared). Resolve the current wave inside the jq program — the guard blocks `WAVE=$(jq … state)` capture-into-variable, and shell vars don't persist across Bash tool calls:
```bash
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w and .status == "pending") | .id' .claude/state/active_task_graph.json
```
Re-spawn each pending wave task whose agent did not reach `implemented`.

**Load template:** Read `{LOOM_DIR}/commands/templates/impl-agent-context.md`

Substitute variables:
- `{task_id}`, `{wave}`, `{agent_type}`, `{dependencies}`
- `{task_description}` - From task breakdown
- `{spec_anchors_formatted}` - Formatted anchor list with requirement text
- `{plan_context}` - Relevant section from plan
- `{file_list}` - Files to create/modify
- `{plan_file_path}` - Path to full plan
- `{rules_content}` - **Inline the binding rules (do NOT leave a file path).** Read `{LOOM_DIR}/rules/architecture.md` (always) plus the stack-specific file(s) — `typescript-patterns.md` for TypeScript/Next.js, `java-patterns.md` + `property-testing.md` for Java, `rust-patterns.md` for Rust — and substitute their full concatenated contents here. The `validate-template-substitution` hook blocks the spawn if `{rules_content}` is left unsubstituted. For docs/config-only tasks (e.g. ADR writing) substitute the literal text `N/A — no code in this task.`

**Spawn implementation agent** with the substituted template as prompt.

---

## Quick Start Examples

### Full flow (recommended):
```
/loom "Add user authentication with email/password"
```
Runs: brainstorm → specify → clarify → arch → plan-alignment → decompose → execute

### Skip to architecture (spec exists):
```
/loom --skip-specify "Add user authentication"
```
Runs: arch → plan-alignment → decompose → execute (uses existing spec)

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
  [--skip-brainstorm] [--skip-clarify] [--skip-specify] [--skip-plan-alignment] \
  --spec-dir .claude/specs/{date_slug} \
  --output .claude/state/active_task_graph.json
```

<!-- Schema reference (for understanding the state shape):
{
  "current_phase": "init",       // or "specify"/"architecture" depending on skip flags
  "phase_artifacts": {},
  "skipped_phases": [],          // e.g. ["brainstorm","specify","clarify"] for --skip-specify
                                 // e.g. ["plan-alignment"] for --skip-plan-alignment
  "spec_dir": ".claude/specs/{date_slug}",
  "spec_file": null,             // set automatically for --skip-specify
  "plan_file": null,
  "tasks": [],
  "wave_gates": {}
}
-->

**IMPORTANT:** The engine sets `chmod 444` automatically at creation (`cli.ts init-state`) and after every `StateManager` write — do **not** run `chmod` yourself; the guard-state-file hook blocks it. This activates OS-level write protection — subagent Write tool calls will get EACCES. Only hooks and whitelisted helpers writing via `StateManager` can modify the file.

After Phase 4 (Decompose), the task graph is populated with tasks, waves, and GitHub issue info. This is done by passing decompose output through the `validate-task-graph` helper and writing the full state via `populate-task-graph`.

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
| `enforce-phase-tools.sh` | PreToolUse: Edit/Write/MultiEdit | Guarded-skill-machine gate: denies enforced tools the bound agent's phase doesn't allow (fails closed) |
| `guard-state-file.sh` | PreToolUse: Bash | Deny-by-default on guarded state paths: only read-only commands (`jq`, `cat`, `grep`, …) and whitelisted helpers pass — covers task graph + subagent evidence/binding files + machine definitions |
| `validate-task-execution.sh` | PreToolUse: Task | Validates wave order |
| `validate-phase-order.sh` | PreToolUse: Task | Enforces phase sequencing |
| `validate-template-substitution.sh` | PreToolUse: Task | Blocks unsubstituted `{variable}` patterns |
| `validate-agent-model.sh` | PreToolUse: Task | Validates agent model assignment |
| `validate-agent-skill.sh` | PreToolUse: Task | Validates agent skill preload |
| `mark-subagent-active.sh` | SubagentStart | Tracks active subagents + binds the guarded skill machine (epoch) |
| `record-evidence.sh` | PostToolUse: Read/Edit/Write/MultiEdit/Bash | Appends epoch-stamped facts (FileRead/FileWrite/TestRun) to the evidence ledger |
| `lint-file.sh` | PostToolUse: Edit/Write/MultiEdit | Runs the immediate-tier linter (regex rules only; programmatic rules run at the wave gate) |
| `cleanup-stale-subagents.sh` | SessionStart | Sweeps stale subagent tracking/binding files |
| `resume-after-clear.sh` | SessionStart: clear | Restores loom context after /clear |
| `dispatch.sh` | SubagentStop | Routes to the TS handlers below (`engine/src/handlers/subagent-stop/`) by agent type |
| ↳ `advance-phase.ts` | via dispatch | Advances phase + captures spec_file/plan_file from transcript |
| ↳ `update-task-status.ts` | via dispatch | Marks "implemented" + test evidence + new-test verification |
| ↳ `store-reviewer-findings.ts` | via dispatch | Parses review findings |
| ↳ `store-spec-check-findings.ts` | via dispatch | Parses spec-check findings |
| ↳ `cleanup-subagent-flag.ts` | via dispatch | Cleans up subagent tracking + machine bindings (always runs) |

**Do not call hook-owned state-writing helpers yourself.** The helpers that hooks/`/wave-gate` drive — `complete-wave-gate`, `StateManager`, `store-review-findings`/`store-spec-check` (except as a sanctioned override, below) — run automatically; calling them by hand races the hook that owns that write. A small set of DIRECT helper invocations IS sanctioned, used only where this document says to; they fall into two distinct classes:

- **Whitelisted in the guard** (`engine/src/config.ts` `WHITELISTED_HELPERS`, so the guard permits them even on a guarded path): `populate-task-graph` (Phase 4d), `set-phase` loop-back, `mark-tests-passed` (read-only evidence status check, run during `/wave-gate` Step 2 — it reads the ledger and does NOT modify state), and the `store-review-findings` / `store-spec-check` false-positive overrides.
- **Merely out of the guard's scope when invoked as documented** (NOT in `WHITELISTED_HELPERS`): `validate-task-graph` / `validate-lint-rules` — they pass only because their documented invocations name no guarded path, so the guard's front gate never fires. Invoked against a guarded path they would be blocked like anything else.

Each sanctioned direct invocation still requires user approval. Everything else is hook-driven.

---

## Operations Reference

### Status Transitions

```
pending → implemented    (agent completes; SubagentStop hook resolves test evidence)
pending → pending        (agent crash: no task ID resolvable; executing_tasks cleared, task re-spawned)
implemented → completed  (wave gate passed: tests + review + no critical findings)
```

### Observability

```bash
# Current state
jq '.' .claude/state/active_task_graph.json

# Per-task status
jq '.tasks[] | {id, status, test_result, review_status}' .claude/state/active_task_graph.json

# Wave gate status
jq '.wave_gates' .claude/state/active_task_graph.json
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Task stuck `pending` after agent ran | Agent crashed (no resolvable task ID) | `executing_tasks` cleared automatically; re-spawn the task |
| Task stays `pending`, agent still running | Agent live (no crash; tracked via `executing_tasks`, there is no `in_progress` status) | Wait for it, or re-spawn if hung |
| `test_result` missing or not a pass | No recognizable output | Re-spawn, ensure test markers in output |
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
4. **Emergency**: the guard blocks a direct `rm` of the state file — use the whitelisted helper `bun ${LOOM_DIR}/engine/src/cli.ts helper cleanup-state`, then fix manually / rebuild from the GH issue

### Addressing Advisories

Critical findings **block** the gate. Advisory findings do **not** — but loom does not ignore them. After each wave gate, triage every advisory finding before advancing:

**Classify each advisory:**
- **Relevant** — in scope for the task, actionable, and consistent with project standards (the repo's `CLAUDE.md` / conventions). These get **fixed**.
- **Not relevant** — out-of-scope refactor, nitpick that contradicts an established project convention, false positive, or work deliberately deferred to a later wave. These are **recorded** with a one-line reason, not fixed.

**Fix relevant advisories** the same way as criticals — spawn a fix subagent via Task (Edit/Write are blocked for the orchestrator), give it the advisory text + file context, and have it make the minimal change. Re-run `/wave-gate` so the fix is re-reviewed.

**Best-effort, non-blocking:** if a relevant advisory can't be fixed cleanly (breaks tests, needs an upstream change), defer it with a reason rather than blocking the wave. Never silently drop an advisory — every advisory ends as *fixed*, *deferred (reason)*, or *dismissed (reason)*.

---

## Constraints

- **ALL phases via agents** - brainstorm, specify, clarify, architecture, plan-alignment, decompose agents
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
| plan-alignment-agent | plan.md exists |
| impl agents | plan.md exists + plan-alignment.md exists OR `--skip-plan-alignment` |

### SubagentStop: `advance-phase.sh`
Advances `current_phase` when phase agents complete.

| Agent Completes | Next Phase |
|-----------------|------------|
| brainstorm-agent | specify |
| specify-agent | clarify (if markers > 3) OR architecture |
| clarify-agent | architecture |
| architecture-agent | plan-alignment (OR decompose if `--skip-plan-alignment`) |
| plan-alignment-agent | decompose |

**Artifact verification:** `advance-phase.sh` verifies expected files exist on disk before advancing:
- After `specify`: checks `spec_file` exists
- After `architecture`: checks `plan_file` exists
- After `plan-alignment`: checks `plan-alignment.md` exists in spec dir

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
- `--skip-plan-alignment` - Adds "plan-alignment" to `skipped_phases`; architecture advances directly to decompose

---

## Error Recovery

| Failure | Recovery |
|---------|----------|
| Brainstorm agent unclear | Re-spawn with more specific prompt |
| Specify agent too technical | Re-spawn with "focus on WHAT not HOW" |
| Clarify agent stuck | Ask user to resolve remaining markers |
| Architecture agent off-spec | Re-spawn referencing spec requirements |
| Plan-alignment agent fails to write report | Re-spawn plan-alignment-agent; check spec_dir is writable |
| Plan-alignment gaps unresolvable | Use `--skip-plan-alignment` or manually amend plan before proceeding |
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

**Sequential phases:** brainstorm → specify → clarify → architecture → plan-alignment
**Parallel within wave:** T1, T2, T3 in same message

Pass context forward between phases via agent outputs.
