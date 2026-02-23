# Plan: Plan-Alignment Phase

**Spec:** /home/peterstorm/dev/claude-plugins/loom/.claude/specs/2026-02-23-plan-alignment-phase/spec.md
**Created:** 2026-02-23

## Summary

Insert a `plan-alignment` phase between `architecture` and `decompose` that compares the architecture plan against the spec, writes a gap report artifact to disk, and prompts the user to either re-run architecture with feedback or proceed to decompose. The phase follows all existing loom patterns: union type in `types.ts`, ordering in `config.ts`, ts-pattern-based transition in `advance-phase.ts`, artifact check in `validate-phase-order.ts`, dedicated agent + template, and `phase-init.ts` skip-flag support.

---

## Architectural Decisions

### AD-1: Plan-alignment as a dedicated agent (not inline logic)

**Choice:** Create a `plan-alignment-agent` that reads spec + plan and produces the gap report artifact, consistent with how every other phase uses a dedicated agent.
**Why:** Every phase in loom follows the pattern: agent produces artifact, hook detects completion, advance-phase transitions. Inlining the comparison in the orchestrator would break this pattern and bypass hook enforcement.
**Rejected:**
- Inline comparison in loom.md orchestrator -- breaks agent-per-phase pattern, untestable, no transcript for hooks to parse
- Reuse architecture-agent with extra instructions -- overloads architecture-agent's responsibility, complicates dispatch categorization

### AD-2: Architecture loop-back via phase reset (not a separate mechanism)

**Choice:** When user chooses to re-run architecture after seeing gaps, the orchestrator (loom.md) sets `current_phase` back to `architecture` via the existing `StateManager.update()` and re-spawns `architecture-agent` with the gap report as additional context. When architecture completes, `advance-phase` naturally transitions to `plan-alignment` again.
**Why:** This reuses the existing phase machinery. The `advance-phase` handler already guards against double-advance by comparing completed vs current index. Setting phase back to `architecture` means the normal `architecture -> plan-alignment` transition fires again on completion. No new loop mechanism needed.
**Rejected:**
- Custom loop counter in state -- adds state complexity; the loop is driven by user choice in loom.md orchestrator, not by hooks
- New "re-architecture" phase -- unnecessary; same agent, same artifacts, just re-run

### AD-3: Gap report always written (even when no gaps)

**Choice:** Always write `.claude/specs/{slug}/plan-alignment.md`, even when the plan fully covers the spec. The artifact states "No gaps found" in that case.
**Why:** Resolves FR-011 clarification. The artifact's existence is the signal that plan-alignment completed (used by `validate-phase-order` to gate decompose). Without it, there's no artifact to check. Also provides an audit trail per US3.

### AD-4: Flat list of gaps (no grouping by type)

**Choice:** Gap report lists all missing requirements as a flat list, each prefixed with its ID (e.g., `FR-003`, `SC-001`, `US2`).
**Why:** Resolves Open Q2. Flat list is simpler to parse, simpler to produce, and the user can visually distinguish FR/SC/US from the prefix. Grouping adds complexity with no clear benefit at this stage. Out-of-scope explicitly excludes "scoring or severity levels."

### AD-5: Plan-alignment runs even with --skip-specify

**Choice:** Plan-alignment runs whenever architecture completes, regardless of how the spec was provided.
**Why:** Resolves Open Q1. External specs are still specs -- they have FRs, SCs, USs that the plan should cover. Skipping plan-alignment when --skip-specify is used would defeat the purpose of the feature. The user can always `--skip-plan-alignment` if they want to bypass.

---

## File Structure

### Type & Config Foundation

```
engine/src/types.ts                    -- add "plan-alignment" to Phase union
engine/src/config.ts                   -- add to PHASE_ORDER, PHASE_AGENT_MAP, VALID_TRANSITIONS
```

### Phase Initialization

```
engine/src/phase-init.ts               -- add skipPlanAlignment flag handling
```

### Phase Transition (advance-phase)

```
engine/src/handlers/subagent-stop/advance-phase.ts  -- add plan-alignment transition cases
```

### Phase Validation (validate-phase-order)

```
engine/src/handlers/pre-tool-use/validate-phase-order.ts  -- add plan-alignment artifact check + gate decompose
```

### Dispatch Routing

```
engine/src/handlers/subagent-stop/dispatch.ts  -- plan-alignment-agent categorized as "phase"
```

### Agent Definition

```
agents/plan-alignment-agent.md         -- new agent definition
```

### Phase Template

```
commands/templates/phase-plan-alignment.md  -- new template for spawning plan-alignment-agent
```

### Orchestrator Documentation

```
commands/loom.md                       -- add plan-alignment phase to flow, skip flag, loop-back logic
```

### Tests

```
engine/tests/handlers/subagent-stop/advance-phase.test.ts   -- add plan-alignment transition tests
engine/tests/handlers/validate-phase-order.test.ts           -- add plan-alignment gate tests
engine/tests/phase-init.test.ts                              -- add skipPlanAlignment tests
```

---

## Component Design

### Phase Union & Config (types.ts, config.ts)

**Responsibility:** Define plan-alignment as a first-class phase in the type system and ordering.
**Files:** `engine/src/types.ts`, `engine/src/config.ts`
**Interface:**

```typescript
// types.ts -- add to Phase union
export type Phase = "init" | "brainstorm" | "specify" | "clarify" | "architecture" | "plan-alignment" | "decompose" | "execute";

// config.ts -- PHASE_ORDER insert between architecture and decompose
export const PHASE_ORDER: readonly Phase[] = [
  "init", "brainstorm", "specify", "clarify", "architecture", "plan-alignment", "decompose", "execute",
] as const;

// config.ts -- PHASE_AGENT_MAP
export const PHASE_AGENT_MAP: Record<string, Phase> = {
  ...existing,
  "plan-alignment-agent": "plan-alignment",
};

// config.ts -- VALID_TRANSITIONS
export const VALID_TRANSITIONS: Record<string, Phase[]> = {
  ...existing,
  "architecture": ["architecture", "plan-alignment"],       // was ["architecture", "decompose"]
  "plan-alignment": ["plan-alignment", "architecture", "decompose"],  // can loop back to architecture or proceed
};
```

**Depends on:** none

### Phase Initialization (phase-init.ts)

**Responsibility:** Handle `--skip-plan-alignment` flag by adding "plan-alignment" to `skipped_phases`.
**Files:** `engine/src/phase-init.ts`
**Interface:**

```typescript
export interface SkipFlags {
  skipBrainstorm?: boolean;
  skipClarify?: boolean;
  skipSpecify?: boolean;
  skipPlanAlignment?: boolean;  // new
}
```

When `skipPlanAlignment` is true, add `"plan-alignment"` to `skipped_phases`. This does NOT change `current_phase` -- it only tells `advance-phase` to skip over the phase when architecture completes.

**Depends on:** Phase Union & Config

### Advance Phase Handler (advance-phase.ts)

**Responsibility:** Add transition logic for architecture -> plan-alignment and plan-alignment -> decompose.
**Files:** `engine/src/handlers/subagent-stop/advance-phase.ts`
**Interface:**

```typescript
// In resolveTransition, the "architecture" case changes:
.with("architecture", () => {
  const plan = state.plan_file;
  if (!plan || !existsSync(plan) || !plan.includes(".claude/plans/")) return null;
  // If plan-alignment is skipped, go straight to decompose (existing behavior)
  if (state.skipped_phases.includes("plan-alignment")) {
    return { nextPhase: "decompose" as Phase, artifact: plan };
  }
  return { nextPhase: "plan-alignment" as Phase, artifact: plan };
})

// New case for plan-alignment completion:
.with("plan-alignment", () => {
  // Check gap report artifact exists at .claude/specs/{slug}/plan-alignment.md
  const specDir = state.spec_dir ?? ".claude/specs";
  const gapReport = findFile(specDir, "plan-alignment.md");
  if (!gapReport) return null;
  return { nextPhase: "decompose" as Phase, artifact: gapReport };
})
```

The loop-back (re-run architecture) is NOT handled here. That happens in the orchestrator (loom.md) which manually sets `current_phase` back to `architecture`. When architecture re-completes, this handler fires again and transitions to `plan-alignment` naturally.

**Depends on:** Phase Union & Config

### Validate Phase Order (validate-phase-order.ts)

**Responsibility:** Gate decompose behind plan-alignment completion. Gate plan-alignment behind architecture completion.
**Files:** `engine/src/handlers/pre-tool-use/validate-phase-order.ts`
**Interface:**

```typescript
// In detectPhase, add prompt-based fallback:
if (/plan.alignment|gap.report/i.test(prompt)) return "plan-alignment";

// In checkArtifacts, add two cases:
.with("plan-alignment", () => {
  // Requires plan_file from architecture
  const plan = state.phase_artifacts.architecture ?? state.plan_file;
  if (!plan || !existsSync(plan)) return "architecture (no plan.md found)";
  return null;
})
.with("decompose", () => {
  // Existing: requires plan.md
  const plan = state.phase_artifacts.architecture ?? state.plan_file;
  if (!plan || !existsSync(plan)) return "architecture (no plan.md found)";
  // NEW: also require plan-alignment artifact (or skipped)
  if (!state.skipped_phases.includes("plan-alignment")) {
    const specDir = state.spec_dir ?? ".claude/specs";
    if (!findFile(specDir, "plan-alignment.md")) {
      return "plan-alignment (no plan-alignment.md found)";
    }
  }
  return null;
})
```

Also update the block message for `architecture` current phase to mention plan-alignment as the next step.

**Depends on:** Phase Union & Config

### Plan-Alignment Agent (agents/plan-alignment-agent.md)

**Responsibility:** Agent definition that reads spec + plan, performs semantic comparison, writes gap report.
**Files:** `agents/plan-alignment-agent.md`
**Interface:**

```yaml
---
name: plan-alignment-agent
description: Compares architecture plan against spec requirements, produces gap report. Use when loom reaches plan-alignment phase.
model: sonnet
color: cyan
tools:
  - Read
  - Glob
  - Grep
  - Write
  - Edit
---
```

The agent:
1. Reads spec file (extracts all FR-xxx, SC-xxx, US-xxx requirements)
2. Reads plan file (extracts coverage via semantic matching)
3. For each requirement, determines if the plan addresses it (by meaning, not literal text)
4. Writes gap report to `.claude/specs/{slug}/plan-alignment.md`
5. Outputs the gap report path and a summary

**Depends on:** none (file only, no code deps)

### Phase Template (commands/templates/phase-plan-alignment.md)

**Responsibility:** Template prompt for spawning plan-alignment-agent with substituted variables.
**Files:** `commands/templates/phase-plan-alignment.md`
**Interface:**

Variables to substitute:
- `{spec_file_path}` -- absolute path to spec.md
- `{plan_file_path}` -- absolute path to plan.md
- `{spec_dir}` -- directory containing spec artifacts (for writing gap report)

Template instructs the agent to:
1. Read spec, extract all numbered requirements (FR-xxx, SC-xxx, US-xxx)
2. Read plan, match each requirement to plan coverage
3. Write gap report to `{spec_dir}/plan-alignment.md`
4. Report must list all requirements with coverage status
5. Report must explicitly state if no gaps found
6. Agent must NOT modify spec or plan files

**Depends on:** Plan-Alignment Agent

### Orchestrator Updates (commands/loom.md)

**Responsibility:** Add plan-alignment to the flow diagram, add --skip-plan-alignment flag documentation, add loop-back logic for re-running architecture.
**Files:** `commands/loom.md`
**Interface:**

New section between Phase 3 (Architecture) and Phase 4 (Decompose):

```
## Phase 3.5: Plan Alignment

**Always run** (unless `--skip-plan-alignment` flag provided).

**Load template:** Read `{LOOM_DIR}/commands/templates/phase-plan-alignment.md`

Substitute variables:
- `{spec_file_path}` - Path to spec
- `{plan_file_path}` - Path to plan from Phase 3
- `{spec_dir}` - Spec directory

**Spawn plan-alignment-agent** with the substituted template as prompt.

**Wait for agent completion.** Read gap report.

**If gaps found:** Present gap report to user. Ask:
> "N gaps found. Re-run architecture with this feedback, or proceed to decompose?"

If re-run: set current_phase back to "architecture" via StateManager, re-spawn architecture-agent with gap report appended to prompt.
If proceed: continue to Phase 4.

**If no gaps:** Proceed to Phase 4.
```

Also:
- Add `--skip-plan-alignment` to arguments section
- Update flow diagram ASCII art
- Update phase enforcement table
- Update `init-state` CLI docs to include `--skip-plan-alignment`
- Add plan-alignment to error recovery table

**Depends on:** Phase Template, Advance Phase Handler, Validate Phase Order

---

## Data Flow

```
Spec (spec.md) + Plan (plan.md) --> plan-alignment-agent --> Gap Report (plan-alignment.md)
                                                                |
                                                    [user prompt if gaps]
                                                       /              \
                                              re-run arch          proceed
                                                   |                  |
                                          architecture-agent     decompose
                                                   |
                                          plan-alignment (again)
```

The gap report is the phase artifact. Its existence at `.claude/specs/{slug}/plan-alignment.md` gates decompose entry. The loop-back is orchestrator-driven (loom.md), not hook-driven -- loom.md manually resets `current_phase` to `architecture` and re-spawns the agent.

---

## Implementation Phases

Ordered by dependency. Maps directly to decompose waves.

### Phase 1: Type & Config Foundation (no dependencies)

- Add `"plan-alignment"` to Phase union in `types.ts`
- Update `PHASE_ORDER`, `PHASE_AGENT_MAP`, `VALID_TRANSITIONS` in `config.ts`
- Update `SkipFlags` interface and `resolveInitialState` in `phase-init.ts` for `--skip-plan-alignment`
- Update `parseInitStateArgs` in `cli.ts` to accept `--skip-plan-alignment`
- Add tests for new skip flag in `phase-init.test.ts`
- **Files:** `engine/src/types.ts`, `engine/src/config.ts`, `engine/src/phase-init.ts`, `engine/src/cli.ts`, `engine/tests/phase-init.test.ts`

### Phase 2: Hook Handlers (depends on Phase 1)

- Update `resolveTransition` in `advance-phase.ts`: change architecture case to transition to `plan-alignment` (or `decompose` if skipped); add `plan-alignment` case that transitions to `decompose`
- Update `checkArtifacts` and `detectPhase` in `validate-phase-order.ts`: add plan-alignment prerequisite check; gate decompose behind plan-alignment artifact
- Verify dispatch.ts `categorize` already works (plan-alignment-agent maps via `PHASE_AGENT_MAP`, returns "phase") -- no code change needed, just verify
- Add tests for new transitions in `advance-phase.test.ts`
- Add tests for new artifact checks in `validate-phase-order.test.ts`
- **Files:** `engine/src/handlers/subagent-stop/advance-phase.ts`, `engine/src/handlers/pre-tool-use/validate-phase-order.ts`, `engine/tests/handlers/subagent-stop/advance-phase.test.ts`, `engine/tests/handlers/validate-phase-order.test.ts`

### Phase 3: Agent + Template (depends on Phase 1)

- Create `agents/plan-alignment-agent.md` with agent definition
- Create `commands/templates/phase-plan-alignment.md` with substitution variables and agent instructions
- **Files:** `agents/plan-alignment-agent.md`, `commands/templates/phase-plan-alignment.md`

### Phase 4: Orchestrator Documentation (depends on Phase 2 + Phase 3)

- Update `commands/loom.md` with plan-alignment phase section, skip flag, loop-back logic, updated flow diagram, updated phase enforcement table
- **Files:** `commands/loom.md`

---

## Testing Strategy

Per component, not global.

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Phase Union & Config | Verify PHASE_ORDER contains plan-alignment between architecture and decompose; verify VALID_TRANSITIONS entries; verify PHASE_AGENT_MAP has plan-alignment-agent | none | none |
| Phase Init | `--skip-plan-alignment` adds to skipped_phases; combines with other skip flags without duplicates; `--skip-specify` still works (does NOT auto-skip plan-alignment) | none | none |
| Advance Phase | architecture -> plan-alignment when not skipped; architecture -> decompose when plan-alignment skipped; plan-alignment -> decompose when gap report exists; plan-alignment -> null when gap report missing | none | none |
| Validate Phase Order | plan-alignment blocked when no plan_file; decompose blocked when no plan-alignment.md and not skipped; decompose allowed when plan-alignment skipped; detectPhase recognizes plan-alignment-agent | none | none |

All tests are pure function tests on exported functions (`resolveTransition`, `checkArtifacts`, `detectPhase`, `resolveInitialState`). No mocks needed -- these functions take data and return data, with only filesystem reads for artifact existence checks (use temp dirs as existing tests do).

---

## Security & NFR Notes

- **Performance:** Plan-alignment agent is a single LLM call reading two files. Well within the 120-second NFR-001 budget for typical specs (< 50 requirements).
- **Reliability:** If plan-alignment-agent fails to produce a gap report, `resolveTransition` returns null (no artifact found), which means `advance-phase` does NOT advance. The orchestrator surfaces the error. Satisfies NFR-002.
- **Loop cap:** Spec Risk table mentions capping re-run iterations. The orchestrator (loom.md) should warn after 2 loop-backs but not hard-block. This is orchestrator-level prose, not engine logic -- the engine has no loop concept, just phase transitions.

---

## Verification

1. `cd /home/peterstorm/dev/claude-plugins/loom/engine && bun test` -- all existing + new tests pass
2. Manual: run `/loom` on a test feature, verify plan-alignment phase fires between architecture and decompose
3. Manual: verify `--skip-plan-alignment` bypasses the phase
4. Manual: verify gap report written to `.claude/specs/{slug}/plan-alignment.md`
5. Manual: verify choosing "re-run architecture" loops back correctly without double-advancing
