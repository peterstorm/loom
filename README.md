# Loom

A Claude Code plugin for orchestrating complex, multi-phase software development features with wave-based parallel task execution.

Loom decomposes large features into structured phases (brainstorm, specify, architect, decompose), then executes implementation through parallel waves of specialized agents — with automated test verification, spec alignment checks, and code review gates at every stage.

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Orchestration Phases](#orchestration-phases)
- [Wave Execution & Gates](#wave-execution--gates)
- [Skills (Commands)](#skills-commands)
- [Agents](#agents)
- [Hook System](#hook-system)
- [State Management](#state-management)
- [Engine](#engine)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Quick Start

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Bun](https://bun.sh/) runtime (hooks use TypeScript via bun)
- GitHub CLI (`gh`) for issue tracking

### Installation

Install as a Claude Code plugin:

```bash
claude plugin add /path/to/loom
```

### Usage

```bash
# Full orchestration flow
/loom "Add user authentication with email/password"

# Skip brainstorm (scope already clear)
/loom --skip-brainstorm "Add logout button to navbar"

# Skip to architecture (spec already exists)
/loom --skip-specify "Add user authentication"

# Skip plan alignment
/loom --skip-plan-alignment "Simple CRUD feature"

# After wave implementation completes
/wave-gate

# Standalone PR review
/review-pr
/review-pr code errors tests
```

## How It Works

Loom turns a feature description into working code through a structured pipeline:

```
  Feature Description
         |
         v
  +------------------+     +------------------+     +------------------+
  | Phase 0:         | --> | Phase 1:         | --> | Phase 2:         |
  | BRAINSTORM       |     | SPECIFY          |     | CLARIFY          |
  | Explore intent,  |     | Formal spec with |     | Resolve [NEEDS   |
  | propose approaches|     | FRs, scenarios   |     | CLARIFICATION]   |
  +------------------+     +------------------+     +------------------+
                                                            |
         +--------------------------------------------------+
         v
  +------------------+     +------------------+     +------------------+
  | Phase 3:         | --> | Phase 3.5:       | --> | Phase 4:         |
  | ARCHITECTURE     |     | PLAN ALIGNMENT   |     | DECOMPOSE        |
  | Design decisions,|     | Verify plan      |     | Task graph, wave |
  | patterns, modules|     | covers spec      |     | schedule, GH issue|
  +------------------+     +------------------+     +------------------+
                                                            |
         +--------------------------------------------------+
         v
  +------------------+
  | Phase 5:         |
  | EXECUTE          |
  | Wave-by-wave     |
  | parallel impl    |
  +------------------+
         |
    +----+----+----+
    v    v    v    v       (parallel agents per wave)
   T1   T2   T3   T4
    |    |    |    |
    +----+----+----+
         |
         v
  +------------------+
  | WAVE GATE        |
  | Tests + Spec     |
  | Check + Review   |
  +------------------+
         |
         v
    Next wave...
```

Each phase is executed by a specialized agent. Hooks enforce ordering, capture artifacts, and manage state transitions automatically.

## Orchestration Phases

### Phase 0: Brainstorm

**Agent:** `brainstorm-agent` (Opus) | **Output:** `.claude/specs/{slug}/brainstorm.md`

Explores the problem space. The agent asks clarifying questions, proposes 2-3 approaches with trade-offs, and gets user confirmation on direction. No code is written.

Skip with `--skip-brainstorm` when scope is already clear.

### Phase 1: Specify

**Agent:** `specify-agent` (Opus) | **Output:** `.claude/specs/{slug}/spec.md`

Produces a formal specification with:
- User scenarios (Given/When/Then)
- Functional requirements (FR-001, FR-002, ...)
- Success criteria and acceptance tests
- Out-of-scope boundaries

Markers like `[NEEDS CLARIFICATION]` flag unresolved ambiguities.

### Phase 2: Clarify

**Agent:** `clarify-agent` (Opus) | **Output:** Updated `spec.md`

Triggered automatically when the spec contains more than 3 `[NEEDS CLARIFICATION]` markers. The agent asks the user structured questions to resolve each ambiguity, then updates the spec in place.

Skip with `--skip-clarify` to accept markers as-is.

### Phase 3: Architecture

**Agent:** `architecture-agent` (Opus) | **Output:** `.claude/plans/{slug}.md`

Designs the implementation: module boundaries, data models, patterns (functional core/imperative shell, DDD, Either-based errors), technology choices, and dependency graphs. Preloads the `architecture-tech-lead` skill for domain expertise.

### Phase 3.5: Plan Alignment

**Agent:** `plan-alignment-agent` (Opus) | **Output:** `.claude/specs/{slug}/plan-alignment.md`

Compares the architecture plan against the spec to detect gaps — requirements that aren't addressed by the plan. If gaps are found, the user can choose to re-run architecture with the gap report as additional context, creating a feedback loop.

Skip with `--skip-plan-alignment`.

### Phase 4: Decompose

**Agent:** `decompose-agent` (Sonnet) | **Output:** JSON task graph

Converts the spec + plan into a concrete task graph:
- 8-12 tasks maximum
- 4-5 waves
- 4-6 parallel tasks per wave
- Each task assigned to a specialized agent
- Dependencies only flow backward (wave N depends on waves 1..N-1)
- Spec anchors (FR-XXX) mapped to each task

On user approval, the plugin:
1. Validates the task graph schema
2. Creates a GitHub Issue for tracking
3. Populates the state file with tasks and wave schedule

### Phase 5: Execute

For each wave, all tasks are spawned as parallel agents in a single message. Each implementation agent must:

1. Read the plan and understand its assigned task
2. Implement code following project patterns
3. Write tests
4. **Run tests via Bash** (mandatory — hooks extract evidence from transcripts)
5. Verify all tests pass

After all wave tasks reach "implemented", run `/wave-gate` to verify and advance.

## Wave Execution & Gates

The `/wave-gate` skill runs a 5-step verification sequence after each wave completes:

### Gate Sequence

| Step | What | How |
|------|------|-----|
| 1 | **Test evidence** | Verify all wave tasks have `tests_passed == true` (auto-extracted by hooks) |
| 2 | **New test verification** | Verify agents wrote new test methods (git diff per task) |
| 3 | **Spec alignment** | Spawn `spec-check-invoker` — mechanically verifies code satisfies each FR |
| 4 | **Code review** | Spawn 5 review agents per task in parallel |
| 5 | **Advance** | `complete-wave-gate` helper validates all checks and advances |

### Review Agents (spawned per task)

| Agent | Focus |
|-------|-------|
| `code-reviewer` | Style, patterns, CLAUDE.md compliance, bugs |
| `silent-failure-hunter` | Error handling, Either patterns, silent swallowing |
| `pr-test-analyzer` | Test coverage quality, property tests, gaps |
| `type-design-analyzer` | Type invariants, encapsulation, sealed types |
| `comment-analyzer` | Comment accuracy, documentation rot |

### Gate Outcomes

- **PASSED** — All 5 checks clear. Tasks marked "completed", wave advances, GitHub issue updated.
- **BLOCKED** — Critical findings exist. Fix issues and re-run `/wave-gate`. On re-run, only blocked tasks are re-reviewed.

## Skills (Commands)

Skills are user-invokable commands defined in `/commands/`. Each provides structured instructions for Claude to follow.

| Skill | Usage | Purpose |
|-------|-------|---------|
| `/loom` | `/loom "description"` | Full orchestration entry point |
| `/wave-gate` | `/wave-gate` | Test + spec + review gate after wave completion |
| `/review-pr` | `/review-pr [aspects] [--files f1,f2]` | Standalone PR review with parallel agents |
| `/spec-check` | `/spec-check` | Verify implementation aligns with spec |
| `/brainstorming` | (used by brainstorm-agent) | Problem exploration process |
| `/specify` | (used by specify-agent) | Formal specification process |
| `/clarify` | (used by clarify-agent) | Uncertainty resolution process |
| `/code-implementer` | (used by code-implementer-agent) | FP/DDD implementation patterns |
| `/architecture-tech-lead` | (used by architecture-agent) | Architecture design process |

Additional bundled skills:
- `/nextjs-frontend-design` — Next.js App Router, React Server Components, distinctive UI
- `/vercel-react-best-practices` — React/Next.js performance rules from Vercel Engineering (57 rules)

## Agents

Agents are specialized subprocesses defined in `/agents/`. Each has a model, optional skills, and focused instructions.

### Phase Agents (sequential)

| Agent | Model | Skills | Role |
|-------|-------|--------|------|
| `brainstorm-agent` | Opus | brainstorming | Explore intent, propose approaches |
| `specify-agent` | Opus | specify | Write formal spec |
| `clarify-agent` | Opus | clarify | Resolve spec ambiguities |
| `architecture-agent` | Opus | architecture-tech-lead | Design implementation plan |
| `plan-alignment-agent` | Opus | — | Compare plan vs spec, gap report |
| `decompose-agent` | Sonnet | — | Spec+plan into JSON task graph |

### Implementation Agents (parallel per wave)

| Agent | Model | Skills | Role |
|-------|-------|--------|------|
| `code-implementer-agent` | Sonnet | code-implementer | Java/Spring Boot or TS/Next.js implementation |
| `frontend-agent` | Sonnet | — | React/Next.js frontend components |
| `ts-test-agent` | Sonnet | — | TypeScript testing (Vitest, RTL, Playwright) |
| `security-agent` | Sonnet | — | Auth, JWT, OAuth, vulnerability assessment |
| `dotfiles-agent` | Sonnet | — | NixOS, home-manager, SOPS secrets |

### Review Agents (parallel per task at wave gate)

| Agent | Model | Role |
|-------|-------|------|
| `code-reviewer` | Sonnet | Style, bugs, patterns |
| `silent-failure-hunter` | Sonnet | Error handling, silent failures |
| `pr-test-analyzer` | Sonnet | Test coverage quality |
| `type-design-analyzer` | Sonnet | Type safety and design |
| `comment-analyzer` | Sonnet | Comment accuracy |
| `code-simplifier` | Sonnet | Clarity and maintainability |
| `spec-check-invoker` | Sonnet | Runs /spec-check for wave gates |

### Utility Agents

| Agent | Role |
|-------|------|
| `architecture-tech-lead` | Architectural review of large PRs |
| `skill-content-reviewer` | Skill/command quality review |
| `test-engineer` | General test engineering |

## Hook System

Hooks are the enforcement and automation backbone. They fire on Claude Code lifecycle events and are configured in `/hooks/hooks.json`.

### Hook Events

#### PreToolUse — Validation & Blocking

Fires before a tool executes. Can block the tool call with an error message.

| Hook | Matcher | Purpose |
|------|---------|---------|
| `validate-phase-order` | Task | Blocks agent spawns if prerequisites incomplete |
| `validate-task-execution` | Task | Validates wave ordering during execution |
| `validate-template-substitution` | Task | Blocks unsubstituted `{variable}` patterns in prompts |
| `validate-agent-model` | Task | Validates agent model field |
| `validate-agent-skill` | Task | Validates agent skill field |
| `block-direct-edits` | Edit/Write/MultiEdit | Forces all file changes through Task tool (subagents) |
| `guard-state-file` | Bash | Blocks direct writes to state file (only whitelisted helpers allowed) |

#### SubagentStart — Lifecycle Tracking

| Hook | Matcher | Purpose |
|------|---------|---------|
| `mark-subagent-active` | * | Tracks active subagents in `/tmp/claude-subagents/` |

#### SubagentStop — Phase Advancement & Status

All SubagentStop events route through `dispatch`, which examines the agent type and delegates:

| Handler | Fires For | Purpose |
|---------|-----------|---------|
| `advance-phase` | Phase agents | Advances `current_phase`, captures artifact paths |
| `update-task-status` | Implementation agents | Extracts test evidence from transcript, sets `tests_passed`, `new_tests_written`, `files_modified` |
| `store-reviewer-findings` | Review agents | Parses review findings into per-task `critical_findings` / `advisory_findings` |
| `store-spec-check-findings` | spec-check-invoker | Parses spec-check output into `spec_check.verdict` |
| `cleanup-subagent-flag` | All agents | Cleans up tracking files |

#### SessionStart — Initialization

| Hook | Matcher | Purpose |
|------|---------|---------|
| `cleanup-stale-subagents` | * | Clears stale tracking files |
| `resume-after-clear` | clear | Restores execution context after `/clear` command |

### Hook Pipeline Flow

```
Agent spawn requested
       |
       v
  PreToolUse hooks fire (sequentially)
  [validate-phase-order] --> [validate-task-execution] --> [validate-template-substitution] --> ...
       |
       | (all pass)
       v
  Agent starts
       |
       v
  SubagentStart: mark-subagent-active
       |
       v
  Agent executes...
       |
       v
  Agent completes
       |
       v
  SubagentStop: dispatch
       |
       +---> Phase agent?  --> advance-phase (update current_phase, capture artifacts)
       +---> Impl agent?   --> update-task-status (extract test evidence, set status)
       +---> Review agent?  --> store-reviewer-findings (parse findings)
       +---> Spec-check?    --> store-spec-check-findings (parse verdict)
       +---> Always         --> cleanup-subagent-flag
```

## State Management

### State File

**Path:** `.claude/state/active_task_graph.json`

The state file is the single source of truth for orchestration progress. It tracks:

```typescript
interface TaskGraph {
  current_phase: Phase;              // Current orchestration phase
  phase_artifacts: Record<Phase, string>; // File paths for phase outputs
  skipped_phases: Phase[];           // Phases bypassed with --skip-X flags
  spec_dir: string;                  // Spec directory path
  spec_file: string | null;          // Path to spec.md
  plan_file: string | null;          // Path to plan.md
  tasks: Task[];                     // Task definitions + status
  current_wave: number;              // Active execution wave
  executing_tasks: string[];         // IDs of tasks in progress
  wave_gates: Record<string, WaveGate>; // Per-wave verification status
  github_issue: number;              // GitHub Issue number
  spec_check: SpecCheck;             // Latest spec alignment result
}
```

### Protection Model

The state file uses a layered protection scheme:

1. **File permissions:** `chmod 444` at rest (read-only). Only `StateManager` can write by temporarily toggling to 644.
2. **Hook guard:** `guard-state-file` blocks any Bash command that writes to the state file, except whitelisted helpers.
3. **Atomic writes:** `StateManager` uses file locking + tmp-file-then-rename for crash safety.
4. **Subagent isolation:** Subagents cannot directly edit the state file — only hooks running in the parent process can.

### Task Status Transitions

```
pending -----> implemented     (agent completes, test evidence extracted)
pending -----> failed          (agent crash; retry_count incremented)
failed ------> pending         (auto-retry, max 2 attempts)
implemented -> completed       (wave gate passed)
```

### State File Lifecycle

1. **Created** at `/loom` invocation (before Phase 0) with minimal fields
2. **Updated** by hooks as phases advance and artifacts are captured
3. **Populated** at Phase 4 with full task graph after decompose
4. **Updated** during execution as tasks progress through statuses
5. **Removed** on `/loom --complete` or `/loom --abort`

## Engine

The TypeScript engine (`/engine/`) provides the runtime for all hooks and helpers.

### Architecture

```
engine/
├── src/
│   ├── cli.ts              # Single entry point — dynamic handler dispatch
│   ├── config.ts            # Constants (thresholds, agent maps, patterns)
│   ├── types.ts             # Core type definitions
│   ├── state-manager.ts     # Atomic state file read/write with locking
│   ├── phase-init.ts        # Initial state resolution from skip flags
│   ├── handlers/
│   │   ├── pre-tool-use/    # Validation hooks
│   │   ├── subagent-stop/   # Phase/status/review hooks
│   │   ├── subagent-start/  # Lifecycle tracking
│   │   ├── session-start/   # Initialization + resume-after-clear hooks
│   │   └── helpers/         # Whitelisted helper scripts + utility modules
│   ├── parsers/             # Extract structured data from agent transcripts
│   └── utils/               # Git operations, file locking, file search
└── tests/                   # Unit, property-based, and e2e tests
```

### CLI Entry Point

All shell shims in `/hooks/scripts/` delegate to the single CLI:

```bash
exec bun ${LOOM_DIR}/engine/src/cli.ts <hook-type> <handler-name> [extra-args...]
```

The CLI reads JSON from stdin (provided by Claude Code), dynamically imports the handler module, executes it, and maps the `HookResult` to an exit code:

| Result | Exit Code | Meaning |
|--------|-----------|---------|
| `allow` | 0 | Tool call proceeds |
| `passthrough` | 0 | Hook doesn't apply, pass through |
| `block` | 2 | Tool call blocked (message shown to Claude) |
| `error` | 1 | Hook error |

### Parsers

The engine includes parsers for extracting structured data from agent output:

- **Test output parser** — Recognizes pass/fail markers from Maven, Vitest, Jest, pytest, cargo test, Go test, and more
- **Phase artifact parser** — Extracts file paths from agent transcripts
- **Files modified parser** — Extracts changed file lists from git diff output
- **Transcript parser** — General-purpose transcript extraction

### Technology Stack

- **Runtime:** [Bun](https://bun.sh/)
- **Language:** TypeScript
- **Pattern matching:** [ts-pattern](https://github.com/gvergnaud/ts-pattern) (exhaustive matching on HookResult)
- **Testing:** [Vitest](https://vitest.dev/) + [fast-check](https://github.com/dubzzz/fast-check) (property-based testing)

## Configuration

### Key Constants (`engine/src/config.ts`)

| Constant | Purpose |
|----------|---------|
| `CLARIFY_THRESHOLD` | Markers above this trigger mandatory clarify phase (default: 3) |
| `PHASE_ORDER` | Valid phase sequence |
| `PHASE_AGENT_MAP` | Maps each phase to the agent that runs it |
| `IMPL_AGENTS` | Implementation agents allowed to spawn during the execute phase |
| `REVIEW_SUB_AGENTS` | Review agents whose findings feed wave gates |
| `WHITELISTED_HELPERS` | Helper scripts allowed to write to the state file |

### Plan Limits

| Limit | Value |
|-------|-------|
| Max tasks | 8-12 |
| Max waves | 4-5 |
| Max parallel per wave | 4-6 |

### Valid Phase Transitions

```
init            -> brainstorm, specify, architecture
brainstorm      -> brainstorm, specify
specify         -> specify, clarify, architecture
clarify         -> clarify, architecture
architecture    -> architecture, plan-alignment, decompose
plan-alignment  -> plan-alignment, architecture, decompose
decompose       -> decompose, execute
execute         -> execute
```

## Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Task stuck `in_progress` | Agent hung without crash | Re-spawn the task |
| `tests_passed` missing | Agent didn't run tests via Bash | Re-spawn — agent MUST execute tests |
| `new_tests_written` false | Agent reused existing tests | Re-spawn — agent must write new tests |
| Wave not advancing | Gate blocked by critical findings | Fix issues, re-run `/wave-gate` |
| State write blocked | Guard hook active | All writes go through hooks; reads are fine |
| Phase agent blocked | Prerequisite phase not complete | Check `current_phase` in state; complete prerequisites |
| Template variables in prompt | `{variable}` not substituted | Hook blocks this — substitute all variables before spawning |

### Observability

```bash
# Full state
jq '.' .claude/state/active_task_graph.json

# Per-task status
jq '.tasks[] | {id, status, tests_passed, review_status}' .claude/state/active_task_graph.json

# Current wave and gate status
jq '{wave: .current_wave, gates: .wave_gates}' .claude/state/active_task_graph.json

# Spec-check results
jq '.spec_check' .claude/state/active_task_graph.json
```

### Fixing Blocked Waves

When a wave gate is blocked by critical findings:

1. **Spawn a fix agent via Task** — subagents can still Edit/Write (only the orchestrator is blocked)
2. **Re-run `/wave-gate`** — re-reviews only blocked tasks
3. **Override false positives** — use whitelisted helpers to correct findings (requires user approval)
4. **Emergency** — remove state file, fix manually, rebuild from GitHub issue

## Development

### Running Tests

```bash
cd engine
bun test              # Run all tests
bun test --watch      # Watch mode
bunx tsc --noEmit     # Type checking
```

### Test Coverage

The test suite includes 28 test files covering:

- **Unit tests** — Every handler, parser, and utility
- **Property-based tests** — Git utilities, task status transitions, task graph validation (via fast-check)
- **E2E tests** — Full hook pipeline sequencing
- **Integration tests** — State manager with file locking

### Project Structure

```
loom/
├── .claude-plugin/
│   └── plugin.json            # Plugin metadata
├── agents/                     # Agent definitions
├── commands/                   # Skill definitions
│   └── templates/              # Phase prompt templates
├── engine/                     # TypeScript hook engine
│   ├── src/                    # Source code
│   └── tests/                  # Test suite
├── hooks/
│   ├── hooks.json              # Hook configuration
│   └── scripts/                # Shell shims
└── references/                 # Spec and plan templates
```

## License

MIT
