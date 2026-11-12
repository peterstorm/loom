# Loom workflows

Loom supports one full feature-delivery lifecycle and several standalone quality workflows. They share Agents, policy, parsers, and review machinery, but not all of them use the protected TaskGraph.

## Capability map

| Workflow | Entry point | Protected TaskGraph | Run Directory | Main result |
|---|---|---:|---:|---|
| Full feature delivery | `/loom` | Yes | Panels/Wave Gates only | Implemented, reviewed Waves |
| Architecture panel | `/loom --panel[=N]` | Phase state | Yes | One user-selected architecture plan |
| Plan design review | inside `/loom`, before decompose | Records the acceptance | Yes | The plan accepted for its exact bytes, or Findings to fix |
| Wave quality gate | `/wave-gate` | Yes | Yes | Advance, await decision, or block |
| Standalone review | `/review-pr` | No | Yes | Adjudicated `result.json` |
| Review and remediation | `/review-and-fix` | No feature graph | Review + remediation runs | Verified Git index, commit, optional push |
| Security audit | `/security-audit` | No | Yes | Verified findings and a coverage-accounted report |
| Spec alignment | `/spec-check` | Reads active context when present | No standalone program | Per-requirement drift findings |
| Requirements only | `/specify`, `/clarify`, `/brainstorming` | Only when invoked by `/loom` | No | Requirements/design artifact |
| Project lint | `/lint-project` or script | No | No | Regex + structural violations |

Two terms recur. The **TaskGraph** (the State File) is the protected record of one feature run: its phase, Tasks, Waves and evidence. A **Run Directory** is the immutable folder one review, panel, gate or remediation writes its evidence into. Both are described in [Architecture](architecture.md#two-persistence-domains).

## Full `/loom` lifecycle

```text
brainstorm → specify → clarify? → architecture → plan alignment → plan design review → decompose
                                                                                           |
                                                                                           v
                                                                           Wave 1 implementation Tasks
                                                                                           |
                                                                                      Wave Gate
                                                                                           |
                                                                           Wave 2 ... → final Wave
```

The initial TaskGraph is created before the first phase, which activates the ordering, direct-edit, state, model, Skill and prompt guards.

### Phase 0: brainstorm

`brainstorm-agent` explores intent, constraints, alternatives, and scope. It writes:

```text
.claude/specs/<date-slug>/brainstorm.md
```

Skip only with `--skip-brainstorm` when the problem and approach are already understood.

### Phase 1: specify

`specify-agent` turns the feature into WHAT/WHY requirements:

- prioritized user scenarios;
- `FR-NNN` functional requirements;
- measurable success criteria;
- non-functional constraints;
- out-of-scope boundaries;
- `[NEEDS CLARIFICATION]` markers.

It writes `.claude/specs/<date-slug>/spec.md`. `--skip-specify` also skips brainstorm and clarify and requires an existing spec.

### Phase 2: clarify

More than `CLARIFY_THRESHOLD` (currently 3) unresolved markers makes clarify mandatory unless the user explicitly passes `--skip-clarify`. `clarify-agent` updates the spec and records the dialogue under the spec directory.

### Phase 3: architecture

Standard mode uses `architecture-agent`:

1. read the spec and codebase;
2. run the architecture questionnaire;
3. present 2–3 approaches with trade-offs;
4. let the user choose;
5. write `.claude/plans/<date-slug>.md`.

The plan defines boundaries, data flow, file structure, decisions, implementation phases, testing, and—only when genuinely present—executable lifecycles, pipelines, or checkable invariants. See [Executable Models](../references/executable-models.md).

#### Architecture panel mode

`/loom --panel` replaces only Phase 3’s approach generation. Default size is three designers; `--panel=N` accepts 2–5 because every designer must have a distinct design lens.

1. **Interview once.** `arch-interviewer-agent` writes a labeled digest. The panel contract rejects missing, duplicate, empty, or invalid fields.
2. **Select distinct design lenses.** `simplicity-first` and `type-driven-fp` are baseline; sensitive boundaries, performance priority, and brownfield maturity influence additional lenses.
3. **Design in parallel.** One `arch-designer-agent` writes one manifest-bound candidate per lens.
4. **Judge in parallel.** Three `arch-judge-agent` requests each score every candidate against one criterion: the interview’s primary axis, its testability bar, and codebase fit plus effort.
5. **Aggregate in code.** Verdicts must cover the exact candidate set. Ranking uses total, then ordered criterion scores, then lexical candidate filename.
6. **Choose and finalize.** Ranking is a recommendation. The user still chooses; `architecture-agent` may graft compatible strongest ideas and records `AD-1: Approach selection (panel)`.

Candidates, verdicts, ranking, and authority stay in a fresh run beneath the spec directory. A plan-alignment loop-back uses standard single-Agent architecture, not a second panel.

On Pi, the interviewer and the other roles that question the user run through `loom_interactive_subagent`; see [Using Loom with Pi](pi-usage.md#interactive-phase-agents).

### Phase 3.5: plan alignment

`plan-alignment-agent` maps the plan back to every requirement and writes:

```text
.claude/specs/<date-slug>/plan-alignment.md
```

If gaps remain, the user either loops back to architecture with the report or explicitly proceeds. Skip with `--skip-plan-alignment` only when that check is intentionally unnecessary.

### Phase 3.6: plan design review

Before decompose, the plan's design is reviewed by `code-reviewer`, `type-design-analyzer` and `architecture-tech-lead` as a Standalone Review of kind `plan-design` whose only file is the plan. `helper accept-plan-design-review` then records the acceptance in the State File, bound to the plan's SHA-256. A critical that survives refutation is resolved by editing the plan and reviewing it again; advisories need a published disposition. Any edit to the plan after acceptance blocks the decompose spawn until a fresh review is accepted.

It is a gate, not a phase: `current_phase` does not change. Skip it with `--skip-plan-design-review`. The exact commands are in the [plan design review runbook](../references/loom/plan-design-review-runbook.md); the rules are in [ADR-0070](adr/ADR-0070-the-plan-design-review-gates-decompose.md).

### Phase 4: decompose

`decompose-agent` emits JSON. Before state changes, the engine validates:

- known implementation Agents;
- unique Task ids and valid dependencies;
- Wave order and bounded parallelism;
- declared files and test policy;
- spec anchors;
- executable lifecycle/pipeline/invariant bindings from the plan.

The user approves the Tasks and Waves. Loom opens a GitHub Issue and `populate-task-graph` installs the graph and moves the phase to `execute` in one write. Nothing else can enter `execute`. A decompose agent with no usable output, or a plan rejected at approval, leaves the run in `decompose`, ready for a re-spawn.

Typical guidance is 8–12 Tasks, 4–5 Waves, and 4–6 parallel Tasks per Wave. These are planning bounds, not a license to force a small feature into needless Tasks.

### Verification manifest

A project may declare the commands every Wave must pass (build, typecheck, tests) in `.loom/verification-manifest.json`. The file is the operator's, not the decompose agent's: it is installed before population through `helper write-verification-manifest`, population freezes it into the TaskGraph, and with no manifest the Wave Gate runs only the engine's own checks, such as full-tier lint.

Status and the Wave Gate report which project checks are configured as `projectVerificationCoverage`. "Configured" does not mean "passed": a configured check must still produce accepted evidence at the gate.

[Verification](verification.md#the-verification-manifest) has the keys, the [executable allowlist and argv policy](verification.md#command-policy), [installation](verification.md#installing-the-manifest) and [enrolling a critical-repair check](verification.md#enrolling-a-critical-repair-check).

### Phase 5: execute

For each Wave, the orchestrator spawns all dependency-ready implementation Tasks in parallel. The selected Agent receives a complete prompt with:

- Task/Wave identity and dependencies;
- required Skill;
- exact spec anchors and plan context;
- declared file list;
- architecture and stack-specific rules;
- test and proof contract.

Direct parent edits are blocked while an orchestration is active. Implementation happens through Agents so completion, files, test evidence, and proof can be attributed.

A Wave with implementation files also carries one engine-added Distill Task (`distill-agent`, [ADR-0068](adr/ADR-0068-the-distill-pass-is-an-engine-added-task-per-wave.md)). Status offers its dispatch only after every other Task of the Wave has settled, and the Wave Gate starts after it settles. See [The distill pass](verification.md#the-distill-pass-distill-task).

**Completion.** A Task reaches `implemented` only when its proof obligations are satisfied and its attempt wrote only files the Task owns. The engine issues each attempt its own authority, so completion prose, a guessed Task id or a late result from an earlier attempt cannot complete a Task. The engine runs no project commands while a Wave's Tasks are still writing: Agents run their Task's tests themselves, and whole-project build, typecheck and test commands run once, at the Wave Gate.

**Retry.** A failed attempt gets one retry. Status publishes the retry's exact context, naming what the first attempt failed, and the spawn gate accepts only those bytes. A second failure is a terminal escalation that an operator must resolve; there is no third attempt. A failure of the infrastructure (an unreadable baseline, a Git error) does not consume the retry. Recovery commands: [operations](reference/recovery.md#implementation-escalation-semantic-attempt-2-exhausted). The attempt and settlement rules: [Implementation attempts and settlement](verification.md#implementation-attempts-and-settlement).

## Task proof obligations

The engine derives proof from declared requirements and observed evidence. Depending on Task policy, obligations include:

- Agent completion;
- a passing regression test result;
- newly written tests, written test-first: a failing run before the first implementation write, then a passing one;
- every declared artifact changed, with engine-written skeleton bytes subtracted, and, where completion conformance is owed, conforming to the frozen contract (a violation fails as `declared-artifact-contract-violated` before the changed test runs).

Evidence retains provenance:

- report-backed ledger evidence can produce `trusted-pass`/`trusted-fail`;
- Pi’s paired structured result remains `pi-structured`;
- transcript fallback is explicitly untrusted/degraded;
- a pass invalidated by later writes does not remain a pass.

A Task carries an explicit `verification_policy` with independent `regression` and `new_tests` requirements. Each arm is either `required` or `waived` with a typed reason. For example, `existing-tests-sufficient` waives new-test creation while retaining regression execution; `documentation-only` may waive both. Neither policy waives declared-artifact proof or review. How evidence is recorded and trusted: [Guarded Skill Machines](../machines/README.md#the-evidence-ledger).

## Wave Gate

`/wave-gate` starts a fresh registered Wave Gate program. The engine, not the parent model, owns readiness checks, Review Packet publication, reviewer/model/Skill selection, retries, aggregation, refutation routing, advisory suspension, full-tier lint, and protected Wave advancement.

The parent executes only the returned action and resumes the same run.

### Review stage

For every Wave Task except the Wave's Distill Task, which is exempt from review, Loom creates an immutable Review Packet and issues the exact reviewer roster:

- `code-reviewer`;
- `silent-failure-hunter`;
- `pr-test-analyzer`;
- `type-design-analyzer`;
- `comment-analyzer`;
- `architecture-tech-lead`, appended last, only for a Task that touches an owned Invariant's family (ADR-0047) or writes an Acceptance Contract's types file (ADR-0069).

`spec-check-invoker` runs once for the Wave. Each reviewer returns exactly one JSON payload under the schema and rubric its packet carries; the engine derives counts and Finding ids. A critical must state its full basis and an advisory its reason. Structure is not proof of truth or impact. Malformed output is recorded as failed evidence, never as a Finding. See [protocol operations](standalone-review.md#reviewer-protocol-v2).

### Remediation-aware reviews

Implementation changes increment `review_generation`. A new Review Run snapshots prior active Finding ids. Every expected reviewer must assess each prior Finding exactly once:

- it retires into `resolved_findings` when the reviewer role that raised it (its owner) assesses `resolved_by_remediation` and no other reviewer's `still_present` cites concrete counter-evidence — a `file.ext:line` reference in the reason;
- the owner's own `still_present`, or a dissent with such a reference, keeps it active; a bare "not re-verified" or a file name without a line does not;
- a Finding whose owner is not on the roster (recovered view claims, operator overrides) still needs `resolved_by_remediation` from the complete roster;
- new Findings become active only at atomic finalization.

This prevents a clean rerun from silently erasing an old blocker by omission.

### Refutation panel

If critical Findings exist, Loom selects refutation lenses and issues one `review-verifier-agent` per lens. Every verifier covers the complete critical set.

Baseline lenses are `reproduction` and `intent`; signals can add `blast-radius`, `security`, or `test-coverage`. The default panel size is three.

A strict majority must refute a Finding. `uncertain` is neutral and ties keep the Finding. Refuted Findings move to `refuted_findings` with all reasoning; they are never deleted.

Only criticals are refuted; advisories are the user's decision, not verifier work. The panel judges whether the assertion holds, including its preconditions, contract and consequence. A true assertion is not refuted because fixing it seems unimportant, and a surviving critical blocks. There is no severity downgrade. The explicit operator override is separate and is never an automatic fallback for malformed reviewer evidence.

### Advisory decision

A Wave with surviving advisories reaches `await-user`. The user records a disposition and reason. The lifecycle has one “decision accepted” transition; fixed/deferred/dismissed meaning remains in the decision payload.

### Completion suite, full lint, and completion

After every implementation Agent of the Wave has stopped and Task proof passes, the Wave Gate runs the frozen completion suite against the integrated workspace: the project's manifest checks, full-tier lint (`loom:full-tier-lint`), and owner verification where the plan declares owned Invariants. Exit code, timeout, signal, spawn failure and report production are recorded as separate facts. A missing, duplicate, stale, malformed or conflicting result fails closed, and an infrastructure failure stays distinct from a failing check.

The exact result is published immutably in the Wave's Run Directory and, when accepted, bound into protected state together with the workspace digest. Resume reuses that receipt; it never reruns commands over evidence it cannot tell apart. `/loom --status` reports accepted, stale, rejected, pending or unavailable suite authority without executing anything.

The final protected-state commit re-observes the workspace and checks implementation proof, completion-suite authority, reviews, spec alignment, surviving criticals, and required lifecycle artifacts. Success marks Tasks completed and advances the Wave; otherwise a typed diagnostic explains the block.

### Exhausted reviewer restart

A semantic result receives at most one retry. If Wave reviewer attempt 2 is durably rejected, `/wave-gate` can invoke the registered `restart` operation with a fresh replacement Run Directory. The engine preserves accepted findings and audit evidence, retires stale authority, and issues a fresh packet/epoch. Historical transcripts are not copied or edited.

## Standalone `/review-pr`

A standalone review does not invent a synthetic Task or mutate the feature TaskGraph.

The registered Standalone Review Program:

1. freezes explicit files or the canonical union of committed branch changes, staged changes, unstaged tracked changes, and untracked non-ignored files;
2. excludes Loom state/review evidence layouts;
3. computes metadata and deterministically selects reviewers for the requested aspects;
4. publishes Context Packets and exact spawn requests;
5. captures the complete transcript roster unchanged;
6. aggregates identified Findings;
7. runs the registered refutation panel when criticals exist;
8. publishes authoritative `result.json` at the Run Directory root.

The result separates `surviving_critical_findings`, `advisory_findings`, and `refuted_critical_findings`. A missing roster member or invalid panel result blocks publication. For counts, use `helper orchestration inspect --runs-root <root> --run <run>`, which renders them from the published result; do not compute them by hand.

Review aspects are `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, and `all` (default):

- `simplify` runs `code-simplifier` (the `distill` skill in review mode). Under `all` it joins whenever the scope changes source or test files.
- `architecture` runs `architecture-tech-lead` (the `deepen` skill in review mode). Under `all` it always joins, and it is selected automatically for more than 500 additions, more than 10 files, or new structure.

A later review of the same work can be started as an explicit successor of an earlier one, which keeps the earlier Findings and their history ([operations](standalone-review.md#standalone-lineage)).

## `/review-and-fix`

This workflow composes two registered programs around semantic remediation:

1. **Standalone review and adjudication.** Produce authoritative review `result.json`.
2. **Plan and account.** Copy every surviving-critical Finding ID exactly once into a disposition. Repaired dispositions point to separately named Declared Repair Groups; unresolved and out-of-scope dispositions are allowed but block installation. Advisories are dispositioned as accepted, deferred or dismissed outside the critical groups, and refuted criticals are kept for audit without being repaired.
3. **Implement and validate.** Fix only repaired criticals and accepted advisories, declare root cause, invariant, sibling accounting and the historical failing state, and run real development checks. `--dry-run` stops before implementation.
4. **Registered remediation.** The engine authenticates the source review, selects the operator's fixed report-producing checks for critical repairs, observes them on the repaired state, binds the observations to the unchanged candidate bytes, audits paths, and installs exactly the verified set into the Git index.
5. **Commit/push.** Read the installation receipt from `done`, commit that installed index, and push unless `--no-push`. Loom never force-pushes.

What the result means: `repair-checked` says the repaired-state checks were observed by the engine on unchanged candidate bytes. The grouping, root cause, invariant and sibling accounting are the parent's declarations, not engine observations, and an operator-owned command can still write a valid-looking report. `repair-checked` is not proof that the defect family is closed.

The parent must not substitute its own `git add` recipe or inject process outcomes, report bytes, manifests, installation receipts, or Run JSON through remediation input or hand-built run artifacts. Exact staged-set installation is a security and correctness boundary, not convenience automation. See the [Review and Fix Skill](../skills/review-and-fix/SKILL.md) and [operations recovery](standalone-review.md#remediation-and-git-safety).

## `/security-audit`

A security audit is a registered program with its own run directory. It enumerates the coverage units it will examine, assigns one hunter per unit, has an independent verifier on a different model profile try to refute each claim, and has a critic check the coverage claim against the recorded work. A claim is confirmed only with a sandbox receipt and a verifying ballot; anything less is recorded as a lead without a severity. Publication refuses while coverage is unsettled. Everything else is in [Running a security audit](security-audit.md).

## Standalone requirement workflows

- `/brainstorming` — collaborative idea exploration without starting full stateful orchestration.
- `/specify` — create or update a formal spec only.
- `/clarify [path]` — resolve clarification markers in a spec.
- `/spec-check` — read-only implementation/spec comparison with machine-readable finding counts.

When invoked inside `/loom`, their phase Agents and hooks update protected phase state. Invoked independently, they produce artifacts without creating a feature TaskGraph.

## Lint workflow

The immediate tier runs automatically after Edit/Write, followed by advisory type diagnostics for TypeScript sources ([operations](operations.md#advisory-type-diagnostics)). The full tier runs at Wave Gate. For an explicit project scan:

```bash
bun scripts/lint-project.ts <path>
```

The `lint-project` Skill can create project rules/configuration and explain violations. See [Lint Rules](../lint-rules/README.md).
