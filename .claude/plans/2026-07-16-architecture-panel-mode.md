# Architecture Panel Mode (`/loom --panel`)

**Date:** 2026-07-16
**Status:** Planned, not started
**Scope:** loom repo only — no engine state-machine changes, no fugue changes

## Summary

Upgrade the architecture phase's approach gate from "one agent invents 2–3
approaches from a single perspective" to "N independent designer agents, each
with an assigned lens, generate candidates in parallel; adversarial judges
score them against criteria derived from the user's own interview answers; the
finalizer synthesizes and presents the top candidates at the existing approach
gate."

Opt-in via `/loom --panel`. Standard mode is untouched. Downstream phases
(plan-alignment, decompose, task graph, wave gates) see exactly one `plan.md`
— the artifact contract does not change.

## Design constraints (verified against the engine)

Two properties of the existing enforcement machinery shape the whole design:

1. **`validate-phase-order` blocks unrecognized agents.** Any new agent
   spawned mid-loom hits `detectPhase()` in
   `engine/src/core/validate-phase-order.ts` and is blocked as "unknown"
   unless registered in config. The panel agents must therefore be added to a
   recognized set — but NOT to `PHASE_AGENT_MAP`, because…

2. **`advance-phase` keys off `PHASE_AGENT_MAP` at SubagentStop.** If a
   designer agent mapped to `"architecture"`, its completion would trigger
   `resolveTransition("architecture", …)` in
   `engine/src/handlers/subagent-stop/advance-phase.ts` — and the date-prefix
   fallback there (matching `.claude/plans/{datePrefix}*.md`) could find a
   stale same-day plan and advance the phase prematurely, mid-panel.

Resolution: panel agents live in a new `ARCH_PANEL_AGENTS` set that
`detectPhase` recognizes as architecture-phase work and `advance-phase`
ignores entirely. Only the final plan-writing agent keeps the name
`architecture-agent`, so phase advancement fires exactly once, exactly as
today.

## Hook-gate audit

`hooks.json` runs FIVE PreToolUse gates on every Task spawn, not just
validate-phase-order. Audited against the panel agents:

| Gate | Effect on panel | Action required |
|---|---|---|
| `validate-phase-order` | blocks unknown agents | register `ARCH_PANEL_AGENTS` (change #2) |
| `validate-agent-skill` | blocks a spawn whose prompt omits a frontmatter-declared skill; architecture-agent declares `skills: [architecture-tech-lead]` | **finalize template MUST reference `architecture-tech-lead` in the prompt** (today's phase-architecture.md does, in its closing line — the finalize template needs the same) |
| `validate-template-substitution` | blocks any prompt containing `{var}` patterns (only `{type}`/`{id}`/`{name}` exempt) | authoring rule for all new templates: after substitution, NO literal `{...}` placeholders may remain in prose — write `candidate-<lens>.md` (angle brackets), never `candidate-{lens}.md`, when referring to the naming scheme inside instructions |
| `validate-agent-model` | only validates agents in `PHASE_AGENT_MAP ∪ IMPL_AGENTS ∪ REVIEW_AGENTS`; panel agents are outside → skipped | none — deliberate; do NOT add panel agents to `VALIDATED_AGENTS` (loom's shipped agents carry no `model:` frontmatter, so adding them would block spawns) |
| `validate-task-execution` | only fires when the prompt contains a task ID | none — panel prompts carry no task IDs |

Write/Edit/Bash gates for completeness: `block-direct-edits` allows subagent
writes (designers/interviewer write freely); `enforce-phase-tools` only gates
agents with machine definitions in `machines/` (only code-implementer-agent
has one — panel agents bind no machine, gate passes through);
`guard-state-file` guards `.claude/state/` + subagent/machine dirs —
`.claude/specs/{slug}/candidates/` is not guarded. `mark-subagent-active`
(SubagentStart) binds machines by agent type — no machine files for panel
agents, no binding. No changes needed to any of these.

## The flow

```
Phase 3 (panel mode)                       current_phase stays "architecture" throughout
──────────────────────────────────────────────────────────────────────────────
1. arch-interviewer-agent   interactive   explore + full 13-topic questionnaire
                                          → .claude/specs/{slug}/interview.md
2. N× arch-designer-agent   parallel,     spec + interview digest + assigned lens
                            headless      → .claude/specs/{slug}/candidates/candidate-{lens}.md
3. K× arch-judge-agent      parallel,     ALL candidates + one criterion (adversarial)
                            headless      → returns JSON verdict to orchestrator
4. architecture-agent       interactive   candidates + verdicts → approach gate
   (finalize mode)                        (AskUserQuestion, previews) → writes plan.md
                                          → SubagentStop advances to plan-alignment ✓
```

Defaults: N = 3 designers, K = 3 judges.

**Judging rubric falls out of the interview.** The interview already extracts
the user's priorities; those answers become the criteria:

- Judge 1: the user's stated **NFR primary optimization axis**
- Judge 2: the user's stated **testability bar**
- Judge 3: **codebase fit + effort**

Each judge is framed adversarially ("find the reason each candidate fails this
criterion"), ranks all candidates comparatively, and returns pure JSON.

**Synthesis.** The finalizer takes the top-ranked candidate as the base and
grafts each judge's `strongest_idea` from losing candidates where compatible.
The user still picks at the approach gate — the panel's ranking is presented
as the recommendation, never silently applied.

## Artifacts

```
.claude/specs/{slug}/
  interview.md                 # structured digest, regex-friendly labeled fields
  candidates/
    candidate-{lens}.md        # one per designer, fixed format
.claude/plans/{slug}.md        # unchanged contract; gains AD-N block for panel outcome
```

Judge verdicts are NOT persisted as files — they return as JSON to the
orchestrator and are inlined into the finalizer prompt. The durable audit
trail lives in `plan.md` as a mandatory `### AD-N: Approach selection (panel)`
block (lenses run, verdict summary, what was grafted). Candidates stay on disk
because they are large and useful context for plan-alignment loop-backs.

## Changes by file

### 1. `engine/src/config.ts` — register panel agents

```ts
/** Architecture-panel agents (--panel): recognized by phase validation as
 *  architecture-phase work, invisible to advance-phase (not in PHASE_AGENT_MAP
 *  — only architecture-agent's stop advances the phase). */
export const ARCH_PANEL_AGENTS = new Set([
  "arch-interviewer-agent",
  "arch-designer-agent",
  "arch-judge-agent",
]);

export const PANEL_DESIGNERS_DEFAULT = 3;
```

Do NOT add them to `KNOWN_AGENTS` — that set is for task-graph validation and
panel agents never appear in task graphs.

### 2. `engine/src/core/validate-phase-order.ts` — recognize them

In `detectPhase()`, before the prompt-sniffing fallbacks:

```ts
if (ARCH_PANEL_AGENTS.has(agent) || ARCH_PANEL_AGENTS.has(agent + "-agent")) return "architecture";
```

That is the entire engine-behavior change. Existing machinery then does the
right thing for free: `architecture → architecture` is already a valid
transition in `VALID_TRANSITIONS`, and the existing artifact check for the
architecture phase (spec.md exists, markers ≤ threshold) gates panel agents
identically to architecture-agent itself. Panel agents are correctly blocked
during `init`/`execute`/`decompose`.

### 3. New agent definitions in `agents/`

- **`arch-interviewer-agent.md`** — interactive. Runs steps 1–3 of today's
  `phase-architecture.md` (read spec, explore codebase, full 13-topic
  questionnaire via AskUserQuestion). Writes a structured digest to
  `.claude/specs/{slug}/interview.md` with labeled fields
  (`**Primary axis:**`, `**Testability bar:**`, `**Codebase constraints:**`,
  …) so the orchestrator can derive lenses and judge criteria without parsing
  prose. Does NOT design, does not write plans.

- **`arch-designer-agent.md`** — headless. Declares
  `skills: [architecture-tech-lead]` (same design-knowledge preload as
  architecture-agent — designers are doing design work; spawn prompts must
  mention the skill for consistency, though the skill gate doesn't validate
  panel agents). Receives spec + interview digest +
  one lens. Produces one candidate at
  `.claude/specs/{slug}/candidates/candidate-{lens}.md` in a fixed format:
  approach summary, component boundaries, data flow, file-structure sketch,
  trade-offs, effort, testability impact. The format deliberately mirrors the
  existing approach-gate preview format so the finalizer can lift previews
  straight from candidates. Explicitly forbidden: AskUserQuestion, plan.md,
  executable-model artifacts (AuthoredDag / lint rules — those are finalizer
  work, after the user picks).

- **`arch-judge-agent.md`** — headless. Receives all candidate paths + one
  criterion + relevant interview answers. Adversarial framing. Returns pure
  JSON (same discipline as decompose-agent):

  ```json
  {
    "criterion": "...",
    "rankings": [
      { "candidate": "candidate-{lens}.md", "score": 0,
        "fatal_flaw": null, "strongest_idea": "..." }
    ]
  }
  ```

  `strongest_idea` feeds synthesis — the finalizer grafts standout ideas from
  losers into the winner.

### 4. New templates in `commands/templates/`

- **`phase-arch-interview.md`** — interviewer prompt. To avoid questionnaire
  drift, it references the canonical topic list in `phase-architecture.md` §3
  ("run the questionnaire from phase-architecture.md §3") rather than copying
  it. Adds the interview.md output format.

- **`phase-arch-design.md`** — designer prompt with `{lens_name}`,
  `{lens_prompt}`, `{spec_file_path}`, `{interview_file_path}`,
  `{candidate_output_path}` variables.

- **`phase-arch-judge.md`** — judge prompt with `{criterion}`,
  `{candidates_dir}`, `{interview_excerpt}` variables and the JSON output
  schema inline.

- **`phase-arch-finalize.md`** — spawns **`architecture-agent`** (the name is
  load-bearing for advance-phase) with: interview digest path, candidates
  dir, judge verdicts inlined, and instructions to:
  (a) skip the interview — it is already done;
  (b) run the approach gate over the top 2–3 ranked candidates via
      AskUserQuestion with candidate content as previews, stating the panel's
      recommendation;
  (c) synthesize — winner + grafted `strongest_idea`s where compatible;
  (d) proceed with today's `phase-architecture.md` §5–6 unchanged
      (executable models, plan template, AD blocks, commit);
  (e) record `### AD-1: Approach selection (panel)` in
      `## Architectural Decisions`.

  The finalize prompt must reference the `architecture-tech-lead` skill by
  name — validate-agent-skill blocks the spawn otherwise (see hook-gate
  audit).

  All four templates follow the substitution authoring rule from the
  hook-gate audit: no literal `{...}` placeholders may survive substitution
  in the spawned prompt.

### 5. `agents/architecture-agent.md` — one carve-out

The current "**Never skip the interview or the approach gate**" gains:

> Exception: when the prompt provides a panel interview digest and candidate
> set (finalize mode), the interview is already done — never re-interview,
> but the approach gate remains mandatory.

### 6. `commands/loom.md` — flag + Phase 3 branch

- **Arguments:** `/loom --panel` (optionally `--panel=N`, default
  `PANEL_DESIGNERS_DEFAULT`).
- **Phase 3 panel branch:** spawn interviewer → verify `interview.md` exists
  → select lenses (rule below) → spawn N designers in ONE message (parallel)
  → verify candidate files exist → spawn K judges in one message → spawn
  architecture-agent with the finalize template → existing "wait for
  completion, extract plan path" flow unchanged.
- **Lens selection rule:** always `simplicity-first` + `type-driven-fp`;
  third lens from interview signals — sensitive boundaries flagged →
  `risk-security-first`; primary axis = performance → `performance-first`;
  brownfield → `codebase-conventionist`.
- **Phase 3.5 loop-back note:** gap-report re-runs use standard single-agent
  mode with the candidates dir mentioned as available context — never
  re-panel.
- **Flow diagram:** annotate the Phase 3 box with
  `--panel: interviewer → N designers ∥ → judges ∥ → finalize`.

### 7. `references/panel-lenses.md` — the five lens prompts

One section per lens:

| Lens | Optimizes for | Willing to sacrifice |
|---|---|---|
| `simplicity-first` | fewest moving parts, shortest path | extensibility |
| `type-driven-fp` | illegal states impossible, pure core | familiarity, some ceremony |
| `risk-security-first` | trust boundaries, failure containment | shipping speed |
| `performance-first` | latency/throughput/cost | abstraction purity |
| `codebase-conventionist` | fit with existing patterns | novelty, best-in-class choices |

Each lens section is a half-page prompt fragment: what it optimizes for, what
it sacrifices, and its characteristic failure mode (so designers do not
strawman their own lens). Loaded by the orchestrator, substituted into
`{lens_prompt}`.

### 8. Tests — `engine/tests/`

- `validate-phase-order`: panel agents ALLOWED when
  `current_phase = "architecture"` with spec present; BLOCKED during
  `init`/`execute`/`decompose`; blocked when spec.md missing (artifact gate
  holds).
- `advance-phase`: SubagentStop for each of the three panel agents is
  passthrough and never mutates `current_phase` — including the trap case
  where a same-date-prefix plan file already exists in `.claude/plans/`
  (regression test for design constraint 2).
- Config invariant test:
  `ARCH_PANEL_AGENTS ∩ Object.keys(PHASE_AGENT_MAP) = ∅` — encode the
  invariant, don't comment it.
- Template placeholder audit: for each of the four new templates, substitute
  every declared variable with a dummy value and assert the result contains
  no residual `{[a-zA-Z_][a-zA-Z0-9_]*}` match outside the
  validate-template-substitution false-positive set — encodes the authoring
  rule from the hook-gate audit.

### 9. Docs

- README + CHANGELOG entry for the flag.
- If the e2e smoke suite drives phase transitions, add one panel-mode path
  exercising interviewer → designer → finalize advancement.

## Implementation order

1. **Engine** (config + `detectPhase` + tests) — smallest change, unlocks
   everything, independently verifiable with `bun test`.
2. **Agent defs + templates + lenses reference** — pure authoring, no runtime
   risk.
3. **`loom.md` orchestration wiring + architecture-agent carve-out.**
4. **Docs + smoke test**, then a real `/loom --panel` dry run on a toy
   feature.

## Evaluation before any default-on decision

Run the A/B: same spec through both modes, diff the plans. Panel mode costs
roughly (N designers + K judges) extra agent runs per feature; it stays
opt-in until the synthesized plans demonstrably beat single-agent plans on
real features in this workflow.

## Out of scope (deliberately)

- **Workflow-tool orchestration of the panel.** The phase templates + parallel
  Task spawns already give the fan-out; a Workflow script cannot run
  AskUserQuestion, and the interactive interview + approach gate are the
  heart of the phase. Revisit only if the headless middle (designers +
  judges) grows complex enough to want deterministic control flow and
  schema-enforced verdicts.
- **Panel mode for brainstorm.** Plausible second target (divergent by
  nature), but prove the pattern on architecture first.
- **Panel mode for specify.** Bad fit — the spec should be one canonical
  statement of WHAT/WHY; competing specs are noise.
- **Panel mode for decompose.** Different shape entirely: competing task
  graphs would be judged mechanically (wave depth, parallelism width,
  dependency validity via the engine), so the judge is code, not an agent.
  Separate, later idea.
- **Making `--panel` the default.** Blocked on the A/B evidence above.
- **Persisting judge verdicts as standalone files.** The AD block in plan.md
  is the durable record; extra state files add guard surface for no reader.
- **Re-panelling on plan-alignment loop-back.** Loop-backs patch the winning
  design with the gap report in standard single-agent mode.
