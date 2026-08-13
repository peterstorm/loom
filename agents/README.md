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

Implementation Agents are the only TaskGraph Agent values accepted by decompose validation. Under Pi they receive Task-bound write grants; phase/panel writers receive narrower artifact grants.

## Review and quality Agents

| Agent | Role |
|---|---|
| `code-reviewer` | Correctness, project rules, maintainability |
| `silent-failure-hunter` | Error swallowing, unsafe fallbacks, Either/Result misuse |
| `pr-test-analyzer` | Test quality and regression gaps |
| `type-design-analyzer` | Invariants, illegal states, encapsulation |
| `comment-analyzer` | Comment/doc accuracy and rot |
| `architecture-tech-lead` | FC/IS, coupling, boundaries, testability |
| `code-simplifier` | Post-correctness clarity and simplification |
| `spec-check-invoker` | One Wave-level spec-alignment result |
| `review-verifier-agent` | One assigned refutation lens over every critical Finding |

`review-verifier-agent` is deliberately not a normal reviewer: it emits verdict JSON, not Findings. Routing it through Finding capture would mark valid verifier output as missing reviewer evidence.

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

## Naming and namespaces

Source policy uses bare Agent names. Claude plugin calls may expose `loom:<name>`; Pi uses generated user-global definitions. Shared parsers strip only the Loom namespace and reject arbitrary namespace substitution.

When adding an Agent, update and test:

1. source definition;
2. `AGENT_POLICIES` and the relevant role roster;
3. required-Skill policy if applicable;
4. Pi generated definition via `scripts/sync-pi-agents.sh`;
5. roster/model/Skill/resource contract tests;
6. this inventory when the user-visible role is new.
