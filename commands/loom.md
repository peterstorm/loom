---
name: loom
version: "3.2.0"
description: "This skill should be used when the user asks to 'plan this', 'orchestrate', 'break down', 'split into phases', 'coordinate tasks', 'create a plan', 'multi-step feature', or has complex tasks needing structured decomposition. Decomposes work into wave-based parallel tasks, assigns specialized agents, creates GitHub Issue for tracking, and manages execution through automated hooks."
argument-hint: "[$description] [--skip-brainstorm] [--skip-clarify] [--skip-specify] [--skip-plan-alignment] [--skip-plan-design-review] [--panel[=N]] [--status]"
---

# Loom - Full Orchestration

Runs one feature from idea to reviewed code: brainstorm → specify → clarify → architecture → plan alignment → plan design review → decompose → execute. You are the orchestrator. Each phase's work is done by an agent you spawn; the engine's hooks enforce the order and record the results.

This file holds what every run needs. Four procedures that only some runs reach are in runbooks under `references/loom/`. Each is introduced below by a **Mandatory read** stanza that says when to read it. Read a runbook in full before acting on any part of it. If you cannot read it, stop and tell the user; do not improvise its procedure.

**Arguments:** "$ARGUMENTS"

## Setup

Run every command of this skill from the repository root.

**1. Check for bun.** The hooks need it. If it is missing, stop and tell the user.

```bash
command -v bun || { echo "FATAL: bun not found. Run: nix develop ./.claude" >&2; exit 1; }
```

**2. Resolve the package path.** Claude Code expands the token below in this file; Loom's Pi adapter renders it from the extension module's `import.meta.url`. Never infer the package from cwd, and never scan another harness's install cache.

```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR"; exit 1; }
printf 'LOOM_DIR=%s\n' "$LOOM_DIR"
```

**Path notation.** From here on, `{LOOM_DIR}` stands for the printed path. Write that path out literally in every command and file read. Shell variables do not survive from one Bash call to the next, so a later `$LOOM_DIR` would expand to nothing. The same holds for `{date_slug}` and every other `{name}` in this file and its runbooks: replace it with its value before running the line.

- Engine CLI: `bun {LOOM_DIR}/engine/src/cli.ts`
- Templates: `{LOOM_DIR}/commands/templates/<name>.md`
- References and runbooks: `{LOOM_DIR}/references/<name>.md`, `{LOOM_DIR}/references/loom/<name>.md`

**3. For `--status`, stop here:** run `bun {LOOM_DIR}/engine/src/cli.ts helper orchestration status` and relay what it prints. Do not assemble a summary from raw state.

**4. Choose the slug.** `{date_slug}` is `YYYY-MM-DD-feature-name`, the same in every phase.

**5. Create the State File,** passing through the skip flags the user gave. This turns on hook enforcement for the whole run. With `--skip-specify` it requires `.claude/specs/{date_slug}/spec.md` to exist already.

```bash
mkdir -p .claude/state .claude/specs/{date_slug}
bun {LOOM_DIR}/engine/src/cli.ts init-state \
  [--skip-brainstorm] [--skip-clarify] [--skip-specify] [--skip-plan-alignment] \
  [--skip-plan-design-review] \
  --spec-dir .claude/specs/{date_slug} \
  --output .claude/state/active_task_graph.json
```

The engine keeps the State File read-only. Never `chmod` it, edit it or write to it; only hooks and the helpers named in this file and its runbooks change it.

## Arguments

- `/loom "description"`: start a new plan and run every phase.
- `--skip-brainstorm`: skip Phase 0 (the scope is already clear).
- `--skip-clarify`: skip Phase 2 and go to architecture whatever the marker count.
- `--skip-specify`: skip Phases 0–2 and use the existing spec.
- `--skip-plan-alignment`: skip Phase 3.5.
- `--skip-plan-design-review`: skip the Phase 3.6 gate. Recorded as `plan_design_review: {"status":"not-required","reason":"skipped"}`.
- `--panel` or `--panel=N`: produce the plan through an architecture panel (parallel designers, each with a lens, ranked by judges). Only Phase 3 changes; see its Mandatory read.
- `--status`: show the current status (Setup step 3).

There is no `--complete` and no `--abort` flag; both are helper invocations in the recovery runbook. A phase is skipped only by its flag. Clarify also drops out by itself when the spec has 3 markers or fewer (`CLARIFY_THRESHOLD` in `engine/src/core/phase-policy.ts`).

## Spawn rules

- **Model.** Every Loom agent has one LLM Profile. Before each spawn, resolve it and pass the model explicitly; never omit it. A missing or mismatched binding blocks the spawn.
  ```bash
  bun {LOOM_DIR}/engine/src/cli.ts helper model-profiles agent --agent "<AGENT_NAME>"
  ```
  Claude Code: pass the emitted `claudeCode.model` in the `Agent`/`Task` call. Pi: the agent definition must contain the emitted `pi.provider/pi.model:pi.thinking` pattern; run `{LOOM_DIR}/scripts/sync-pi-agents.sh` after an install or update.
- **Pi transport.** Under Pi, spawn `specify-agent`, `clarify-agent`, `architecture-agent` and `arch-interviewer-agent` with the `loom_interactive_subagent` tool, one agent per call; it relays their `AskUserQuestion` dialogs to the parent TUI. The plain `subagent` tool refuses those four roles. Use `subagent` for every other agent. Under Claude Code, use the native Agent/Task tool for all of them.
- **Templates.** Read the phase's template, replace every variable the Phases table lists for it, and spawn the agent with the result as its prompt. A prompt that still contains a `{name}` variable is refused.
- **Do not answer for the user.** Pass an interactive agent only the paths and values its template asks for. Never put pre-resolved answers into its prompt.
- **One phase agent at a time.** Phases run in sequence. Only Phase 5 Tasks and panel batches are spawned in parallel, in one message.

## Phases

| Phase | Agent | Template | Variables | Output | When it completes |
|---|---|---|---|---|---|
| 0 Brainstorm | `brainstorm-agent` | `phase-brainstorm.md` | `{feature_description}`, `{prior_context}`, `{date_slug}` | `.claude/specs/{date_slug}/brainstorm.md` | Phase advances to specify. User checkpoint |
| 1 Specify | `specify-agent` | `phase-specify.md` | `{feature_description}`, `{date_slug}` | `.claude/specs/{date_slug}/spec.md` | More than 3 markers → clarify; otherwise architecture |
| 2 Clarify | `clarify-agent` | `phase-clarify.md` | `{spec_file_path}`, `{marker_count}`, `{date_slug}` | The same spec, with no marker left | Advances to architecture only at 0 markers |
| 3 Architecture | `architecture-agent` | `phase-architecture.md` | `{feature_description}`, `{spec_file_path}`, `{date_slug}`, `{loom_dir}` | `.claude/plans/{date_slug}.md` | Advances to plan alignment (or decompose when skipped) |
| 3.5 Plan alignment | `plan-alignment-agent` | `phase-plan-alignment.md` | `{spec_file_path}`, `{plan_file_path}`, `{spec_dir}`, `{date_slug}` | `{spec_dir}/plan-alignment.md` | Advances to decompose. User checkpoint on gaps |
| 3.6 Plan design review | reviewers, via the runbook | none | none | `plan_design_review: accepted` | Opens the decompose spawn |
| 4 Decompose | `decompose-agent` | `phase-decompose.md` | `{feature_description}`, `{spec_file_path}`, `{plan_file_path}` | One line of JSON: the task graph | Stays `decompose` until Tasks are populated |
| 5 Execute | implementation agents | engine-rendered briefs | none | Reviewed code, Wave by Wave | See Phase 5 |

Variable values:

| Variable | Value |
|---|---|
| `{feature_description}` | The user's request; from Phase 1 on, as refined by the brainstorm |
| `{prior_context}` | Notes from earlier exploration or the user's feedback on a previous brainstorm; `None.` when there are none |
| `{date_slug}` | The slug from Setup |
| `{spec_file_path}` | `.claude/specs/{date_slug}/spec.md` |
| `{marker_count}` | The count of `NEEDS CLARIFICATION` in that spec |
| `{loom_dir}` | The resolved `LOOM_DIR` path |
| `{plan_file_path}` | `.claude/plans/{date_slug}.md` |
| `{spec_dir}` | `.claude/specs/{date_slug}` |

The hooks refuse a spawn whose prerequisite phase is not complete and advance `current_phase` when a phase agent's artifact is on disk. You do not set the phase yourself, except for the loop-backs below.

## Your duties between phases

**After Phase 0.** Read `brainstorm.md`, present its summary, and ask: "Approach: {selected approach}. Proceed to specification?" Under Pi this checkpoint is also where the user confirms the approach, because the brainstorm agent cannot ask. If the user wants changes, re-spawn `brainstorm-agent` with the feedback as `{prior_context}`.

**After Phase 1.** Note the spec path and count the markers in that one spec:

```bash
grep -c "NEEDS CLARIFICATION" .claude/specs/{date_slug}/spec.md || [ $? -eq 1 ]
```

More than 3 means Phase 2 runs next (unless `--skip-clarify`); otherwise go to Phase 3.

**After Phase 2.** Count again. The phase advances only when the count is 0. If markers remain, re-spawn `clarify-agent` on them; it resolves each with the user or rewrites it as a deferral.

**After Phase 3.** Note the plan path, the implementation phases, and any executable models the agent declared (LC-N lifecycles, the Pipeline AuthoredDag, INV-N invariants with rule files, CT-N contracts with types and acceptance files). Phase 4a validates them against the task graph.

**After Phase 3.5.** Read `.claude/specs/{date_slug}/plan-alignment.md`. The report is always written, and decompose is refused without it.

- No gaps: go to Phase 3.6.
- Gaps: present the report and ask: "N gaps found. Re-run architecture with this feedback, or proceed to decompose?"
- A `FEAS-N` gap means a recorded discovery contradicts a Requirement or a plan decision. When the Requirement itself is what the discovery makes wrong, re-running architecture cannot fix it: say so, and offer amending the spec (back to `/specify`) as a third option.
- **Re-run:** set the phase back, delete the stale report, and re-spawn `architecture-agent` with the gap report appended to its prompt. Plan alignment then runs again.
  ```bash
  bun {LOOM_DIR}/engine/src/cli.ts helper set-phase --phase architecture --clear-artifact plan-alignment
  rm -f .claude/specs/{date_slug}/plan-alignment.md
  ```
  Never re-panel on a loop-back. Even when the plan came from `--panel`, the re-run uses the standard `phase-architecture.md` flow. Give the agent the exact panel-run manifest path recorded in AD-1 and tell it to read only that manifest's `candidates[].path` entries if it revisits losing designs; never scan a shared or run directory.
- **Proceed:** go to Phase 3.6.
- From the second re-run on, warn: "This is loop-back attempt N. Consider proceeding to decompose or refining the spec directly."

## Phase 3 with `--panel`

**Mandatory read: `{LOOM_DIR}/references/loom/panel-runbook.md`.** Read it when `--panel` or `--panel=N` was passed, before you validate the flag's value or spawn anything for Phase 3. It replaces the single `architecture-agent` spawn and ends with the same plan file; everything after Phase 3 is unchanged.

## Phase 3.6: Plan design review

**Mandatory read: `{LOOM_DIR}/references/loom/plan-design-review-runbook.md`.** Read it once plan alignment has settled, before Phase 4, unless `--skip-plan-design-review` was passed. The plan is reviewed as a standalone review of kind `plan-design`, and `helper accept-plan-design-review` records the acceptance. The decompose spawn is refused until then, and again after any later edit to the plan.

## Phase 4: Decompose

**Mandatory read: `{LOOM_DIR}/references/loom/decompose-runbook.md`.** Read it when you reach Phase 4, before spawning `decompose-agent`. It covers the spawn, validation of the output and where each kind of failure goes (4a), Requirement trace ownership (4b), the user's approval (4c), the verification manifest, the GitHub Issue and `populate-task-graph` (4d), and the `/clear` checkpoint (4e).

## Phase 5: Execute

For each Wave, loop on canonical status. Never work out what to spawn from `pending`, `retry_count`, `failure_reason` or any other raw field.

1. Read `helper orchestration status --json` and act on its `next.action.diagnostic.recovery`:
   - `spawn-wave-implementation`: spawn exactly `recovery.dispatches`, in parallel, each through its brief ([below](#implementation-briefs)). A Task may reappear there after its reservation expired; that is intended. A `retry-implementation` dispatch is the one engine-authorized attempt 2, and its brief carries the retry appendix. An infrastructure-blocked attempt is re-dispatched under the same kind and does not use up an attempt.
     - **The Distill Task.** A Wave with implementation files has one Task the engine added at population (agent `distill-agent`). Status offers its dispatch only after every other Task of the Wave has settled. Dispatch it like any other, through its brief. It may settle having changed nothing.
   - `await-wave-implementation`: spawn nothing. Wait for the listed active Tasks to settle, then re-read status.
   - `escalate-wave-implementation`: stop, and present every Task, receipt and failure kind to the user. Attempt 2 is final; the spawn gate refuses an attempt 3.
   - `start-wave-gate`: go to step 3.
   - `start-successor-wave-gate`: go to step 3, and start `/wave-gate` with exactly `recovery.runId` as the run id, never a fresh one.
   - `repair-wave-start-readiness` (diagnostic `wave-start-not-ready`): implementation has stopped but a start prerequisite is unmet. Stop and resolve each entry of `recovery.failures` (for example, re-attest a reopened Task). Do not start the Wave Gate; it refuses the same prerequisites.
   - `skeleton-bindings-unresolved` (blocked, in place of `spawn-wave-implementation`): a Task's export bindings do not resolve against its contract's frozen types file. Every problem is named. Spawn nothing. Resolve it through the plan and a Contract Revision (`docs/verification.md`), then re-read status.
   - `skeletons-unobserved` (a reason beside an owed `spawn-wave-implementation`, never a block): status could not read a skeleton path or types file. Spawn as listed; registration reads them again.
   - **Skeleton outcomes** in status and in each brief (`skeleton written`, `no bound exports, no skeleton`, `contract has no types file, no skeletons`, `unsupported language, no skeleton`, `exists, not skeletonized`, `absent, no skeleton owed`, and `stale against revised contract`) are information, never a dispatch. The engine writes skeletons itself. Never write or delete one by hand.
2. When the batch settles, re-read status and repeat step 1. Leave the loop only on `start-wave-gate` or `start-successor-wave-gate`; `escalate-wave-implementation` ends execution.
3. When status says `start-wave-gate`, run `/wave-gate`. Do not review inline or skip it: the spawn gate refuses next-Wave Tasks until the gate completes. `commands/wave-gate.md` is the protocol. The gate runs the completion suite from the protected Verification Manifest itself; never run a substitute command, and never silence a failure by editing the authority that caught it.
4. If the gate is blocked by critical findings, fix them through [Acting on a Finding](wave-gate.md#acting-on-a-finding) (abandon, `reopen-task`, `brief --note`, fresh `/wave-gate`).
5. Advisory findings pause the gate at `awaiting-advisory-decision`. Classify and act on every one as `commands/wave-gate.md` says (the paragraphs before [Acting on a Finding](wave-gate.md#acting-on-a-finding), including the contract-Wave `acceptance-freeze-pending` check), and approve only then.
6. When the gate reports the Wave complete, return to step 1 for the next Wave. After the final Wave Gate reports `done`, complete the orchestration (recovery runbook).

### Implementation briefs

The engine renders every implementation prompt; never assemble one by hand. Run:

```bash
bun {LOOM_DIR}/engine/src/cli.ts helper orchestration brief
```

It prints one entry for each dispatch status owes, and refuses, naming the cause, any brief the spawn gates would refuse. Each entry carries the exact invocation:

- **Pi:** spawn `pi.agent` with `pi.task` (the one-line marker `LOOM_IMPLEMENTATION_BRIEF: <Task>`) and `agentScope: "user"`; batch several Tasks as `tasks`.
- **Claude Code:** spawn `claude.subagent_type` (always `loom:<agent>`; the spawn gate refuses the bare name) with `claude.model`, `claude.description` and `claude.prompt`, the same one-line marker.

Pass the marker exactly and do not paste the brief: Loom expands the marker into the rendered brief before the agent sees it, and a marker that cannot expand blocks the spawn, naming the cause. `brief --prompt` prints the rendered brief for reading only.

**Operator notes.** `brief --task <Task> --note "<text>"` (repeatable; at most 8, 500 characters each) prints an invocation whose marker carries the notes. Spawn exactly that. A note focuses work inside the Task; it cannot widen the file list, waive verification or override the rules. The marker must be the first line, and only `LOOM_OPERATOR_NOTE:` lines may follow it. A note may not contain a `LOOM_` token, a `{template variable}` or a `Task ID:` binding.

<!-- wire-example: implementation-brief-request -->
```text
LOOM_IMPLEMENTATION_BRIEF: T5
LOOM_OPERATOR_NOTE: Keep the exported signature of parseOrder unchanged.
LOOM_OPERATOR_NOTE: Cover the empty-cart case in the existing test file.
```

## Invariants

- Phase work is done by phase agents and implementation by Tasks spawned from engine briefs. While the State File exists, your own Edit and Write are blocked.
- `helper orchestration status` decides what happens next. Raw state fields never do.
- Every Wave passes through `/wave-gate` before the next Wave starts. You never review inline, and you never mark a review complete yourself.
- State changes only through hooks and the helpers this file and its runbooks name.
- One active plan at a time.

## Recovery, completion and abort

**Mandatory read: `{LOOM_DIR}/references/loom/recovery-runbook.md`.** Read it before you act on a `blocked` status the Phase 5 list does not cover, override a finding you believe is a false positive, run a helper this file did not name, repair a State File the engine reports as corrupt, or complete or abandon the orchestration.
