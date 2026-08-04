# Loom

A Claude Code plugin for orchestrating complex, multi-phase software features with wave-based parallel task execution — and a toolbox of standalone skills, agents, and a programmatic linter you can use independently.

Loom turns a feature description into shipping code through a structured pipeline: **brainstorm → specify → clarify → architect → plan-alignment → decompose → execute (waves) → wave-gate (test + spec-check + review)**. Each phase is run by a specialized agent. Hooks enforce phase ordering, capture artifacts, resolve test evidence (evidence ledger first, labeled transcript fallback), and protect the state file. A built-in linter runs on every file edit and again at wave-gate boundaries.

Loom also runs on [Pi](https://github.com/earendil-works/pi-coding-agent) — the engine is harness-agnostic and ships a Pi extension.

---

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Orchestration Phases](#orchestration-phases)
- [Wave Execution & Gates](#wave-execution--gates)
- [Slash Commands](#slash-commands)
- [Skills](#skills)
- [Agents](#agents)
- [Hook System](#hook-system)
- [Linter](#linter)
- [State Management](#state-management)
- [Engine](#engine)
- [Configuration](#configuration)
- [Directory Layout](#directory-layout)
- [Pi Harness](#pi-harness)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Quick Start

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (primary harness) **or** [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent)
- [Bun](https://bun.sh/) runtime — hooks dispatch through a TypeScript CLI run by bun
- [GitHub CLI](https://cli.github.com/) (`gh`) — for issue creation and wave-gate comment posting

### Installation

```bash
claude plugin add /path/to/loom
```

### Common usage

```bash
# Full orchestration — the typical entry point
/loom "Add user authentication with email/password"

# Skip phases when you don't need them
/loom --skip-brainstorm "Add logout button to navbar"
/loom --skip-specify "Use the existing spec at .claude/specs/auth/spec.md"
/loom --skip-clarify "Accept any remaining [NEEDS CLARIFICATION] markers"
/loom --skip-plan-alignment "Trivial change, no alignment check needed"

# Architecture panel — competing designers + adversarial judges at Phase 3
/loom --panel "Add a rate limiter to the public API"
/loom --panel=4 "Redesign the ingestion pipeline"   # 4 designers instead of 3

# Status / lifecycle (planned — not yet implemented; see commands/loom.md)
/loom --status                # Print current phase + wave + task statuses
/loom --complete              # Tear down state file after success
/loom --abort                 # Tear down state file on abandonment

# After a wave's implementation tasks finish
/wave-gate                    # Tests + spec-check + reviews + refutation panel + advisory triage + advance

# Standalone (no orchestration needed)
/review-pr                    # Full multi-agent review of the current diff
/review-pr code errors        # Subset of aspects
/review-pr --files src/a.ts,src/b.ts --task T3
/review-and-fix               # Review → plan → implement → commit → push
/spec-check                   # Standalone spec-alignment audit
/specify "Feature X"          # Write a spec only
/clarify                      # Resolve [NEEDS CLARIFICATION] markers
/brainstorming                # Standalone idea-to-design exploration
```

---

## How It Works

```
  Feature description
         |
         v
  +------------+   +----------+   +----------+
  | Phase 0    |-->| Phase 1  |-->| Phase 2  |
  | BRAINSTORM |   | SPECIFY  |   | CLARIFY  |
  +------------+   +----------+   +----------+
                                       |
         +-----------------------------+
         v
  +--------------+   +-----------------+   +-------------+
  | Phase 3      |-->| Phase 3.5       |-->| Phase 4     |
  | ARCHITECTURE |   | PLAN ALIGNMENT  |   | DECOMPOSE   |
  +--------------+   +-----------------+   +-------------+
         ^                  |                    |
         +--gap loop--------+                    |
                                                 v
                                       +-------------------+
                                       | Phase 5: EXECUTE  |
                                       +-------------------+
                                                 |
                                  +----+---------+---------+----+
                                  v    v                   v    v   (parallel agents per wave)
                                 T1   T2 ...              Tn
                                  |    |                   |
                                  +----+---------+---------+
                                                 |
                                                 v
                                       +-------------------+
                                       | WAVE GATE         |
                                       | test/spec/reviews |
                                       | + refute criticals|
                                       +-------------------+
                                                 |
                                                 v
                                            Next wave...
```

Each phase is executed by a specialized agent. Hooks enforce ordering, capture artifacts, and manage state transitions automatically. The state file (`.claude/state/active_task_graph.json`) is the single source of truth, write-protected at the filesystem level.

---

## Orchestration Phases

### Phase 0 — Brainstorm

| | |
|--|--|
| Agent | `brainstorm-agent` (preloads `brainstorming` skill) |
| Output | `.claude/specs/{slug}/brainstorm.md` |
| Skip with | `--skip-brainstorm` |

Explores the problem space. The agent asks clarifying questions, proposes 2–3 approaches with trade-offs, and gets user confirmation on direction before any code is written.

### Phase 1 — Specify

| | |
|--|--|
| Agent | `specify-agent` (preloads `specify` skill) |
| Output | `.claude/specs/{slug}/spec.md` |
| Skip with | `--skip-specify` |

**Interactive — full questionnaire.** Before writing, the agent runs a complete interview via `AskUserQuestion` (batched, max 4 questions per call) covering: scenario priorities, scope boundaries, measurable success criteria, P1 acceptance bars, sensitive failure modes, user-visible error states, data lifecycle, permissions, external dependencies, out-of-scope clarifications. A topic is only skipped when brainstorm already gave an explicit answer.

The spec contains:
- User scenarios (Given/When/Then)
- Functional requirements (FR-001, FR-002, …)
- Success criteria and acceptance tests
- Out-of-scope boundaries
- `[NEEDS CLARIFICATION]` markers for any unresolved ambiguity

### Phase 2 — Clarify

| | |
|--|--|
| Agent | `clarify-agent` (preloads `clarify` skill) |
| Output | Updated `spec.md` + `.claude/specs/{slug}/clarifications/log.md` |
| Trigger | More than 3 `[NEEDS CLARIFICATION]` markers (threshold in `config.ts`) |
| Skip with | `--skip-clarify` |

The agent asks structured questions to resolve each ambiguity (mostly multiple choice, max 5 questions per round), then updates the spec in place and logs decisions.

### Phase 3 — Architecture

| | |
|--|--|
| Agent | `architecture-agent` (preloads `architecture-tech-lead` skill) |
| Output | `.claude/plans/{slug}.md` |

**Two interactive checkpoints before the plan is written.**

1. **Interview — full questionnaire.** Codebase constraints, testability bar, NFR primary axis, concurrency & state model, data/persistence, sensitive boundaries, tech preferences, observability, error-handling philosophy, backwards compatibility, deployment, out-of-scope concerns.
2. **Approach gate.** The agent identifies 2–3 viable architectural approaches and presents them side-by-side via `AskUserQuestion` previews (how it works / pros / cons / testability / fit / effort). It states a recommendation, but the user picks.

The plan covers module boundaries, data models, patterns (functional core / imperative shell, DDD, Either-based errors), technology choices, and dependency graphs. The chosen approach is recorded as an `AD-N` (Architectural Decision) block.

#### Panel mode — `/loom --panel`

Opt-in upgrade to the approach gate. Instead of one agent inventing 2–3 approaches from a single perspective, panel mode runs a fan-out **only within Phase 3** (the rest of the pipeline is untouched — it still produces exactly one `plan.md`):

1. **Run boundary + interview once** — Loom creates `.claude/specs/{slug}/panel-runs/<run-id>/`; `arch-interviewer-agent` runs the full questionnaire and writes a digest there. A typed helper rejects missing, duplicate, empty, or invalid labeled fields before fan-out.
2. **N designers in parallel** — `arch-designer-agent`, each assigned a distinct **lens** (`simplicity-first`, `type-driven-fp`, `risk-security-first`, `performance-first`, `codebase-conventionist`), writes one candidate under the run directory. An exact manifest—not directory discovery—defines the candidate set.
3. **K judges in parallel** — each `arch-judge-agent` scores every manifest candidate against one interview-derived criterion. Judge JSON is schema-checked for criterion identity, exact candidate coverage, score bounds/order, and required prose; canonical sanitized verdicts stay in the run directory.
4. **Aggregate — engine, no agent.** `helper panel-contract aggregate` ranks the candidates by total score with deterministic primary-axis/testability/filename tie-breaks and writes `ranking.json`. This step is mandatory and is not an agent's judgement call: the finalizer receives the ranking as authoritative and must not recompute it.
5. **Finalize** — `architecture-agent` reads the engine's ranking, runs the mandatory 2–3 option approach gate, synthesizes the user's choice, records `### AD-1: Approach selection (panel)`, and writes the plan.

Defaults: **3 designers, 3 judges**. `--panel=N` requires an integer from 2 upward; values above 5 lenses are rejected. The panel's ranking is a recommendation—the user still picks. Panel mode stays opt-in until an A/B shows it beats single-agent plans. Plan-alignment loop-backs never re-panel; the phase gate enforces standard single-agent mode.

### Phase 3.5 — Plan Alignment

| | |
|--|--|
| Agent | `plan-alignment-agent` |
| Output | `.claude/specs/{slug}/plan-alignment.md` |
| Skip with | `--skip-plan-alignment` |

Compares the architecture plan against the spec to detect gaps — requirements the plan doesn't address. If gaps are found, the user can choose to re-run architecture with the gap report as additional context, creating a feedback loop back to Phase 3.

### Phase 4 — Decompose

| | |
|--|--|
| Agent | `decompose-agent` |
| Output | JSON task graph populated into state file |

Converts spec + plan into a concrete task graph:
- **8–12 tasks max** • **4–5 waves max** • **4–6 parallel tasks per wave**
- Each task is assigned to a specialized implementation agent
- Dependencies flow backward only (a wave depends only on prior waves)
- Each task records spec anchors (FR-XXX) it satisfies

On user approval the plugin: validates the task-graph schema, creates a GitHub Issue for tracking, and populates the state file with tasks and wave schedule.

### Phase 5 — Execute

For each wave, all tasks are spawned as parallel agents in a single message. Each implementation agent must:

1. Read the plan and its assigned task
2. Implement following project patterns (FP/DDD, ports at I/O boundaries, Either for errors)
3. Write new tests
4. **Run the tests via Bash** — mandatory; pass/fail evidence is resolved by hooks from the evidence ledger first, with transcript extraction as the labeled fallback
5. Verify all tests pass

After all wave tasks reach `implemented`, run `/wave-gate` to verify and advance.

---

## Wave Execution & Gates

`/wave-gate` runs a seven-step verification sequence after each wave's implementation completes.

| Step | What | How |
|------|------|-----|
| 1 | **State check** | Confirm `current_wave` and `impl_complete == true` |
| 2 | **Test evidence** | Verify every task has a passing `test_result` (resolved by the `update-task-status` hook — evidence ledger first, transcript fallback) and `new_tests_written == true` — both requirements are waived for tasks declaring `new_tests_required == false` |
| 3 | **Spec-check + reviews (parallel)** | Spawn `spec-check-invoker` once for the wave; spawn 5 reviewers per task in parallel |
| 3.5 | **Refutation panel** | Spawn N `review-verifier-agent`s — each with a distinct lens, each covering ALL of the wave's critical findings — and adjudicate them k-of-n |
| 4 | **GitHub comment** | Post a summary to the issue, including refuted findings (fallback: write to `.claude/reviews/wave-{N}-review.md`) |
| 4b | **Advisory triage** | Fix or explicitly defer every surviving advisory — a MUST-level constraint, not a suggestion |
| 5 | **Advance** | `complete-wave-gate` helper performs final checks and either advances or blocks |

### Review agents (per task, in parallel)

| Agent | Focus |
|---|---|
| `code-reviewer` | Style, patterns, CLAUDE.md compliance, bugs |
| `silent-failure-hunter` | Error handling, Either patterns, silent swallowing |
| `pr-test-analyzer` | Test coverage quality, property tests, gaps |
| `type-design-analyzer` | Type invariants, encapsulation, sealed types |
| `comment-analyzer` | Comment accuracy, documentation rot |

### The refutation panel (Step 3.5)

Five reviewers produce findings; without this step nothing adjudicates them, and
a plausible-but-wrong critical finding costs a real remediation cycle. The panel
fans N verifiers — each committed to **one lens** — across **all** of the wave's
critical findings and asks each to *refute* them.

Verifiers cover the whole finding set rather than one finding each: that costs N
agents instead of N×findings, gives each verifier enough context to spot
duplicate or contradictory findings, and makes a refutation verdict structurally
identical to an architecture judge's verdict, so both panels share one envelope
validator (`core/panel-kernel.ts`).

| Lens | Tries to refute |
|---|---|
| `reproduction` | the failure cannot actually be triggered |
| `intent` | the "flaw" is deliberate architecture (never-throw, fail-closed, ADTs) |
| `blast-radius` | the claimed consequence does not follow from the cause |
| `security` | the claimed security consequence does not hold |
| `test-coverage` | the missing test would not catch a real bug |

`reproduction` and `intent` are always selected. Both signals match a finding's
path **or claim text**: auth/crypto/injection pulls in `security`, and a test
path or a claim about tests pulls in `test-coverage`. Default panel size is 3.

- A finding **survives** unless a strict majority of verifiers refuted it.
  `uncertain` counts toward neither side, and **ties favor keeping the finding**
  — a false positive costs a cycle, a false negative ships a bug.
- **Only critical findings are verified.** Advisories do not block the gate, so
  refuting one saves nothing while the quota it burns is real.
- Refuted findings move into `refuted_findings` with the lenses that killed them
  and their reasoning — **recorded, not deleted**, so a wrong refutation stays
  auditable. A task whose criticals were all refuted moves `blocked → passed`;
  that is the only demotion that ADJUDICATES anything, because deciding whether
  the block stands is this panel's entire purpose. (The manual
  `store-review-findings` override and `complete-wave-gate`'s advancement also
  write `passed`; neither adjudicates a finding.)

The brief and manifest are **engine-authored** (`helper review-panel brief` /
`manifest`) rather than assembled by the orchestrator. In the wave gate the
findings already live in the task graph; in a standalone `/review-pr` or
`/review-and-fix` run, `helper standalone-review init` freezes the exact scope
and reviewer batch before spawn, then `aggregate` parses the complete transcript
set into immutable `aggregate.json`. Standalone `tally` atomically publishes
run-scoped `outcomes.json` plus authoritative `result.json` and never touches
orchestration state. In either source mode, a hand-built finding manifest cannot
quietly omit an inconvenient critical.

### Gate outcomes

- **PASSED** — Tasks marked `completed`, wave advances, GitHub issue checkboxes update.
- **BLOCKED** — One or more critical findings (in spec-check or code review) or missing evidence. Fix and re-run `/wave-gate`; on re-run only blocked tasks are re-reviewed.

The seven mandatory checks performed by the `complete-wave-gate` helper (in evaluation order):

1. Implementation proof (every task is `implemented`/`completed` with `proof.state == "satisfied"`)
2. Per-task test evidence (a passing `test_result`, except tasks declaring `new_tests_required == false`, which are exempt)
3. New tests written (`new_tests_written == true` OR `new_tests_required == false`)
4. Per-task review status (every task's `review_status` is `passed` or `blocked` — `pending`, absent, or `evidence_capture_failed` all fail the check)
5. Spec alignment (`spec_check.critical_count == 0`)
6. No critical findings in code review
7. Lifecycle machine artifacts exist on disk for every lifecycle the plan binds to this wave (a named-but-unreadable plan fails the gate, fail-closed)

---

## Slash Commands

User-invokable commands defined under `/commands/`.

| Command | Usage | Purpose |
|---|---|---|
| `/loom` | `/loom "description" [--skip-…]` | Full orchestration entry point |
| `/wave-gate` | `/wave-gate` | Test + spec + review gate after a wave finishes |
| `/review-pr` | `/review-pr [aspects] [--files …] [--task …] [--dry-run]` | Standalone multi-agent PR review |
| `/review-and-fix` | `/review-and-fix [aspects] [--no-push] [--dry-run] [--commit-msg …]` | Review → refutation panel → plan → implement → commit → push |
| `/spec-check` | `/spec-check` | Standalone drift audit against the active spec |
| `/specify` | `/specify "description" [--update] [--status]` | Write/update a formal spec (no plan, no code) |
| `/clarify` | `/clarify [spec-path]` | Resolve `[NEEDS CLARIFICATION]` markers |
| `/brainstorming` | `/brainstorming` | Standalone interactive idea-to-design session |

`/review-pr` aspect keywords: `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, `all`. The `architecture-tech-lead` agent is selected for explicit `architecture`/`all` reviews and auto-triggers for >500 additions, >10 changed files, or a new service, package, or migration.

Prompt templates for phase agents live in `/commands/templates/` (`phase-brainstorm.md`, `phase-specify.md`, `phase-clarify.md`, `phase-architecture.md`, `phase-arch-interview.md`, `phase-arch-design.md`, `phase-arch-judge.md`, `phase-arch-finalize.md`, `phase-plan-alignment.md`, `phase-decompose.md`, `impl-agent-context.md`, and `review-verify.md`). Variables like `{feature_description}`, `{spec_file_path}`, `{date_slug}` are substituted before spawning; the `validate-template-substitution` hook blocks any unresolved `{variable}` placeholder.

---

## Skills

Skills live under `/skills/<name>/SKILL.md` and are preloaded into agents via the `skills:` frontmatter field. They are also user-invocable as slash commands.

| Skill | When it triggers |
|---|---|
| `architecture-tech-lead` | Designing a feature, evaluating approaches, modelling domains, choosing patterns |
| `code-implementer` | Writing production code under FP/DDD, functional core / imperative shell, Either errors |
| `deepen` | Proactively improving existing architecture — finding shallow modules, deepening interfaces |
| `grill` | Stress-testing a plan against the project's `CONTEXT.md` (ubiquitous language, DDD model) |
| `java-test-engineer` | JUnit 5, jqwik property tests, AssertJ, Testcontainers, Spring Boot test slices |
| `ts-test-engineer` | Vitest, React Testing Library, Playwright, fast-check property tests, MSW |
| `lint-project` | Setting up or running loom's programmatic linter |
| `security-expert` | Auth (JWT, OAuth, Keycloak), authorization (RBAC/ABAC), OWASP, injection prevention, secrets |
| `nextjs-frontend-design` | Distinctive Next.js App Router + RSC + type-safe API design |
| `review-and-fix` | End-to-end PR remediation (the skill counterpart to the slash command) |

Two additional bundled skills live alongside the commands rather than in `/skills/`:
- `vercel-react-best-practices` — 57 React/Next.js performance rules from Vercel Engineering
- `nextjs-frontend-design` is exposed both ways

---

## Agents

Agents live under `/agents/<name>.md`. Each is a markdown persona with optional `skills:` preloads and a mandatory semantic `model-profile`. Every profile maps to an explicit Claude Code model and an exact Pi `openai-codex` provider/model/thinking target. Parent-model inheritance is forbidden. `helper model-profiles validate` proves the source definitions; `scripts/sync-pi-agents.sh` renders Pi-specific definitions.

### Phase agents (sequential)

| Agent | Preloaded skill | Role |
|---|---|---|
| `brainstorm-agent` | `brainstorming` | Explore intent, propose approaches |
| `specify-agent` | `specify` | Run interview, write formal spec |
| `clarify-agent` | `clarify` | Resolve spec ambiguities |
| `architecture-agent` | `architecture-tech-lead` | Interview + approach gate + design plan |
| `plan-alignment-agent` | — | Compare plan vs. spec, gap report |
| `decompose-agent` | — | Spec + plan → JSON task graph + wave schedule |

### Architecture panel agents (`--panel`, Phase 3 only)

These run only under `/loom --panel`. They are recognized by phase validation as architecture-phase work but never advance the phase — only the final `architecture-agent` does.

| Agent | Preloaded skill | Role |
|---|---|---|
| `arch-interviewer-agent` | — | Run the interview once, write the labeled interview digest |
| `arch-designer-agent` | `architecture-tech-lead` | Produce one candidate through an assigned lens (parallel, headless) |
| `arch-judge-agent` | — | Score all candidates against one interview-derived criterion, return JSON (parallel, headless) |

### Implementation agents (parallel per wave)

| Agent | Preloaded skill | Role |
|---|---|---|
| `code-implementer-agent` | `code-implementer` | Java/Spring Boot or TS/Next.js production code |
| `frontend-agent` | `nextjs-frontend-design` | React/Next.js UI components |
| `ts-test-agent` | `ts-test-engineer` | Vitest/RTL/Playwright/fast-check tests |
| `java-test-agent` | `java-test-engineer` | JUnit 5, jqwik, Testcontainers tests |
| `security-agent` | `security-expert` | Auth, JWT, OAuth, vulnerability work |
| `adr-writer-agent` | — | Expand AD seeds into full ADRs |

### Review agents (parallel per task at wave gate)

| Agent | Role |
|---|---|
| `code-reviewer` | Style, bugs, project-guideline compliance (≥80 confidence) |
| `silent-failure-hunter` | Error handling, Either patterns, silent swallowing |
| `pr-test-analyzer` | Test coverage quality (1–10 rating, 8–10 = critical gap) |
| `type-design-analyzer` | Type invariants, encapsulation (1–10 per dimension) |
| `comment-analyzer` | Comment accuracy and rot |

### Wave-gate agents that are not per-task

| Agent | Role |
|---|---|
| `code-simplifier` | Clarity and FP patterns; runs after the fixes, not per task |
| `spec-check-invoker` | Runs `/spec-check` once per wave; emits machine-readable footer |

### Review panel agent (wave gate Step 3.5)

| Agent | Role |
|---|---|
| `review-verifier-agent` | Try to refute every critical finding through one assigned lens, return JSON (parallel, headless) |

Deliberately **not** a review sub-agent: a verifier emits pure JSON that the
`review-panel` helper validates and has no findings of its own to store. Routed
through `store-reviewer-findings` it would be parsed for a `CRITICAL_COUNT` it
never emits and would mark the task `evidence_capture_failed` — a passing wave
blocked by the agent that was there to unblock it. `REVIEW_PANEL_AGENTS` is its
own frozen set, recognized by phase validation and invisible to the
SubagentStop dispatcher, with a load-time guard against collision with any
other agent set.

### Utility agents

| Agent | Role |
|---|---|
| `architecture-tech-lead` | Architectural review of large PRs (FC/IS, coupling, testability) |
| `deepen-agent` | Proactive deepening proposals, walks the design tree, updates `CONTEXT.md` |
| `grill-agent` | Aggressive design challenger against the ubiquitous language |
| `skill-content-reviewer` | Quality review of skills against domain best practices |
| `test-engineer` | Project-scoped general test engineering |

---

## Hook System

Hooks are the enforcement and automation backbone. They fire on Claude Code lifecycle events and are configured in `/hooks/hooks.json`. Every shell shim under `/hooks/scripts/` delegates to a single bun CLI: `exec bun ${LOOM_DIR}/engine/src/cli.ts <hook-type> <handler> [args]`.

### PreToolUse — validation & blocking

| Hook | Matcher | Purpose |
|---|---|---|
| `validate-phase-order` | Task | Blocks agent spawns if prerequisite phases aren't complete |
| `validate-task-execution` | Task | Validates wave ordering and task graph structure during execution |
| `validate-template-substitution` | Task | Blocks unsubstituted `{variable}` patterns in prompts |
| `validate-agent-model` | Task | Validates the agent's `model:` field |
| `validate-agent-skill` | Task | Validates the agent's `skills:` field resolves to real skills |
| `block-direct-edits` | Edit, Write, MultiEdit | Forces file changes through the Task tool (subagents) during orchestration |
| `enforce-phase-tools` | Edit, Write, MultiEdit | Guarded-skill-machine gate: denies enforced tools the bound agent's phase doesn't allow (fails closed) |
| `guard-state-file` | Bash | Deny-by-default on guarded state paths: only read-only commands (`jq`, `cat`, `grep`, …) and whitelisted helpers pass |

### PostToolUse — linting & evidence

| Hook | Matcher | Purpose |
|---|---|---|
| `lint-file` | Edit, Write, MultiEdit | Runs the **immediate-tier** linter (regex rules only, ≤50ms/file) on every modified file; programmatic rules run at the full tier (wave gate) |
| `record-evidence` | Read, Edit, Write, MultiEdit, Bash | Appends epoch-stamped facts (FileRead/FileWrite/TestRun) to the evidence ledger |

### SubagentStart — lifecycle tracking

| Hook | Matcher | Purpose |
|---|---|---|
| `mark-subagent-active` | * | Tracks active subagents in `/tmp/claude-subagents/` + binds the guarded skill machine (mints the attribution epoch) |

### SubagentStop — phase advancement & status

All SubagentStop events route through `dispatch`, which inspects agent type and delegates:

| Handler | Fires for | Purpose |
|---|---|---|
| `advance-phase` | Phase agents | Advances `current_phase`, captures artifact paths via the artifact parser |
| `update-task-status` | Implementation agents | Resolves test evidence (evidence ledger first, transcript fallback), sets `test_result` (verdict + trust provenance), `new_tests_written`, `files_modified` |
| `store-reviewer-findings` | Review agents | Parses findings into per-task `findings` (authoritative, identified) plus its `critical_findings` / `advisory_findings` derived views |
| `store-spec-check-findings` | `spec-check-invoker` | Parses `SPEC_CHECK_*` footer into `spec_check.verdict` |
| `cleanup-subagent-flag` | All | Cleans up tracking files |

### SessionStart — initialization

| Hook | Matcher | Purpose |
|---|---|---|
| `cleanup-stale-subagents` | * | Clears stale tracking files |
| `resume-after-clear` | clear | Restores execution context after `/clear` |

### Pipeline flow

```
Agent spawn requested
       |
       v
  PreToolUse: validate-phase-order → validate-task-execution → validate-template-substitution → …
       | (all pass)
       v
  Agent starts → SubagentStart: mark-subagent-active (binds machine, mints epoch)
       |
       v
  Agent executes…
       |
       | (on every Edit/Write/MultiEdit)
       +---> PreToolUse: enforce-phase-tools (machine gate) → PostToolUse: lint-file (immediate tier, ≤50ms)
       |
       | (on every Read/Edit/Write/MultiEdit/Bash)
       +---> PostToolUse: record-evidence (epoch-stamped ledger facts)
       |
       v
  Agent completes → SubagentStop: dispatch
       |
       +---> Phase agent      → advance-phase
       +---> Impl agent       → update-task-status
       +---> Review agent     → store-reviewer-findings
       +---> spec-check       → store-spec-check-findings
       +---> Always           → cleanup-subagent-flag
```

---

## Linter

Loom ships a two-tier linter that runs automatically as part of the hook pipeline.

### Tiers

| Tier | When | Rules | Budget |
|---|---|---|---|
| **Immediate** | PostToolUse on Edit/Write/MultiEdit | Regex rules only (programmatic rules run at the full tier) | ≤50ms per file |
| **Full** | At wave-gate boundaries (`lint-wave-gate` helper) | All rules including expensive structural analysis | No hard deadline |

### Rule kinds

- **Regex rules** — JSON files under `/lint-rules/` (and project overrides under `.claude/linter/rules/` or `.pi/linter/rules/`). Schema: `kind`, `name`, `description`, `extensions`, `pattern`, `flags`, `fixHint`, `enabled`.
- **Programmatic rules** — TypeScript under `engine/src/linter/programmatic/`. Shipped: `max-function-lines` (default: 50), `no-cross-boundary-imports`, `no-io-in-pure-modules`, `fugue-generated-integrity` (wave-gate tier — verifies the structural `@fugue-integrity` hash of `fugue new --from` output). Programmatic rules run in the full/wave-gate tier only, not on PostToolUse.

### Bundled regex rules

`no-any-type`, `no-console-log`, `no-field-injection`, `no-mutable-entity-fields`, `no-null-return`, `no-raw-exception-catch`, `no-star-import`, `no-system-out`, `no-todo-fixme`, `prefer-ts-pattern`.

### Safety

- Pattern analyzer detects potentially catastrophic backtracking before execution.
- Per-file deadline (50ms) enforced for regex rules.
- Binary files detected (null bytes in first 8KB) and skipped silently.
- Fails closed: any crash in the linter blocks the edit (exit 1) rather than silently passing bad code.

Run the linter manually over an arbitrary path:

```bash
bun scripts/lint-project.ts <path>
```

Or invoke via the skill: `/lint-project`.

---

## State Management

### State file

**Path:** `.claude/state/active_task_graph.json` (or `.pi/state/…` under Pi).

The state file is the single source of truth for orchestration progress. Top-level shape:

```typescript
interface TaskGraph {
  current_phase: Phase
  phase_artifacts: Partial<Record<Phase, string>>
  skipped_phases: Phase[]
  spec_dir?: string | null
  spec_file: string | null
  plan_file: string | null
  plan_title?: string
  tasks: Task[]
  current_wave?: number
  executing_tasks?: string[]
  wave_gates: Record<string, WaveGate>
  github_issue?: number
  github_repo?: string
  spec_check?: SpecCheck
  updated_at?: string
}
```

`Task` fields include `id`, `description`, `agent`, `wave`, `status`, `depends_on`, `spec_anchors`, `new_tests_required`, `plan_context`, `proof`, `test_result`, `test_evidence`, `new_tests_written`, `new_test_evidence`, `files_modified`, `file_list`, `review_status`, `review_error`, `review_evidence_failures`, `findings`, `critical_findings`, `advisory_findings`, `refuted_findings`, `start_sha`, `failure_reason`, `retry_count`.

`proof` is the engine-authored completion authority. It contains one result per
obligation: task completion, regression-test pass and new tests when tests are
required, plus every declared artifact changing. A Task is
`implemented`/`completed` iff its proof is `satisfied`; missing, failed,
untrusted, stale, or incomplete evidence keeps it pending. Pi's paired
structured tool-result evidence remains labeled `pi-structured` rather than
being laundered into ledger trust.

#### Finding identity

`findings` is the authoritative review record: each entry carries a **derived**
id (`${agent}-${ordinal}`, never agent-chosen), the emitting agent, the claim,
and — when the reviewer supplied one — a `file`/`line`.

```ts
{ id: "code-reviewer-1", agent: "code-reviewer", severity: "critical",
  file: "src/reducer.ts", line: 88, claim: "unchecked cast in the reducer" }
```

`critical_findings` and `advisory_findings` are **derived views** over it,
written alongside it, so the ~10 consumers that count and print them needed no
migration. Identity is what makes a finding adjudicable: a k-of-n refutation
vote needs items two verifiers can agree they are discussing.

Reviewers supply findings through the optional fenced ` ```findings ` JSON block
in their Machine Summary; without it the `CRITICAL:` / `ADVISORY:` marker lines
are scraped as before and the findings simply carry no location.

`refuted_findings` holds findings the wave gate's refutation panel killed,
together with the refuting lenses and their reasoning — recorded, never deleted,
so a wrong refutation stays auditable. A manual override
(`helper store-review-findings`) files what it replaces here too, under the
`manual-override` lens: an operator dismissing a false positive is making the
same kind of decision a verifier makes, and it should be as auditable.

`review_evidence_failures` names the reviewers whose transcript could not be
parsed. `review_status` is per-task but evidence capture fails per-agent, and
`/wave-gate` spawns every reviewer at once — so without the names, whichever
reviewer finished last decided the status, and a clean pass silently overwrote a
sibling's `evidence_capture_failed`. The status is
`evidence_capture_failed` exactly when this list is non-empty (proven at the load
boundary), and it clears when the reviewers named in it come back with parseable
output.

### Protection model

1. **File permissions** — `chmod 444` at rest. Only `StateManager` can write by temporarily toggling to 644.
2. **Hook guard** — `guard-state-file` is deny-by-default: a bash command referencing guarded state passes only as a read-only command (allowlisted head, no output redirect) or a whitelisted helper; substitution bodies are judged recursively.
3. **Atomic writes** — File-based mutex + tmp-file-then-rename for crash safety.
4. **Subagent isolation** — Subagents cannot edit the state file directly; only hooks running in the parent process can.

### Task status transitions

```
pending      ──▶ implemented   (agent completes AND every proof obligation is satisfied)
pending      ──▶ pending       (agent crash; executing_tasks cleared, task re-spawned by the orchestrator)
implemented  ──▶ completed     (wave gate passed)
```

### State file lifecycle

1. **Created** at `/loom` invocation (before Phase 0) with minimal fields from `phase-init.ts`.
2. **Updated** by hooks as phases advance and artifacts are captured.
3. **Populated** at Phase 4 with the full task graph after decompose.
4. **Updated** during execution as tasks progress through statuses.
5. **Removed** on `/loom --complete` or `/loom --abort`.

---

## Engine

The TypeScript engine (`/engine/`) provides the runtime for every hook and helper.

### Architecture

```
engine/src/
├── cli.ts              # Single entry point — dynamic handler dispatch
├── config.ts           # Constants (thresholds, agent maps, patterns, paths)
├── types.ts            # TaskGraph, Task, Phase, HookResult, etc.
├── state-manager.ts    # Atomic state file read/write with locking + chmod
├── phase-init.ts       # Resolve initial TaskGraph from skip flags
├── core/               # Harness-agnostic functions (reusable in Pi)
│   ├── block-direct-edits.ts
│   ├── findings.ts                 # DraftFinding/Finding ADT — derived, never agent-chosen ids
│   ├── guard-state-file.ts
│   ├── panel-kernel.ts             # Shared panel primitives: verdict envelope, criteria set
│   ├── panel-contract.ts           # Architecture panel (/loom --panel) — consumer 1
│   ├── review-panel.ts             # Refutation panel (wave gate 3.5) — consumer 2
│   ├── model-profiles.ts            # Cross-harness explicit LLM Profile policy
│   ├── proof-obligations.ts         # Task proof derivation/evaluation/parsing
│   ├── review-packet.ts             # Deterministic scoped review snapshots
│   ├── model-calibration.ts         # Historical finding matching/scoring
│   ├── panel-program.ts             # Executable architecture/refutation dispatch reducers
│   ├── tool-vocabulary.ts          # FILE_MODIFYING_TOOLS / TEST_COMMAND_PATTERNS (pure constants — sole import: machine/types)
│   ├── validate-phase-order.ts
│   ├── validate-task-execution.ts
│   └── validate-template-substitution.ts
├── machine/            # Guarded skill machine (see machines/README.md)
│   │                   # Pure core — self-linted via no-io-in-pure-modules:
│   ├── types.ts, advance.ts, parse-machine.ts, extract-evidence.ts,
│   ├── mermaid.ts, test-report.ts, evidence.ts
│   │                   # Imperative shell (fs + locks):
│   └── ledger.ts, report-discovery.ts, session-registry.ts
├── handlers/
│   ├── pre-tool-use/      # validate-phase-order, validate-task-execution, …
│   ├── post-tool-use/     # lint-file, record-evidence
│   ├── subagent-start/    # mark-subagent-active
│   ├── subagent-stop/     # dispatch, advance-phase, update-task-status, …
│   ├── session-start/     # cleanup-stale-subagents, resume-after-clear
│   └── helpers/           # complete-wave-gate, populate-task-graph,
│                          # validate-task-graph, store-review-findings,
│                          # store-spec-check, mark-tests-passed,
│                          # set-phase, cleanup-state, lint-wave-gate,
│                          # panel-run (shared run/artifact boundary),
│                          # panel-contract, review-panel, model-profiles,
│                          # review-packet, model-calibration, panel-program, …
├── parsers/            # Extract structured data from transcripts
│   ├── parse-transcript.ts
│   ├── parse-bash-test-output.ts   # Maven/Gradle/Vitest/Jest/pytest/cargo/go/dotnet/…
│   ├── parse-files-modified.ts
│   ├── parse-phase-artifacts.ts
│   └── parse-plan-models.ts        # Executable models (lifecycles, pipeline, invariants) from plan markdown
├── linter/             # Two-tier programmatic + regex linter
│   ├── loader.ts
│   ├── executor.ts
│   ├── formatter.ts
│   ├── safety.ts
│   └── programmatic/   # max-function-lines, no-cross-boundary-imports,
│                       # no-io-in-pure-modules, fugue-generated-integrity
└── utils/              # git, lock, find-file, read-transcript-with-retry, …
```

### CLI entry point

```bash
exec bun ${LOOM_DIR}/engine/src/cli.ts <hook-type> <handler-name> [extra-args...]
```

The CLI reads JSON from stdin (provided by the harness), dynamically imports the handler module, executes it, and maps the `HookResult` to an exit code:

| Result | Exit code | Meaning |
|---|---|---|
| `allow` | 0 | Tool call proceeds |
| `passthrough` | 0 | Hook doesn't apply, pass through |
| `block` | 2 | Tool call blocked (message shown to the agent) |
| `error` | 1 | Hook error (fail-closed) |

### Parsers

- **Bash test output** — pass/fail markers for Maven, Gradle, npm/Vitest/Jest, pytest, cargo, go, dotnet, and more (30+ patterns).
- **Phase artifacts** — file paths from agent transcripts mapped to the right phase.
- **Files modified** — changed file lists from git diff output.
- **Transcript** — general-purpose extraction of skill invocations and outputs.

### Tech stack

- **Runtime:** [Bun](https://bun.sh/)
- **Language:** TypeScript
- **Pattern matching:** [ts-pattern](https://github.com/gvergnaud/ts-pattern) — exhaustive matching on `HookResult`
- **Testing:** [Vitest](https://vitest.dev/) + [fast-check](https://github.com/dubzzz/fast-check)

---

## Configuration

### Key constants (`engine/src/config.ts`)

| Constant | Purpose |
|---|---|
| `CLARIFY_THRESHOLD` | Markers above this trigger mandatory clarify phase (default: 3) |
| `PHASE_ORDER` | Valid phase sequence |
| `PHASE_AGENT_MAP` | Maps each phase to the agent that runs it |
| `VALID_TRANSITIONS` | Allowed phase-to-phase transitions |
| `IMPL_AGENTS` | Implementation agents allowed during execute (incl. `code-implementer-agent`, `ts-test-agent`, `frontend-agent`, `security-agent`, `dotfiles-agent`, `adr-writer-agent`, `general-purpose`) |
| `REVIEW_SUB_AGENTS` | Review agents whose findings feed the wave gate |
| `REVIEW_AGENTS` | `REVIEW_SUB_AGENTS` + `spec-check-invoker` |
| `EXECUTE_AGENTS` | `IMPL_AGENTS` + `REVIEW_AGENTS` |
| `UTILITY_AGENTS` | `Explore`, `Plan`, `haiku` |
| `WHITELISTED_HELPERS` | Helper scripts allowed to write to the state file |
| `stateFilePatterns()` | Lazily-built regex matching guarded state files AND guarded directories (state dir, subagent dir, machine definitions) |
| `READ_ONLY_STATE_COMMANDS` | Allowlist of commands that cannot write files (`jq`, `cat`, `grep`, …) — anything else touching guarded state blocks (deny-by-default) |
| `TEST_COMMAND_PATTERNS` | 30+ patterns for recognizing test runners |
| `TASK_GRAPH_PATH` | Resolved from cwd or git root (`.claude/state/…` or `.pi/state/…`) |
| `SUBAGENT_DIR` | `/tmp/claude-subagents` |
| `HARNESS` | Detects `claude` (Claude Code) or `pi` (Pi) at runtime |

### Plan limits

| Limit | Value |
|---|---|
| Max tasks | 8–12 |
| Max waves | 4–5 |
| Max parallel per wave | 4–6 |

### Valid phase transitions

```
init            → brainstorm, specify, architecture
brainstorm      → brainstorm, specify
specify         → specify, clarify, architecture
clarify         → clarify, architecture
architecture    → architecture, plan-alignment, decompose
plan-alignment  → plan-alignment, architecture, decompose
decompose       → decompose, execute
execute         → execute
```

---

## Directory Layout

```
loom/
├── .claude-plugin/
│   └── plugin.json            # Plugin metadata
├── agents/                     # Agent personas (markdown)
├── commands/                   # User-invokable slash commands
│   ├── templates/              # Phase prompt templates
│   ├── nextjs-frontend-design/ # Bundled skill exposed as command
│   └── vercel-react-best-practices/
├── skills/                     # Reusable knowledge modules preloaded into agents
├── engine/                     # TypeScript hook engine
│   ├── src/                    # Source (cli, config, handlers, parsers, linter, core)
│   └── tests/                  # Vitest + fast-check test suite
├── hooks/
│   ├── hooks.json              # Hook configuration
│   └── scripts/                # Shell shims → bun CLI
├── lint-rules/                 # Bundled JSON regex rules
├── rules/                      # Domain rules (architecture, java/ts/rust patterns, property testing)
├── references/                 # Spec, plan, ADR templates
├── pi/                         # Pi harness extension + bridge
├── scripts/                    # lint-project.ts, sync-pi-agents.sh
├── artifacts/                  # Captured artifacts from runs (specs/tests/reviews)
├── docs/                       # ADRs, Pi usage / migration notes
├── CONTEXT.md                  # Ubiquitous language + domain model (used by /grill)
└── README.md
```

The `/rules/` directory holds domain rule files (`architecture.md`, `java-patterns.md`, `typescript-patterns.md`, `rust-patterns.md`, `property-testing.md`) that agents reference during implementation and review. `architecture.md` defines the **Ports at I/O Boundaries** rule (every real I/O collaborator gets a narrow domain-owned port).

The `/references/` directory holds templates used by phase agents: `spec-template.md`, `plan-template.md`, `adr-template.md`, a design evaluator, `panel-lenses.md` (the five design lenses for `/loom --panel`), and `review-lenses.md` (the five refutation lenses the wave gate's Step 3.5 panel judges findings through).

---

## Pi Harness

Loom's engine is harness-agnostic. The Pi package loads `pi/extension.ts`, which
adapts Pi's `tool_call` / `tool_result` events to the shared engine.

Package identity is derived from the extension module's `import.meta.url`—never
from cwd or a Claude Code cache. At `resources_discover`, Loom renders shared
commands and skills into a content-addressed Pi cache, replacing Claude's
`${CLAUDE_PLUGIN_ROOT}` token with the active package root. The agent sync script
performs the same lowering for Pi subagent definitions, inlines declared skills,
and stamps integrity metadata. Every Pi spawn byte-compares that definition with
a fresh render from the active package before execution.

- `package.json` statically registers only the extension; rendered resources are
  contributed dynamically.
- `LOOM_PLUGIN_ROOT` exposes the active root to Pi child processes for diagnostics.
- Everything in `engine/src/core/` remains harness-neutral.
- `pi/loom-bridge.ts` is legacy compatibility code; the package does not load it.

See `docs/pi-usage.md` and `docs/migration-claude-code-to-pi.md` for details.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Task stays `pending`, agent still running | Agent live (no crash; tracked via `executing_tasks`, there is no `in_progress` status) | Wait for it, or re-spawn if hung |
| `test_result` missing or not a pass | Agent didn't run tests via Bash | Re-spawn — agents MUST execute tests |
| `new_tests_written` false | Agent reused existing tests | Re-spawn — agents must write new tests |
| Wave not advancing | Gate blocked by critical findings | Fix issues, re-run `/wave-gate` |
| State write blocked | `guard-state-file` active | All writes go through hooks; reads via read-only commands (jq, cat, grep, …) are fine |
| Phase agent blocked | Prerequisite phase incomplete | Check `current_phase`; complete prerequisites |
| Template variables in prompt | `{variable}` not substituted | Hook blocks this — substitute before spawning |
| Lint failure on Edit | Linter caught a rule violation | Fix the violation; the hook is fail-closed |

### Observability

```bash
# Full state
jq '.' .claude/state/active_task_graph.json

# Per-task status
jq '.tasks[] | {id, status, test_result, new_tests_written, review_status}' \
   .claude/state/active_task_graph.json

# Current wave and gate status
jq '{wave: .current_wave, gates: .wave_gates}' .claude/state/active_task_graph.json

# Latest spec-check result
jq '.spec_check' .claude/state/active_task_graph.json
```

### Fixing blocked waves

1. **Spawn a fix agent via Task** — subagents can still Edit/Write (only the orchestrator is blocked from direct edits).
2. **Re-run `/wave-gate`** — re-reviews only the blocked tasks.
3. **Override false positives** — use whitelisted helpers to correct findings (requires user approval).
4. **Emergency** — remove the state file, fix manually, rebuild from the GitHub issue.

---

## Development

### Running tests

```bash
cd engine
bun test              # Run all tests
bun test --watch      # Watch mode
bunx tsc --noEmit     # Type checking
```

### Test coverage

The suite includes:

- **Unit tests** — every handler, parser, and utility
- **Linter tests** — executor, loader, formatter, safety analyzer, each programmatic rule, integration
- **Core tests** — pure functions, state manager, phase initialization
- **Property-based tests** — git operations, task graph validation, linter safety (fast-check)
- **E2E** — full hook pipeline sequencing

### Linting the engine itself

```bash
bun scripts/lint-project.ts engine/src
```

### Pi agent sync

```bash
bash scripts/sync-pi-agents.sh
```

---

## License

MIT
