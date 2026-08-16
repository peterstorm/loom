---
name: loom
version: "3.2.0"
description: "This skill should be used when the user asks to 'plan this', 'orchestrate', 'break down', 'split into phases', 'coordinate tasks', 'create a plan', 'multi-step feature', or has complex tasks needing structured decomposition. Decomposes work into wave-based parallel tasks, assigns specialized agents, creates GitHub Issue for tracking, and manages execution through automated hooks."
argument-hint: "[$description] [--skip-brainstorm] [--skip-clarify] [--skip-specify] [--skip-plan-alignment] [--panel[=N]] [--status]"
---

# Loom - Full Orchestration Skill

Orchestrates the COMPLETE feature lifecycle: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute.

**This is the SINGLE ENTRY POINT** for multi-step features. Spawns specialized agents for each phase.

**Arguments:** "$ARGUMENTS"

## Prerequisites

**BEFORE starting any phase**, run this check:
```bash
command -v bun || echo "FATAL: bun not found. Run: nix develop ./.claude"
```
If `bun` is missing, **STOP and tell the user**. Loom hooks require bun for TypeScript transcript parsing. Dev shell: `nix develop ./.claude`

## Setup: Resolve Package Path

**FIRST STEP of every `/loom` invocation** — bind this command to the package
that supplied it. Claude Code expands the token in the shared source; Loom's Pi
adapter renders it from the extension module's `import.meta.url`:
```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR"; exit 1; }
printf 'LOOM_DIR=%s\n' "$LOOM_DIR"
```

Never infer package identity from cwd and never scan another harness's install
cache. Store the printed path. **All subsequent references use it:**
- Templates: `{LOOM_DIR}/commands/templates/<name>.md`
- Engine CLI: `bun {LOOM_DIR}/engine/src/cli.ts`
- References: `{LOOM_DIR}/references/<name>.md`

### Explicit LLM Profile contract

Every Loom-owned Agent has one semantic LLM Profile with complete Claude Code
and Pi bindings. Before each spawn, resolve it:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper model-profiles agent --agent "<AGENT_NAME>"
```

- **Claude Code:** pass the emitted `claudeCode.model` explicitly in the
  `Agent`/`Task` call. It must match the agent's `model:` frontmatter.
- **Pi:** the selected agent definition must contain the emitted exact
  `pi.provider/pi.model:pi.thinking` model pattern. Run
  `{LOOM_DIR}/scripts/sync-pi-agents.sh` after install/update.

Missing or mismatched requested bindings BLOCK. Never omit a model. Pi launcher
routing may explicitly inherit a local parent model; that transport policy is
validated at the Pi spawn seam and is never inferred by this runbook.

---

## Arguments

- `/loom "description"` - Start new plan (runs full flow)
- `/loom --skip-brainstorm` - Skip brainstorm phase (scope already clear)
- `/loom --skip-clarify` - Skip clarify phase (accept markers as-is)
- `/loom --skip-specify` - Skip brainstorm/specify/clarify (use existing spec)
- `/loom --skip-plan-alignment` - Skip plan-alignment phase (proceed directly to decompose)
- `/loom --panel` - Architecture panel mode: N designer agents generate candidates in parallel (each with a lens), adversarial judges rank them against interview-derived criteria, and the finalizer presents the ranked approaches. `--panel=N` requires a decimal integer of at least `PANEL_DESIGNERS_MIN` (currently 2); malformed, fractional, duplicate, or smaller values are rejected. Values above the number of distinct lenses (5) are rejected. Bare `--panel` uses `PANEL_DESIGNERS_DEFAULT` (currently 3). Opt-in; only Phase 3 changes. See [panel-lenses.md](../references/panel-lenses.md) and [Phase 3 (panel mode)](#phase-3-panel-mode-loom---panel).
- `/loom --status` - Show current status. Runs `bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration status` (add `--json` for the machine form). Both forms project ONE `LoomStatus` value, so they cannot disagree, and neither re-runs a gate check. When authority is unreadable every fact category is still reported as `unavailable` with its reasons and the next action is `blocked` — never a fabricated zero-or-ready value. Prefer this over the ad-hoc `jq` recipes in [Observability](#observability), which read raw fields and can contradict the engine.
- The engine also exposes registered architecture/refutation panel dispatch through `helper orchestration start`. The detailed Phase 3 runbook below still owns interactive/template/file integration through the panel-contract helper chain; do not mix the two persistence protocols inside one panel run.
- `/loom --complete` - Not implemented as a flag. After proving completion, use the guarded `helper cleanup-state` only with explicit operator intent.
- `/loom --abort` - Not implemented as a flag. Use `helper cleanup-state` for deliberate teardown and preserve plan/spec/review audit artifacts.

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
- `{loom_dir}` - the exact `LOOM_DIR` resolved during setup

**Spawn architecture-agent** with the substituted template as prompt.

**Wait for agent completion.** Extract:
- Plan file path
- Implementation phases
- Executable models declared, if any (LC-N lifecycles, Pipeline AuthoredDag, INV-N invariants + rule files) — these are validated against the task graph in Phase 4a

**If `--panel` was passed, use [Phase 3 (panel mode)](#phase-3-panel-mode-loom---panel) below instead of the single-agent spawn above.** Everything downstream (extraction, plan-alignment, decompose) is identical — panel mode still produces exactly one `plan.md` via one architecture-agent completion.

---

## Phase 3 (panel mode): `/loom --panel`

Runs only when `--panel` (or `--panel=N`) is passed. Reject multiple panel flags. Bare `--panel` uses `PANEL_DESIGNERS_DEFAULT`; for `--panel=N`, require `N` to match `^[0-9]+$` and be at least `PANEL_DESIGNERS_MIN`, then require it to be at most `PANEL_LENS_COUNT`. This is the markdown shell's executable contract mirroring `engine/src/config.ts`; never silently reinterpret malformed/fractional input.

The `current_phase` stays `"architecture"` throughout. Panel agents are accepted only while that current phase is active and never advance it; the final `architecture-agent` advances to plan-alignment, or directly to decompose when `--skip-plan-alignment` is set.

Defaults: **N designers** = `PANEL_DESIGNERS_DEFAULT` (currently 3), minimum `PANEL_DESIGNERS_MIN` (currently 2), maximum `PANEL_LENS_COUNT` (currently 5); **K = `PANEL_JUDGES_DEFAULT` judges** (currently 3, fixed at one per criterion).

### Step 0 — Create a run-scoped artifact boundary

Create a unique directory under the spec dir before spawning any panel agent:

```bash
PANEL_RUNS_DIR=".claude/specs/{date_slug}/panel-runs"
mkdir -p "$PANEL_RUNS_DIR" || exit 1
PANEL_RUN_DIR="$(mktemp -d "$PANEL_RUNS_DIR/run.XXXXXXXXXX")" || exit 1
mkdir "$PANEL_RUN_DIR/candidates" "$PANEL_RUN_DIR/verdicts" || exit 1
PANEL_RUN_ID="${PANEL_RUN_DIR##*/}"
printf '%s\n' "$PANEL_RUN_DIR"
```

Retain the printed path in orchestration context and substitute its concrete value in later calls; do not assume shell variables persist across Bash tool calls. Never reuse an existing run directory. All interview, candidate, manifest, and verdict artifacts for this invocation live under this directory. Old runs may remain as audit data but are never discovered or read implicitly.

### Step 1 — Interview (once, interactive)

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-interview.md`. Substitute `{feature_description}`, `{spec_file_path}`, `{interview_file_path}` (= `<panel-run-dir>/interview.md`), and `{loom_dir}` (= the already resolved `LOOM_DIR`).

**Spawn `arch-interviewer-agent`.** Wait for completion. Require the exact new file to be non-empty (`test -s`); because the run directory is unique, a prior run cannot satisfy this check. Validate and canonicalize the digest before fan-out:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract interview \
  < "<panel-run-dir>/interview.md" \
  > "<panel-run-dir>/interview.json"
```

On any contract error (missing/duplicate/empty label or invalid enum), delete this run's invalid digest/JSON and re-spawn the interviewer with the field-level diagnostics. Retry once; if it is still invalid, stop panel mode and report the error. Lens and judge selection consume only the validated JSON.

### Step 2 — Select lenses

Read the lens fragments from `{LOOM_DIR}/references/panel-lenses.md`. Choose N lenses from `<panel-run-dir>/interview.json`:

- **Always include** `simplicity-first` and `type-driven-fp` (which is why N cannot be below 2).
- **Third lens (and any beyond N=3) from validated interview signals**, in priority order:
  - `sensitiveBoundaries` begins `flagged` → `risk-security-first`
  - `primaryAxis` = `performance` → `performance-first`
  - `codebaseMaturity` = `brownfield` → `codebase-conventionist`
  - Fill remaining slots from the lens table order.

Take exactly N distinct lenses. Before designers spawn, write `<panel-run-dir>/manifest.json` with `run_id`, `interview_file`, `interview_json`, and an exact `candidates` array. Every candidate entry contains `lens`, `path` (`<panel-run-dir>/candidates/candidate-<lens>.md`), and bare `filename`. Build JSON with `jq -n`/`--arg` rather than string concatenation, then validate it immediately:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract manifest \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>"
```

Stop on failure. The helper binds run id, interview paths, allowed unique lenses, filenames, and candidate paths to this manifest's run directory. This manifest is the sole candidate-set authority for all later stages.

### Step 3 — Designers (parallel, headless)

The executable Panel Program, not this prose, owns dispatch order, retry limits,
and LLM Profiles. Before spawning, obtain the criteria early with the Step 4
`criteria` helper (it does not require candidate files), then build:

```json
{
  "input": {
    "candidateLenses": ["<manifest lens 1>", "<manifest lens N>"],
    "judgeCriteria": ["<derived criterion 1>", "<derived criterion 3>"]
  },
  "events": []
}
```

Pipe it to:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-program architecture
```

The returned first action MUST be the exact designer `spawn-batch`. After every
spawn or engine operation, append its canonical `spawn-outcome` or
`engine-outcome` event and replay the document; execute only the newly returned
action. This event-sourced replay makes completion order irrelevant and permits
one retry per failed slot. Stop on `blocked`; do not hand-advance a stage.

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-design.md`. For each manifest entry, substitute `{feature_description}`, `{lens_name}`, `{lens_prompt}`, `{spec_file_path}`, `{interview_file_path}` (= the manifest interview file), and `{candidate_output_path}` (= that exact entry's path).

**Spawn the exact `arch-designer-agent` batch returned by the Panel Program in ONE message** (parallel Agent calls), using each request's resolved `modelProfile`. Wait for all to complete. For every manifest path, require a non-empty regular file that is not a symbolic link. For a failed entry, delete that run's empty/invalid artifact, re-spawn only that designer once, then repeat the same regular/non-empty/non-symlink check; stop if the retry still fails. Compare the candidate directory's bare filenames with `manifest.candidates[].filename` in both directions and stop on any missing or extra file. Judges and finalizer still read only manifest paths, never the directory.

### Step 4 — Judges (parallel, headless)

**Get the exact ordered criteria from the helper** — do not derive them by hand:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract criteria \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>"
```

It emits a JSON array of exactly K criteria derived from the validated digest: `primaryAxis` (verbatim), `testabilityBar` (verbatim), then the fixed `codebase fit + effort`. This is the single source of truth for both the criteria and their order — the `verdict` operation rejects any `--criterion` outside this set, and `aggregate` re-derives the same list, so the judge stage and the finalizer can no longer disagree.

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-judge.md`. For each criterion, substitute `{criterion}`, `{candidate_manifest_path}`, and `{interview_json_path}`.

**Spawn the exact `arch-judge-agent` batch returned by the Panel Program in ONE message** (parallel Agent calls), using each request's resolved `modelProfile`. Validate each raw output before it reaches finalization:

```bash
printf '%s' "$RAW_JUDGE_OUTPUT" | bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract verdict \
  --criterion "$EXACT_CRITERION" \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>" \
  > "<panel-run-dir>/verdicts/verdict-1.json"
```

Perform each validation in the same Bash call that defines the shown shell variables; repeat with `verdict-2.json` and `verdict-3.json` for criteria 2 and 3 — **`verdict-N.json` must hold criterion N**, and the helper enforces that when aggregating, so a swapped slot is a hard error rather than a silent mis-ranking. The helper requires valid JSON, a criterion drawn from the derived set, exact criterion identity, every manifest candidate exactly once, no foreign/duplicate candidates, integer scores 0–10 in non-increasing order, `fatal_flaw: string | null`, and non-empty `strongest_idea`; it strips curly braces from validated prose and emits canonical JSON. Re-spawn only an invalid judge with diagnostics, once; if still invalid, stop. Then combine those exact paths in criterion order with `jq -s`, not a directory glob.

### Step 4.5 — Aggregate (deterministic, no agent)

Compute the ranking in code, not in the finalizer's head:

```bash
bun "{LOOM_DIR}/engine/src/cli.ts" helper panel-contract aggregate \
  --runs-root ".claude/specs/{date_slug}/panel-runs" \
  --manifest "<panel-run-dir>/manifest.json" \
  --designers "<N>" \
  > "<panel-run-dir>/ranking.json"
```

`aggregate` re-reads and re-validates **every** verdict file from the run directory (it does not trust Step 4's output), matches each verdict to its criterion **by name**, verifies the criteria set is exactly the derived K with no duplicates or omissions, and emits the ranking sorted by total score → each criterion in order → lexical filename. Any failure is fatal: stop and report. Require `ranking.json` to be non-empty before continuing.

### Step 5 — Finalize (interactive → writes plan.md)

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-arch-finalize.md`. Substitute `{feature_description}`, `{spec_file_path}`, `{interview_file_path}`, `{candidate_manifest_path}`, `{judge_verdicts}` (the canonical three-verdict JSON array, inlined), `{panel_ranking}` (the contents of `ranking.json`, inlined), `{date_slug}`, and `{loom_dir}`.

**Spawn `architecture-agent`** with this template. It reads the already-computed ranking (it does not rank candidates itself); presents the top 2–3 with summary/trade-offs/testability/codebase-fit/effort; synthesizes the user's choice; writes `.claude/plans/{date_slug}.md` with `### AD-1: Approach selection (panel)`; and commits.

**From here, the flow rejoins standard mode.** Its SubagentStop advances to plan-alignment, or directly to decompose when plan-alignment was skipped.

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

  **Panel-mode loop-back:** even if the plan was produced in `--panel` mode, a gap-report re-run uses the **standard single-agent architecture flow** (`phase-architecture.md`) — never re-panel. Retain the exact panel-run manifest path recorded in AD-1 and mention that manifest in the re-spawn prompt; require the agent to read only its `candidates[].path` entries if it revisits losing designs. Never scan a shared or run directory.
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
2. Spawn ALL wave tasks in parallel (single message, multiple Agent calls)
3. Wait for all to reach "implemented"
4. If any wave task never reached `implemented` (agent crashed): re-spawn it (still `pending`, `executing_tasks` was cleared)
5. **RUN `/wave-gate` — MANDATORY, via subagents** (see below)
6. If blocked (critical findings): spawn fix agents with the findings, re-run `/wave-gate`
7. **Triage advisory findings and fix the RELEVANT ones** before advancing (see [Addressing Advisories](#addressing-advisories)). Advisories bypass refutation but pause the lifecycle at `awaiting-advisory-decision`; record an accept/defer disposition before completion.
8. **Run the full-tier lint** (`/wave-gate` Step 4c) — the PostToolUse `lint-file.sh` hook runs the *immediate* tier (regex rules) only, so the Wave Gate is the automatic place where programmatic rules (boundaries, purity, function length, generated-file integrity) run. Violations block; never silence one by editing the rule that caught it.
9. Once the gate passes AND relevant advisories are addressed AND the full-tier lint is clean: advance to next wave

### Wave-Gate Enforcement (NON-NEGOTIABLE)

**You MUST invoke `/wave-gate` by spawning review subagents.** You are NEVER allowed to:
- Review code yourself inline and declare it "passed"
- Skip the wave-gate and proceed to the next wave
- Manually set `reviews_complete: true` in state

**The wave-gate spawns these agents (see `commands/wave-gate.md` for full protocol — it is authoritative, this list is a summary):**
1. `spec-check-invoker` — verifies implementation satisfies spec anchors (1 per wave)
2. Per task: `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`
3. `review-verifier-agent` — the **refutation panel** (wave-gate Step 3.5), N verifiers per wave, one per lens. MANDATORY whenever the wave has critical findings: an unadjudicated plausible-but-wrong critical costs a full remediation cycle. Driven by the `review-panel` helper (`brief` → `manifest` → `lenses` → `verdict` → `tally`); a majority refutation moves a finding into `refuted_findings` with its reasoning, never deletes it. **Skip only when the wave has zero criticals.**

**Steps 1 and 2 are spawned in parallel via the subagent-spawn tool (`Agent`, named `Task` in older harnesses).** Step 3 runs AFTER them — it adjudicates the findings they produced, so it cannot share their message. SubagentStop hooks automatically update state. Then `complete-wave-gate` helper advances the wave.

**The `validate-task-execution` hook enforces this:** it blocks next-wave impl agents if `wave_gates[N-1].reviews_complete == false`. Even if you try to skip, the hook will BLOCK.

**Re-spawn logic:** After spawning, check for pending wave tasks whose agent did not complete (a crashed agent leaves the task `pending` with `executing_tasks` cleared). Resolve the current wave inside the jq program — the guard blocks `WAVE=$(jq … state)` capture-into-variable, and shell vars don't persist across Bash tool calls:
```bash
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w and .status == "pending") | .id' .claude/state/active_task_graph.json
```
Re-spawn each pending wave task whose agent did not reach `implemented`.

**Load template:** Read `{LOOM_DIR}/commands/templates/impl-agent-context.md`

Substitute variables:
- `{task_id}`, `{wave}`, `{agent_type}`, `{dependencies}`
- `{required_skill}` - Read the selected source agent's `skills:` frontmatter and substitute its exact declared skill name (for agents with no declared skill, use `none`). This is both the Claude spawn-gate evidence and the Pi preloaded-skill audit label; never infer it from the agent name.
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

Run the façade and relay what it prints — do not hand-assemble a summary from
`jq`, and do not re-derive readiness:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration status
```

Every fact category appears, present or `unavailable`, followed by exactly one
typed next action and its complete reason list:

```
Loom Status v1
- location: {"activePhase":"execute","activeWave":2}
- tasks: {"counts":{"pending":1,"running":0,"implemented":2,"blocked":0,"completed":0}}
- failedProofObligations: []
- testReadiness: {"kind":"ready"}
- reviewRuns: {"rosterGaps":[],"evidenceFailures":[]}
- findingCounts: {"active":0,"advisory":3,"resolved":0,"refuted":0}
- refutationPanelNeed: {"kind":"no-need"}
- waveGateCompletionEligibility: {"kind":"ineligible","failed":["T3 has no test evidence"]}
- nextAction: spawn-batch
- reasons:
  - [wave-incomplete] T3 has not reached implemented
```

An `unavailable` category is a real answer, not a rendering gap: it means the
authority behind that fact could not be parsed, and the action will be
`blocked` with the reason attached.

### Completion or abort teardown

`/loom --complete` and `/loom --abort` are not implemented argument handlers.
After verifying completion—or after explicit user confirmation to abandon the
run—use the guarded cleanup operation rather than direct file removal:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper cleanup-state
```

Optionally close or retain the GitHub Issue. Preserve specs, plans, and review
Run Directories as audit/recovery evidence. Hooks deactivate when the protected
TaskGraph is removed.

---

## Hook Integration

Hooks auto-activate when `active_task_graph.json` exists:

| Hook | Event | Purpose |
|------|-------|---------|
| `block-direct-edits.sh` | PreToolUse: Edit/Write/MultiEdit | Forces the subagent-spawn tool |
| `enforce-phase-tools.sh` | PreToolUse: Edit/Write/MultiEdit | Guarded-skill-machine gate: denies enforced tools the bound agent's phase doesn't allow (fails closed) |
| `guard-state-file.sh` | PreToolUse: Bash | Deny-by-default on guarded state paths: only read-only commands (`jq`, `cat`, `grep`, …) and whitelisted helpers pass — covers task graph + subagent evidence/binding files + machine definitions |
| `validate-task-execution.sh` | PreToolUse: Agent/Task/subagent | Validates wave order |
| `validate-phase-order.sh` | PreToolUse: Agent/Task/subagent | Enforces phase sequencing |
| `validate-template-substitution.sh` | PreToolUse: Agent/Task/subagent | Blocks unsubstituted `{variable}` patterns |
| `validate-agent-model.sh` | PreToolUse: Agent/Task/subagent | Validates agent model assignment |
| `validate-agent-skill.sh` | PreToolUse: Agent/Task/subagent | Validates agent skill preload |
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

- **Whitelisted in the guard** (`engine/src/config.ts` `WHITELISTED_HELPERS`, so the guard permits them even on a guarded path): `populate-task-graph` (Phase 4d), `set-phase` loop-back, `mark-tests-passed` (read-only evidence status check, run during `/wave-gate` Step 2 — it reads the ledger and does NOT modify state), `repair-task-graph` (recovery only; it reads rejected JSON directly, applies `fixFull`, validates, and atomically replaces the graph without calling `StateManager.load()`), `review-packet create` (starts the packet-bound Review Run atomically while writing its immutable packet outside guarded state), and the `store-review-findings` / `store-spec-check` false-positive overrides.
- **Merely out of the guard's scope when invoked as documented** (NOT in `WHITELISTED_HELPERS`): `validate-task-graph` / `validate-lint-rules`; `lint-wave-gate` (`commands/wave-gate.md` Step 4c — it READS the graph to collect targets and writes nothing); `orchestration status` (a pure read that derives the canonical status value and renders it); the two panel contract helpers `panel-contract` (this document, Phase 3 panel mode) and `review-panel` (`commands/wave-gate.md` Step 3.5); and `standalone-review` (`skills/review-and-fix/SKILL.md`) — they pass only because their documented invocations name no guarded path, writing instead into a run directory under the runs-root each one is given — `.claude/specs/{date_slug}/panel-runs/` for the architecture panel, `.claude/reviews/panel-runs/` for the wave refutation panel, and `.claude/reviews/review-and-fix-runs/` for standalone review. Invoked against a guarded path they would be blocked like anything else.

  **One exception inside that class:** `review-panel tally` DOES write the task graph through `StateManager` — it moves refuted findings into `refuted_findings` and can demote `review_status` from `blocked` to `passed`. It is out of the guard's scope only because its arguments name the run directory rather than the state file. It is nonetheless the wave gate's own adjudication step, run exactly once per run directory at the point `wave-gate.md` says to, and it refuses a second tally on a run it has already adjudicated. Do not invoke it to "re-check" a wave.

Each sanctioned direct invocation still requires user approval. Everything else is hook-driven.

When the load boundary reports a corrupt graph and names `repair-task-graph`, run:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper repair-task-graph
```

Set `LOOM_STATE_PATH` only when repairing a non-default graph. The helper fails closed if repair would drop findings or audit data, validates the repaired graph at both the full-graph and typed load boundaries, and leaves the state file `0444` after its atomic replacement. Do not redirect `validate-task-graph --fix` into the guarded state file; that pure transformer cannot install its own output through the guard.

---

## Operations Reference

### Status Transitions

```
pending → implemented    (agent completes; SubagentStop hook resolves test evidence)
pending → pending        (agent crash: no task ID resolvable; executing_tasks cleared, task re-spawned)
implemented → completed  (wave gate passed: tests + review + no critical findings)
```

### Observability

**Prefer the engine's own status.** It derives one canonical value and renders
it two ways, so the human and machine forms cannot drift from each other or
from the program that actually decides readiness:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration status          # human
bun ${LOOM_DIR}/engine/src/cli.ts helper orchestration status --json   # machine
```

It reports active Phase and Wave, an exhaustive five-way Task partition,
failed proof obligations, test readiness, Review Run roster gaps and evidence
failures, the four Finding counts, Refutation Panel need, Wave Gate completion
eligibility, exactly one typed next action, and every contributing reason.

The `jq` recipes below read raw fields directly. They remain useful for
inspecting a specific stored value, but they do NOT reproduce the engine's
readiness logic — a task that looks `implemented` here may still be ineligible
for advancement, and a missing field reads as absent rather than as the
authority failure it is. Never derive a gate decision from them:

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
1. **Re-spawn a subagent** — create fix agent with findings context (subagent CAN Edit/Write)
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

**Fix relevant advisories** the same way as criticals — spawn a fix subagent (Edit/Write are blocked for the orchestrator), give it the advisory text + file context, and have it make the minimal change. Re-run `/wave-gate` so the fix is re-reviewed.

**Best-effort, non-blocking:** if a relevant advisory can't be fixed cleanly (breaks tests, needs an upstream change), defer it with a reason rather than blocking the wave. Never silently drop an advisory — every advisory ends as *fixed*, *deferred (reason)*, or *dismissed (reason)*.

---

## Constraints

- **ALL phases via agents** - brainstorm, specify, clarify, architecture, plan-alignment, decompose agents
- **ALL implementation via the subagent-spawn tool** - Edit/Write/MultiEdit blocked
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
