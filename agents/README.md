# Loom Agents

Loom owns 28 Agent definitions. Every definition maps to one semantic model profile in `engine/src/core/model-profiles.ts`; definitions that need domain knowledge declare preloaded Skills in frontmatter.

For workflow placement and exact roles, see [Workflows](../docs/workflows.md). The model/profile contract is documented in [Model profiles and calibration](../docs/model-profiles-and-calibration.md).

## Sequential phase Agents

| Agent | Role | Preloaded Skill |
|---|---|---|
| `brainstorm-agent` | Explore intent and approaches | `brainstorming` |
| `specify-agent` | Formal WHAT/WHY requirements | `specify` |
| `clarify-agent` | Resolve spec ambiguity | `clarify` |
| `architecture-agent` | Interview, approach gate, plan/finalization | `architecture-tech-lead` |
| `plan-alignment-agent` | Plan-to-spec gap analysis | — |
| `decompose-agent` | Plan/spec to validated TaskGraph JSON | — |

Only these phase Agents advance protected phase state. Architecture-panel Agents execute inside the architecture phase but never advance it.

## Architecture-panel Agents

| Agent | Role | Write policy |
|---|---|---|
| `arch-interviewer-agent` | Run one architecture questionnaire and write the validated digest | scoped panel-run writer |
| `arch-designer-agent` | Produce one candidate through one assigned design lens | scoped candidate writer |
| `arch-judge-agent` | Score every exact candidate against one criterion | read-only, pure JSON output |

The finalizer is the normal `architecture-agent`; only its completion advances the phase.

## Implementation Agents

| Agent | Role | Preloaded Skill |
|---|---|---|
| `code-implementer-agent` | Java/Spring or TypeScript/Next production implementation | `code-implementer` |
| `frontend-agent` | Next.js/React interface implementation | `nextjs-frontend-design` |
| `ts-test-agent` | TypeScript/React/E2E tests | `ts-test-engineer` |
| `java-test-agent` | JUnit/jqwik/Spring/Testcontainers tests | `java-test-engineer` |
| `test-engineer` | General project-scoped test work | — |
| `security-agent` | Authentication/authorization/application security work | `security-expert` |
| `adr-writer-agent` | Expand architecture decisions into ADRs | — |

Implementation Agents are the only TaskGraph Agent values that actually execute a task: decompose emits them, and the SubagentStop dispatch applies completion only for them. (Task-graph validation accepts any known agent name, so a graph naming a non-implementation agent as a task validates but then strands rather than running.) Under Pi they receive Task-bound write grants; phase/panel writers receive narrower artifact grants.

## Review and quality Agents

| Agent | Role |
|---|---|
| `code-reviewer` | Correctness, project rules, maintainability |
| `silent-failure-hunter` | Error swallowing, unsafe fallbacks, Either/Result misuse |
| `pr-test-analyzer` | Test quality and regression gaps |
| `type-design-analyzer` | Invariants, illegal states, encapsulation |
| `comment-analyzer` | Comment/doc accuracy and rot |
| `architecture-tech-lead` | FC/IS, coupling, boundaries, testability (preloads `deepen`, review mode) |
| `code-simplifier` | Post-correctness clarity and simplification (preloads `distill`, review mode) |
| `spec-check-invoker` | One Wave-level spec-alignment result |
| `review-verifier-agent` | One assigned refutation lens over every critical Finding |

`review-verifier-agent` is deliberately not a normal reviewer: it emits verdict JSON, not Findings. Routing it through Finding capture would mark valid verifier output as missing reviewer evidence.

### Reviewer wire

The seven reviewer shims execute the task's concrete `LOOM_CONTEXT_READ_COMMAND`
FIRST using Claude `Bash` or Pi `bash`. The read-only Bun script at the admitted
package root checks packet integrity and supplied identity, returns a section
index, and supports `--section LABEL`, `--file EXACT_SOURCE_PATH`, and bounded
`--offset N --limit 4096` text pages. Raw byte arrays/base64 are not reviewer input.
The helper grants no publication authority; engine delivery already proved issuance.
Missing command, unsafe/unavailable file, bad identity/digest or invalid page fails
visibly, never selecting a fallback protocol. Fresh schema-2
requests use its frozen `reviewer-payload-schema` and `reviewer-impact-rubric`:
exactly one JSON final payload, no Machine Summary/tallies/new IDs. Criticals
require claim plus complete basis; advisories require reason. Fields are semantic
assertions, not proof of truth, impact or execution. The same panel/majority
assesses assertions, not whether a true assertion seems worth fixing.

Genuine schema-1 requests instead read archived role and shared instructions under
`references/reviewer-protocol-v1/`; current guidance is inapplicable. Missing
archive/issuance fails visibly. Archives preserve baseline instructions, not
invented original inputs for an unfrozen historical rubric/persona. Both completed
and unfinished issued v1 reviews retain their protocol and retry bytes.

The shared fragment and all seven regions are generated from the executable
contract. Run `bun scripts/stamp-wire-contract.ts --check` to detect drift; never
hand-edit stamped schema/rubric copies. Spec-check, verifiers, designers/judges,
security-agent and skill-content-reviewer are not reviewer-wire targets.
See [protocol operations](../docs/operations.md#reviewer-protocol-v2). P4 source
review, merge, publication and loaded-runtime cutover remain pending.

## Utility/domain Agents

| Agent | Role | Preloaded Skill |
|---|---|---|
| `deepen-agent` | Find high-leverage module deepening opportunities | `deepen` |
| `grill-agent` | Challenge plans against `CONTEXT.md` language/model | `grill` |
| `skill-content-reviewer` | Review Skill/command quality against domain practice | — |

## Skill preloading

An Agent declares Skills in YAML frontmatter:

```yaml
skills:
  - architecture-tech-lead
```

Claude validates that the Skill exists before spawn. Pi generation inlines declared Skill content and stamps the rendered definition. Agent bodies should treat declared Skills as preloaded rather than trying to invoke a runtime Skill tool from a child.

## Tool restrictions

An Agent that restricts its tools declares **Claude Code tool names** — the only vocabulary Claude Code accepts (it refuses to spawn an Agent whose `tools` it cannot recognise):

```yaml
tools:
  - Read
  - Glob
  - Grep
```

Supported names: `Read`, `Write`, `Edit`, `MultiEdit`, `Bash`, `Grep`, `Glob`. Pi generation lowers them to one comma-string line of Pi built-ins (`engine/src/core/agent-tools.ts`); the example renders as `tools: read, find, ls, grep`. Pi names (`read`, `ls`, …) or any other name in a source Agent refuse rendering, and a repository conformance test fails on them. Omit `tools` to inherit each harness's default set.

## Naming and namespaces

Source policy uses bare Agent names. Claude plugin calls may expose `loom:<name>`; Pi uses generated user-global definitions. Shared parsers strip only the Loom namespace and reject arbitrary namespace substitution.

When adding an Agent, update and test:

1. source definition;
2. `AGENT_POLICIES` and the relevant role roster;
3. required-Skill policy if applicable;
4. Pi generated definition via `scripts/sync-pi-agents.sh`;
5. roster/model/Skill/resource contract tests;
6. this inventory when the user-visible role is new.
