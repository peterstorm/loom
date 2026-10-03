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

### Producer emission-tool flow

On a qualified Pi route, a fresh schema-2 or schema-3 reviewer request and each
issued judge/refutation verdict kind are **emission-enabled**: the request
carries the engine-issued `LOOM_EMISSION_DESCRIPTOR`, the child registers one
exact emission tool — `loom_emit_reviewer_payload` (the issued binding selects
schema version v2 or v3), `loom_emit_judge_verdict` (v1) or
`loom_emit_refutation_verdict` (v1) — with parameters byte-identical to the
frozen payload schema for that kind/version. The rendered instructions name the
tool as the primary final action with final-message extraction as the
deterministic fallback. One call per spawn: re-emitting within the same spawn is ambiguity by
the retained duplicate policy and agents are instructed against it. Successful
execution returns a minimal terminating acknowledgment — no extra assistant
final message or follow-up model turn is required.

Emission-enabled operation additionally depends on readiness, not just
issuance: the shared `subagent` launcher must expose the `loom:subagent-launch:v2`
port under the same `PI_CODING_AGENT_DIR` as the parent — an emission-enabled
spawn without it is blocked **before dispatch**, never degraded to an ordinary
JSON-mode child — and the child must pass its request-bound readiness barrier
before any model request is delivered. Readiness refusals, their remediation
and the shared retry budget are documented in [Pi usage](../docs/pi-usage.md#emission-activation-readiness-errors-and-retry-budget).

The engine parser stays authoritative regardless of route class. On an
**unconstrained-emission** route the provider accepts the schema but does not
enforce preferred strict sampling, so tool arguments are admitted by the same
engine admission a final message would face; issuance joins, engine-derived
counts/ids and the shared request-slot attempt budget are unchanged. Selection
is deterministic: zero emission calls keep unchanged extraction; one complete,
correctly bound call with engine-valid arguments is emission regardless of
final text; exactly one engine-refused call with a usable final message selects
extraction while retaining the refusal and consumes no retry; a refused call
with unusable extraction rejects once through the existing attempt budget; two
distinct calls reject as ambiguity even when a final message is valid; a
wrong-request, wrong-kind/version, incomplete or otherwise unusable observation
refuses as a typed rejection — it is never reclassified as absence — and an
exact transport replay of one call observation is idempotent, not a second
call.

**Extraction-only** behavior is explicit, not a failure: Claude Code, archived
schema-1 reviewer requests, unsupported historical protocols, non-Pi parents
and any route other than the qualified one advertise no emission tool and keep
their final-message contract. Task text cannot upgrade extraction-only
authority; archived issued contracts are not rewritten.

Provider capability flags (strict/constrained sampling, tool-call parser
settings, served model) remain **user-side configuration**: Loom's contribution
to that configuration is documentation only. It ships the frozen schemas as its
own contract, never rewrites a schema for a provider and never configures the
provider itself (FR-022/AS-014). Route
qualification and its requalification triggers are documented in [Model
profiles and calibration](../docs/model-profiles-and-calibration.md).

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
