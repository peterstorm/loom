# `/loom` prompt decomposition proposal

**Status:** design proposal; no runtime behavior has been changed.

**Verified against:** branch `feat/architecture-panel-mode-plan`, Loom `commands/loom.md` version 3.2.0, and Pi 0.83.0.

## Executive summary

`commands/loom.md` contains important information, but too much of it is loaded eagerly. At the time of this review it is 902 lines, 52,707 bytes, and 6,463 words—approximately 12,700 tokens by a simple characters-per-token estimate. Pi expands the complete file into the user message for every `/loom` invocation. Consequently, a status query, a standard non-panel plan, and a panel run all begin with the same panel protocol, Hook inventory, recovery manual, state reference, and Wave execution instructions.

The recommended change is **decomposition, not deletion**:

1. Keep `commands/loom.md` as a strict, compact dispatcher and authority boundary.
2. Move phase-specific executable instructions into package-owned runbook references loaded immediately before the relevant Phase.
3. Keep human explanation in `docs/` rather than in the runtime prompt.
4. Continue moving deterministic mechanics into the Orchestration Façade so fewer mechanics need prose at all.

A normal invocation should load only the dispatcher and the instructions for its current Phase. Panel instructions should load only for `--panel`; execution and recovery instructions should load only when reached. All current fail-closed rules, user decisions, artifact contracts, and audit requirements should remain.

## The question this proposal answers

The question is not “Can this file be shorter?” It is:

> What must the parent Agent know now, what must it know later, what belongs to deterministic code, and what exists only to help a human understand Loom?

Line count alone is not an architectural problem. `/loom` exposes a small public interface over a large lifecycle, which is the shape of a deep module. The problem is that every implementation detail behind that interface is injected into the caller's model context. The interface is small, but the implementation is not hidden.

This creates poor **locality**:

- deterministic policy exists in the engine and is narrated again in the prompt;
- operational recovery instructions are mixed into the happy path;
- conditional panel behavior is loaded for every non-panel run;
- human overview material competes with executable instructions;
- a change often requires coordinated edits to code, one large runbook, tests, and recovery prose.

The target is a deep `/loom` interface whose implementation knowledge is revealed only at the seam where it is needed.

## Current loading behavior

### Claude Code

In Claude Code, `commands/loom.md` is the package-owned `/loom` command. `${CLAUDE_PLUGIN_ROOT}` binds its paths to the package that supplied the command. The command content is operational input to the parent Agent, not merely linked documentation.

### Pi

Loom's Pi extension handles shared resources as follows:

1. `pi/extension.ts` derives the package root from its own `import.meta.url`.
2. `pi/resources.ts` recursively materializes the `skills/`, `commands/`, `references/`, and `rules/` source trees into a content-addressed cache.
3. `renderMarkdownForPi` replaces `${CLAUDE_PLUGIN_ROOT}` with the verified package root.
4. The extension contributes the rendered `commands/` directory as a Pi prompt path.
5. Pi's `expandPromptTemplate` replaces `/loom ...` with the complete template content after argument substitution.

Pi prompt templates have positional argument substitution, but no automatic Markdown include directive. A Markdown hyperlink to a panel runbook is not progressive disclosure: the model receives the link text, not the linked file.

Therefore every extracted executable reference must be loaded with an explicit tool instruction, for example:

```text
Before starting architecture panel mode, read
`{LOOM_DIR}/references/loom/panel-runbook.md` completely.
If the file cannot be read, STOP. Do not reconstruct its protocol from memory.
```

The package-root binding must remain authoritative. Extracted references must never be found by scanning the working directory, a Claude cache, or another Pi installation.

### Context and caching consequences

Provider prompt caching may reduce repeated billing or processing for a stable conversation prefix, but it does not make eager text free:

- the text still occupies model context;
- it still competes for attention with the current Phase;
- it is carried until compaction or `/clear`;
- compaction is lossy and may summarize load-bearing details;
- conditional instructions can influence a model even when their branch is inactive.

Just-in-time loading reduces both irrelevant attention and the amount of authority that compaction must preserve.

## Current size profile

The following estimates use section character count divided by four. They are comparative, not tokenizer-accurate billing figures.

| Current section | Approx. tokens | When it is needed |
|---|---:|---|
| Prerequisites | 74 | Every invocation except possibly a dedicated status extension |
| Package path and model policy | 395 | Setup and Agent spawns |
| Arguments | 606 | Invocation parsing |
| Full orchestration diagram | 678 | Human orientation, not execution |
| Brainstorm | 224 | Phase 0 only |
| Specify | 160 | Phase 1 only |
| Clarify | 223 | Phase 2 only |
| Standard architecture | 246 | Phase 3 standard mode only |
| Architecture panel | 2,525 | Phase 3 panel mode only |
| Plan alignment | 517 | Phase 3.5 only |
| Decompose | 1,091 | Phase 4 only |
| Execute | 1,185 | Phase 5 only |
| Quick-start examples | 125 | Human documentation |
| State management | 973 | Initialization plus diagnostics/recovery |
| Hook integration | 1,420 | Maintainer reference and exceptional recovery |
| Operations reference | 1,192 | Status, blocked runs, and recovery |
| Constraints | 126 | Every invocation, in compact form |
| Phase enforcement | 459 | Mostly explanatory; the engine and Hooks enforce it |
| Error recovery | 171 | Exceptional paths only |
| Plan limits | 31 | Decomposition only |
| Agent spawning summary | 77 | Dispatcher summary |

At least two-thirds of the current prompt is irrelevant at startup. A run may need some of it later, but “eventually needed” is not the same as “needed in the first turn.”

## Why the detail exists

The current runbook grew for legitimate reasons.

### It is executable prose

Some parent actions are still selected or sequenced by instructions rather than by one engine operation. Removing an instruction can remove a real step from the lifecycle.

### It protects fail-closed behavior

The runbook tells the parent to stop on malformed panel artifacts, unresolved substitutions, missing model policy, invalid task graphs, incomplete evidence, and guarded-state failures. These are not decorative warnings.

### It preserves user authority

Brainstorm approval, architecture approach selection, plan approval, advisory disposition, and teardown intent are real user decisions. They must not be hidden inside deterministic automation.

### It bridges two harnesses

Claude Code and Pi share the engine but have different resource, spawn, UI, and write-grant adapters. The prompt must not assume one harness's implicit behavior applies to the other.

### Tests bind prose to code

Important tests currently use `commands/loom.md` as the expected location of contracts:

- `engine/tests/runbook-contract.test.ts` binds panel operations and flags to handlers.
- `engine/tests/panel-config.test.ts` pins panel count literals to configuration.
- `engine/tests/panel-templates.test.ts` requires every panel template substitution variable to appear in the parent runbook.
- `engine/tests/impl-agent-skill-contract.test.ts` expects the implementation Skill substitution contract in the runbook.
- `engine/src/handlers/session-start/resume-after-clear.ts` tells a resumed parent to read Phase 5 from this file.

A decomposition must migrate these contracts deliberately. Moving text without moving its tests and recovery pointers would make the system less reliable.

## Design goals

1. **Preserve behavior.** The first decomposition should be a prompt-structure refactor, not a lifecycle redesign.
2. **Load knowledge at the latest safe point.** Read a Phase runbook immediately before taking its first action.
3. **Keep authority rooted in the active package.** Every reference path starts from the verified `LOOM_DIR`.
4. **Fail closed on missing references.** Never continue from memory or a similarly named local file.
5. **Separate executable and explanatory prose.** Runtime runbooks tell the parent what to do; `docs/` explains why and how the system fits together.
6. **Keep deterministic decisions in code.** Do not extract hand-computation recipes merely to preserve them elsewhere.
7. **Preserve cross-harness parity.** Claude Code and Pi consume the same canonical Markdown sources after adapter-specific package-root rendering.
8. **Make compaction and `/clear` safe.** Recovery context points directly to the narrow runbook for the active Phase.
9. **Measure the result.** Prompt size and conditional loading should have explicit acceptance criteria.

## Non-goals

- Removing mandatory Phases or quality gates
- Weakening Hook or engine enforcement
- Converting real user decisions into engine decisions
- Implementing Pi interactive child-question relay
- Replacing the Orchestration Façade with another workflow DSL
- Hiding operational behavior only to reduce a line-count metric
- Making linked references optional reading
- Creating separate Claude and Pi versions of the runbooks

## Proposed information architecture

```text
commands/
└── loom.md                                  compact entry dispatcher

references/
└── loom/
    ├── planning-runbook.md                  Phases 0, 1, 2, 3 standard, 3.5
    ├── panel-runbook.md                     Phase 3 --panel only
    ├── decompose-runbook.md                 Phase 4 only
    ├── execute-runbook.md                   Phase 5 only
    └── recovery-runbook.md                  exceptional operator paths

docs/
├── workflows.md                             human lifecycle overview
├── operations.md                            human operations and recovery guide
├── architecture.md                          authority and component explanation
└── loom-prompt-decomposition.md             this proposal
```

The exact number of executable references is negotiable. The important property is that each file has one reason to be loaded.

`references/loom/` is preferable to adding more top-level prompt templates:

- `pi/resources.ts` already copies `references/` recursively;
- the files do not become unrelated slash commands;
- both harnesses can resolve them from `LOOM_DIR`;
- their role as package-owned executable support material is explicit.

## The compact dispatcher contract

A reduced `commands/loom.md` should still be self-sufficient for invocation routing. It should contain the following.

### Identity and prerequisites

- Verify Bun before any engine-dependent action.
- Resolve and verify `LOOM_DIR` from the supplying package.
- Forbid cwd/cache scanning for package identity.
- State the explicit model-profile rule at the spawn seam.

### Argument parsing

- Supported start and skip flags
- `--panel` and `--panel=N` routing
- `--status` routing
- Explicit statement that `--complete` and `--abort` are not implemented flags
- Rejection of malformed or conflicting arguments

Detailed panel-count mechanics may live in the panel runbook, but the dispatcher must know enough to choose that runbook and reject obviously invalid routing.

### Initialization and location

- One active Plan/TaskGraph rule
- Initial state creation through the engine
- Initial Phase selected from skip flags
- Existing-Spec prerequisite for `--skip-specify`

### Phase router

The dispatcher should carry a compact table such as:

| Current Phase | Mandatory reference | Result |
|---|---|---|
| Brainstorm through plan alignment | `planning-runbook.md` | Spec and Plan artifacts |
| Architecture with `--panel` | `panel-runbook.md` | One selected Plan |
| Decompose | `decompose-runbook.md` | Installed TaskGraph |
| Execute | `execute-runbook.md` | Completed Waves |
| Exceptional recovery | `recovery-runbook.md` | Typed recovery or blocked result |

The instruction must say **read completely before acting**, not merely “see” or “refer to.”

### Global invariants

Keep a short set of non-negotiable invariants in the dispatcher because they apply across references:

- Phases run through their designated Agents.
- Implementation runs through attributed Agents, not parent edits.
- Protected state is written only through sanctioned engine/Hook boundaries.
- Skip flags require explicit invocation intent.
- Missing authority, model policy, runbook, or required artifact blocks.
- Real user decisions remain user decisions.
- A Wave never advances without the Wave Gate.

### Status and teardown

`--status` should remain immediately executable through the façade. Cleanup must remain an explicit guarded operation performed only after completion proof or confirmed abandonment.

## Mandatory just-in-time loading protocol

Every extracted executable reference should use one common protocol.

1. The dispatcher identifies the active Phase from parsed engine-owned state, not from conversation memory.
2. It constructs the reference path from the already verified `LOOM_DIR`.
3. It reads the complete file before the first Phase action.
4. It treats an unreadable, empty, or wrong-version file as a blocker.
5. It executes only instructions for the active Phase and selected mode.
6. On resume or `/clear`, SessionStart points directly to the active reference.
7. A reference may direct the parent to load child prompt templates, but it must not ask the parent to discover files by scanning.

A future hardening step could add a small engine/resource manifest containing reference ids and digests. That is not required for the first extraction because the package root and Pi resource tree already have integrity boundaries, but it would make “wrong runbook version” machine-checkable.

## Proposed reference responsibilities

### `planning-runbook.md`

Own:

- Phase 0 Brainstorm spawn, artifact, and approval checkpoint
- Phase 1 Specify spawn and Clarification Marker count
- Phase 2 Clarify trigger, questioning requirement, and result check
- Standard Phase 3 Architecture spawn and Plan extraction
- Phase 3.5 Plan Alignment and bounded loop-back behavior
- Exact child prompt-template substitutions for these Phases

Do not own:

- panel candidate and verdict mechanics;
- decomposition schema installation;
- Wave execution;
- generic Hook inventories.

### `panel-runbook.md`

Own everything needed only by `--panel`:

- panel argument bounds and exact defaults;
- fresh Run Directory creation;
- interactive interview and digest validation;
- design-lens selection;
- manifest authority;
- designer and judge dispatch;
- retries and fail-closed outcomes;
- deterministic aggregate invocation;
- user selection and final Plan synthesis;
- exact template substitution variables;
- standard-flow rejoin and plan-alignment loop-back semantics.

This should remain a mechanically tested executable runbook until the Orchestration Façade owns the remaining interactive/template/file integration. It should not be replaced with a short human summary prematurely.

### `decompose-runbook.md`

Own:

- decompose Agent invocation and output capture;
- TaskGraph schema validation;
- executable-model binding validation;
- routing task-graph failures back to decompose;
- routing Plan/artifact failures back to architecture;
- Spec anchor mapping;
- user approval;
- GitHub Issue creation;
- protected TaskGraph population;
- task and Wave limits;
- planning context checkpoint.

### `execute-runbook.md`

Own:

- pending Task selection by current Wave;
- exact parallel implementation spawn behavior;
- implementation prompt substitution, rules, model, and Skill binding;
- crash/re-spawn behavior;
- mandatory `/wave-gate` invocation;
- critical remediation and advisory disposition;
- advancement and completion behavior.

It should delegate Wave-Gate internals to `commands/wave-gate.md`, which is already a smaller façade-oriented runbook.

### `recovery-runbook.md`

Own exceptional operator procedures:

- unreadable/corrupt TaskGraph recovery;
- stale Agent cleanup expectations;
- blocked Wave diagnosis;
- sanctioned false-positive override boundaries;
- emergency cleanup;
- raw-state inspection caveats;
- common failure symptoms and typed next actions.

Normal happy-path execution should not load this file.

## Detailed migration map

| Current `commands/loom.md` material | Destination | Treatment |
|---|---|---|
| Prerequisite and package-root binding | Dispatcher | Keep, tighten |
| Model-profile contract | Dispatcher plus spawn references | Keep global invariant; put per-spawn mechanics with the spawn |
| Argument list | Dispatcher | Keep |
| Full flow diagram | `docs/workflows.md` | Remove from runtime prompt; retain a compact Phase table |
| Brainstorm, Specify, Clarify | `planning-runbook.md` | Move intact first, then remove duplication |
| Standard Architecture | `planning-runbook.md` | Move |
| Architecture panel Steps 0–5 | `panel-runbook.md` | Move as one mechanically tested unit |
| Plan Alignment | `planning-runbook.md` | Move |
| Decompose Steps 4a–4e | `decompose-runbook.md` | Move as one unit |
| Execute and implementation substitutions | `execute-runbook.md` | Move as one unit |
| Quick-start examples | Root README and `docs/workflows.md` | Human docs only |
| Initial State creation | Dispatcher | Keep concise executable command |
| Full state shape and Hook timeline | `docs/architecture.md` / `docs/operations.md` | Human explanation |
| Status invocation | Dispatcher | Keep exact façade command |
| Status sample output | `docs/operations.md` | Remove from runtime prompt unless diagnostically requested |
| Hook inventory | `docs/architecture.md` / `docs/operations.md` | Remove from happy path |
| Sanctioned helper taxonomy | Relevant executable references | Place each helper beside the only step allowed to invoke it |
| Observability and raw `jq` | `recovery-runbook.md` and `docs/operations.md` | Load only for diagnosis |
| Blocked-Wave fixes | `recovery-runbook.md` | Conditional |
| Advisory classification | `execute-runbook.md` or Wave-Gate action | Keep executable, remove duplicate explanation |
| Global constraints | Dispatcher | Keep compactly |
| Phase-enforcement tables | `docs/architecture.md` | Hooks already enforce; references state only required pre/postconditions |
| Error recovery table | `recovery-runbook.md` | Conditional |
| Task/Wave limits | `decompose-runbook.md` | Phase-local |
| Agent-spawning summary | Dispatcher | Keep as a short invariant |

## Source-of-truth rules after decomposition

The existing documentation precedence remains valid:

1. Parsed types, reducers, validators, and policy catalogs
2. Orchestration Façade and adapters
3. Executable command and runbook references
4. Explanatory documentation
5. Historical artifacts

Extraction must not create a second authority. In particular:

- The dispatcher owns routing, not panel mechanics.
- The panel runbook owns the parent-facing panel procedure, not panel constants or score arithmetic.
- Engine configuration owns numeric policy.
- The engine owns ranking, roster completeness, state transitions, and evidence validation.
- Child prompt templates own child behavior, while the parent runbook owns exact substitution and spawn timing.
- Human docs may summarize but must link to executable sources.

Where possible, tests should derive expected vocabulary and flags from code rather than duplicating lists in a new file.

## Test and contract migration

A safe refactor requires tests before deleting text from the main command.

### Runbook contract tests

`engine/tests/runbook-contract.test.ts` should read the executable file that actually owns each helper chain. For panel operations and flags, that becomes `references/loom/panel-runbook.md`.

Tests should continue to prove both directions:

- every handler operation/flag is documented;
- the runbook invokes no unknown operation/flag;
- operations appear in dependency order.

Do not concatenate every reference and assert that a token appears “somewhere.” That would allow a Phase contract to drift into the wrong file and still pass.

### Configuration literals

`engine/tests/panel-config.test.ts` currently pins concrete counts in `commands/loom.md`. Move those assertions to `panel-runbook.md`, or preferably have the panel entry operation emit validated policy so fewer volatile numbers require prose.

The dispatcher still needs enough information to route `--panel`; it does not necessarily need every concrete count.

### Template substitution tests

`engine/tests/panel-templates.test.ts` should require panel substitution variables in `panel-runbook.md`. Planning and implementation templates should have analogous ownership assertions against their respective runbooks.

This preserves the load-bearing guarantee that the parent knows how to replace every child placeholder.

### Implementation Skill contract

`engine/tests/impl-agent-skill-contract.test.ts` should read `execute-runbook.md` for `{required_skill}` and rules substitution. The invariant remains unchanged.

### Resume-after-clear

`engine/src/handlers/session-start/resume-after-clear.ts` should stop telling the parent to read “Phase 5 in `commands/loom.md`.” It should point directly to `references/loom/execute-runbook.md` and include the current Wave from protected state.

Tests under `engine/tests/handlers/session-start/` must pin that exact package-rooted reference.

### Pi resource portability

Resource tests should prove that:

- the new `references/loom/` files are included in the rendered resource tree;
- `${CLAUDE_PLUGIN_ROOT}` does not survive Pi rendering;
- paths work for roots containing supported punctuation;
- a stale or corrupt cache cannot substitute a different runbook;
- prompt discovery remains non-recursive and the references do not become slash commands.

### Behavioral regression

The normal test and smoke suites must prove unchanged behavior for:

- standard full flow;
- every skip-flag combination;
- panel sizes and invalid panel arguments;
- panel artifact/retry failures;
- plan-alignment loop-back;
- task-graph validation routing;
- `/clear` recovery into execution;
- blocked and passing Wave Gates;
- cleanup intent.

## Stale-resource behavior

A Pi session discovers prompt resources at startup or `/reload`. Updating the package on disk does not rewrite an already-expanded `/loom` message in session history. That historical message remains what the model saw at invocation time.

After a Loom update:

1. run Pi's `/reload`;
2. invoke `/loom` again for the new template;
3. do not assume an old expanded command changed retroactively.

The pasted prompt that motivated this review contained older statements about `PostEdit`, model inheritance, and planned `--complete`/`--abort` flags even though current source had corrected them. That is consistent with a prompt loaded before resource reload. Decomposition does not eliminate resource versioning, but smaller dispatchers reduce the amount of stale operational detail embedded in one historical message.

A future optional improvement is to include the Loom command version and resource digest in the dispatcher and in every executable reference, then fail if they disagree.

## Risks and mitigations

### Risk: the Agent follows the link but does not read the file

**Mitigation:** use mandatory tool language, exact package-rooted paths, and “STOP if unreadable.” Test that every dispatcher branch names its required reference.

### Risk: instructions are fragmented and a cross-cutting invariant disappears

**Mitigation:** keep a deliberately small global-invariant section in the dispatcher. Put Phase-specific invariants in exactly one executable reference.

### Risk: a reference is loaded too late

**Mitigation:** require the read before the first action of the Phase, not after an error occurs.

### Risk: references drift from engine operations

**Mitigation:** migrate bidirectional runbook-contract tests to the owning reference. Derive expectations from code.

### Risk: references become accidental Pi slash commands

**Mitigation:** keep them under `references/loom/`, while Pi contributes only the rendered `commands/` directory as a prompt path.

### Risk: extraction preserves manual deterministic recipes forever

**Mitigation:** treat the references as an intermediate boundary. Track which instructions can be replaced by one façade action and shrink them over time.

### Risk: more file reads increase latency

**Mitigation:** the reads are local, Phase-scoped, and small relative to Agent/model calls. Avoid loading the recovery or panel references when their branches are inactive.

### Risk: full runs eventually load nearly all references anyway

**Mitigation:** conditional branches still disappear, and `/clear` after decomposition intentionally sheds planning context before execution. Just-in-time loading improves temporal locality even when cumulative bytes are similar.

### Risk: general docs are mistaken for executable authority

**Mitigation:** executable references use “runbook” in their names and carry status/version headers. `docs/` continues to say that engine and runbook sources outrank explanatory prose.

## Alternatives considered

### Leave the command unchanged

**Advantages:** all instructions are present; no missing-reference risk; current tests remain simple.

**Disadvantages:** approximately 12,700 eager tokens; conditional branches and recovery instructions pollute every invocation; high drift surface; poor compaction locality.

This remains safe but increasingly expensive as Loom grows.

### Delete explanatory sections only

This is the lowest-risk first step and should be part of implementation. It cannot address the largest conditional section—the panel protocol—or late Phase instructions.

### Convert `/loom` entirely into a Pi Skill

Pi Skills support progressive disclosure of Skill descriptions, but invoking `/skill:loom` loads the full `SKILL.md`. A monolithic Skill would reproduce the same problem. A compact Skill dispatcher plus references could work, but converting the public command is unnecessary and would complicate Claude/Pi parity.

### One reference containing everything

Moving 900 lines from one file to another but always reading that file changes nothing. Progressive disclosure requires references aligned to actual routing conditions.

### Rely only on general documentation

Rejected. Human docs are not exact enough to serve as executable runbooks, and plain links are not automatically loaded.

### Move the entire lifecycle into code immediately

This is the strongest long-term direction but a larger behavioral change. Some work remains inherently semantic or interactive: Agent output, user checkpoints, and Pi's unresolved interactive-child relay. Prompt decomposition can improve locality before complete façade ownership is possible.

## Implementation sequence

### Phase 1: Freeze behavior and measurements

- Record current command size and section inventory.
- Add tests for dispatcher-to-reference routing before moving prose.
- Identify every test/source path that reads `commands/loom.md`.
- Define version headers for executable references.

### Phase 2: Remove human-only duplication

- Replace the full diagram with a compact Phase table.
- Move quick-start examples and explanatory Hook/state tables to existing docs.
- Keep all executable commands and invariants unchanged.
- Measure the first size reduction.

### Phase 3: Extract conditional and late runbooks

Recommended order:

1. `recovery-runbook.md`
2. `panel-runbook.md`
3. `execute-runbook.md`
4. `decompose-runbook.md`
5. `planning-runbook.md`

Recovery is least likely to affect a normal path. Panel provides the largest conditional win. Execute has a strong `/clear` seam. Planning is loaded earliest and therefore yields the smallest initial benefit, so it can move last.

For each extraction:

- create the reference;
- add a mandatory read in the dispatcher;
- migrate owning tests;
- update recovery pointers;
- run cross-harness resource tests;
- only then remove the old section.

### Phase 4: Deepen the Orchestration Façade

Review every remaining imperative recipe and ask:

- Is this a deterministic calculation?
- Does the engine already have the necessary authority?
- Can the façade return one typed next action instead?
- Is the parent doing arithmetic, roster construction, path discovery, retry counting, or state derivation?

If yes, move it behind the façade rather than polishing its prose.

### Phase 5: Validate in both harnesses

- Run standard and panel flows in Claude Code.
- Run non-interactive supported flows in Pi.
- Verify mandatory references resolve from the active package root.
- Verify `/reload` picks up changed resources.
- Verify `/clear` resumes directly into the narrow execution runbook.
- Record actual prompt token counts with the target models' tokenizers if available.

## Acceptance criteria

A successful decomposition should satisfy all of the following.

### Context efficiency

- `commands/loom.md` is no more than roughly 3,000–4,000 estimated tokens, or another explicitly justified budget.
- A non-panel invocation does not include panel protocol details.
- A status invocation does not include Phase 4/5 or recovery manuals.
- Recovery instructions are absent from a healthy happy path.

### Behavioral parity

- Every currently supported argument behaves identically.
- Every malformed/unsupported argument still fails closed.
- Phase order, artifacts, user gates, retries, and Wave Gates are unchanged.
- No new implicit model, Skill, state-write, or package-root fallback exists.

### Authority and recovery

- Every executable reference is resolved from verified `LOOM_DIR`.
- Missing or unreadable references block.
- `/clear` recovery names the active Phase reference directly.
- Current state, not conversation memory, chooses the resumed runbook.

### Testability

- Bidirectional operation/flag contract tests target the owning runbook.
- Template substitution ownership remains mechanically checked.
- Pi resource rendering and portability tests cover the new tree.
- Full unit and smoke suites pass.
- No test succeeds merely because a required token appears in an unrelated concatenated document.

### Documentation integrity

- `docs/` clearly distinguishes shipped behavior from this proposal.
- Runtime runbooks identify themselves as executable and versioned.
- Human docs link to runbooks without duplicating volatile mechanics.
- No stale `PostEdit`, lifecycle-flag, or implicit-model claim is reintroduced.

## Long-term target

The ideal parent interaction is not a shorter hand-written workflow. It is:

```text
1. Resolve the active Loom package.
2. Ask the Orchestration Façade for status/next action.
3. If the action is spawn-batch, execute the exact authorized requests.
4. If the action is await-user, present the exact real decision.
5. If blocked, report the typed reasons and load recovery guidance only on request.
6. Resume until done.
```

In that target, code owns identity, ordering, retries, manifests, rosters, validation, state transitions, and publication. Agents own semantic work. Users own genuine choices. The `/loom` prompt owns only dispatch, explanation at the current seam, and refusal to invent authority.

Prompt decomposition is the practical step between today's comprehensive executable prose and that deeper façade-owned design.
