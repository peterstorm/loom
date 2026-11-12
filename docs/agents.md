# Loom Agents

Loom owns 31 Agent definitions, one Markdown file each under `agents/`. Every definition maps to one model profile in the Agent Catalog (`AGENT_CATALOG` in `engine/src/core/model-profiles.ts`); a definition that needs domain knowledge declares a preloaded Skill in its frontmatter. The tables below are the catalog and the frontmatter read back; when they disagree with the source, the source is right.

Only Agent definitions belong in `agents/`. Claude Code registers every Markdown file in that directory as an agent, so documentation lives here instead.

Where each Agent runs: [Workflows](workflows.md). Model profiles: [Model profiles and calibration](model-profiles-and-calibration.md).

## Phase Agents

| Agent | Role | Preloaded Skill |
|---|---|---|
| `brainstorm-agent` | Explore intent and approaches | `brainstorming` |
| `specify-agent` | Write WHAT/WHY requirements after an interview | `specify` |
| `clarify-agent` | Resolve `[NEEDS CLARIFICATION]` markers | `clarify` |
| `architecture-agent` | Interview, approach gate, plan; finalizes a panel's chosen design | `architecture-tech-lead` |
| `plan-alignment-agent` | Compare the plan with the spec and report gaps | — |
| `decompose-agent` | Turn plan and spec into TaskGraph JSON | — |

Only these six advance protected phase state.

## Architecture-panel Agents

| Agent | Role | Writes |
|---|---|---|
| `arch-interviewer-agent` | Run the architecture questionnaire once and write the digest | the panel's Run Directory |
| `arch-designer-agent` | Produce one candidate through one design lens (preloads `architecture-tech-lead`) | one candidate file |
| `arch-judge-agent` | Score every candidate against one criterion | nothing; returns JSON |

They run inside the architecture phase and never advance it. The finalizer is `architecture-agent`.

## Implementation Agents

| Agent | Role | Preloaded Skill |
|---|---|---|
| `code-implementer-agent` | Java/Spring Boot or TypeScript/Next.js production code | `code-implementer` |
| `frontend-agent` | Next.js and React interfaces | `nextjs-frontend-design` |
| `ts-test-agent` | Vitest, React Testing Library, Playwright, fast-check tests | `ts-test-engineer` |
| `java-test-agent` | JUnit 5, jqwik, Spring test slices, Testcontainers tests | `java-test-engineer` |
| `security-agent` | Implementation agent for security-sensitive Tasks: authentication, authorization, JWT/OAuth, input handling, secrets | `security-expert` |
| `adr-writer-agent` | Write one Architecture Decision Record per Task | — |
| `distill-agent` | One Wave's distill pass: the `distill` skill in apply mode over the files the Wave's other Tasks implemented | `distill` |

These are the only Agents that execute a Task. Decompose assigns all of them except `distill-agent`: TaskGraph population adds at most one Distill Task per Wave and assigns that Agent itself ([ADR-0068](adr/ADR-0068-the-distill-pass-is-an-engine-added-task-per-wave.md)), and both `validate-task-graph --decompose-payload` and `populate-task-graph` refuse an authored Task that names it. On Claude Code its machine (`machines/distill-agent.machine.json`) denies Edit, Write and MultiEdit until one test run has passed. Task-graph validation accepts any catalogued name, so a graph that names a non-implementation Agent validates but never runs. On Pi, implementation Agents receive Task-bound write grants and phase or panel writers receive narrower artifact grants ([Pi write grants](pi-usage.md#pi-write-grants)).

## Review Agents

| Agent | Looks for |
|---|---|
| `code-reviewer` | Bugs and breaches of the project's written rules |
| `silent-failure-hunter` | Swallowed errors, silent fallbacks, over-broad catches |
| `pr-test-analyzer` | Behaviour the tests do not cover |
| `type-design-analyzer` | Types that fail to express or enforce their invariants |
| `comment-analyzer` | Comments and documentation that disagree with the code |
| `architecture-tech-lead` | Coupling, boundaries, testability (preloads `deepen`, review mode) |
| `code-simplifier` | Simplifications that preserve behaviour (preloads `distill`, review mode) |
| `spec-check-invoker` | One Wave-level spec-alignment result (preloads `spec-check`) |
| `review-verifier-agent` | Tries to refute every critical Finding through one assigned lens |

The first seven are the reviewers: they return Findings. `spec-check-invoker` and `review-verifier-agent` return their own result shapes; routing a verifier through Finding capture would record its valid verdict as missing reviewer evidence. All nine are issued by the engine and are not meant to be spawned by hand.

### Reviewer wire

Each reviewer starts by running the `LOOM_CONTEXT_READ_COMMAND` in its task, a read-only script that checks the Context Packet and pages its sections and files. It then returns exactly one JSON payload under the schema and impact rubric the packet carries. A request issued under the older protocol reads the archived instructions in `references/reviewer-protocol-v1/` instead and finishes under that protocol.

The text all seven reviewers share lives in `references/reviewer-wire/`: `wire-contract.md` (generated from the engine's codec), `read-coverage.md`, `bootstrap.md` and `before-you-emit.md`. `scripts/stamp-wire-contract.ts` stamps the four fragments into every reviewer file, and `--check` reports drift. Edit a fragment and re-stamp; never edit a stamped region. The same script stamps the lens sections of `references/review-lenses.md` into `review-verifier-agent`. Protocol details: [operations](standalone-review.md#reviewer-protocol-v2).

### Emission on Pi

On the qualified Pi route, a reviewer, judge or refutation verifier is issued an emission tool and returns its payload by calling it once; the final message is the fallback. Every other route, and Claude Code, uses the final message only. The engine's parser decides acceptance on both paths.

- How emission works and how the payload source is selected: [Pi adapter](pi-adapter.md#emission).
- Which routes qualify: [Model profiles and calibration](model-profiles-and-calibration.md#emission-routes-and-qualification).
- Activation conditions, readiness refusals and the retry budget: [Using Loom with Pi](pi-usage.md#emission-activation-readiness-errors-and-retry-budget).

## Security-audit Agents

| Agent | Role | Tools |
|---|---|---|
| `security-hunter-agent` | Hunt one coverage unit and return a `security-hunter-result`; a claim marked observed must rest on a sandbox receipt | Read, Glob, Grep, Bash |
| `security-verifier-agent` | Try to refute up to four claims of one verification brief and return a critical-or-advisory ballot | Read, Glob, Grep, Bash |
| `security-critic-agent` | After a wave, check the ledger's coverage claim against its recorded work and return stop-or-continue | Read, Glob, Grep |

None preloads a Skill: the `security-audit` skill is the parent session's runbook, and only the parent runs `helper security-audit` operations. The verifier and the critic sit on a different model profile from the hunter, so no verification vote comes from a hunter. See [Running a security audit](security-audit.md).

## Utility Agents

| Agent | Role | Preloaded Skill |
|---|---|---|
| `deepen-agent` | Find shallow modules and propose deepening refactors; updates `CONTEXT.md` or the context file `CONTEXT-MAP.md` lists for the term | `deepen` |
| `grill-agent` | Challenge a plan against the project's domain language and recorded decisions; updates `CONTEXT.md` or the context file `CONTEXT-MAP.md` lists for the term | `grill` |
| `skill-content-reviewer` | Review a Skill's guidance against practice in its domain | — |

## Frontmatter

An Agent declares its preloaded Skills and, when it restricts them, its tools:

```yaml
skills:
  - architecture-tech-lead
tools:
  - Read
  - Glob
  - Grep
```

- **Skills.** Claude Code checks that the Skill exists before the spawn. Pi generation inlines the Skill's content into the rendered definition. An Agent body treats a declared Skill as already loaded and does not call a Skill tool.
- **Tools.** Sources use Claude Code tool names (`Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Grep`, `Glob`), because Claude Code refuses to spawn an Agent whose `tools` it does not recognise. Pi generation lowers them to Pi built-ins ([Pi adapter](pi-adapter.md#agent-definitions)); a Pi name or any other name in a source refuses rendering, and a repository test fails on it. Omit `tools` to inherit each harness's default set.

## Names

Source policy uses bare Agent names. Claude Code registers plugin agents only as `loom:<name>`, so every Claude Code spawn of a Loom Agent uses that form: `helper orchestration brief` emits it, and `validate-task-execution` refuses a bare or foreign-namespaced Loom name before it reserves anything (`claudeAgentTypeRefusal`). Pi spawns the bare name from the generated user-level definitions. `parseAgentName` accepts the bare name or the `loom:` form and refuses any other namespace.

## Adding an Agent

1. Write the source definition under `agents/`.
2. Add it to `AGENT_CATALOG` with its kind, profile and required Skill.
3. Run `bash scripts/sync-pi-agents.sh` to render the Pi definition.
4. Run the model-profile, roster and Pi resource tests.
5. Add a row here.
