# Loom workflows

Loom supports one full feature-delivery lifecycle and several standalone quality workflows. They share Agents, policy, parsers, and review machinery, but not all of them use the protected TaskGraph.

## Capability map

| Workflow | Entry point | Protected TaskGraph | Run Directory | Main result |
|---|---|---:|---:|---|
| Full feature delivery | `/loom` | Yes | Panels/Wave Gates only | Implemented, reviewed Waves |
| Architecture panel | `/loom --panel[=N]` | Phase state | Yes | One user-selected architecture plan |
| Wave quality gate | `/wave-gate` | Yes | Yes | Advance, await decision, or block |
| Standalone review | `/review-pr` | No | Yes | Adjudicated `result.json` |
| Review and remediation | `/review-and-fix` | No feature graph | Review + remediation runs | Verified Git index, commit, optional push |
| Spec alignment | `/spec-check` | Reads active context when present | No standalone program | Per-requirement drift findings |
| Requirements only | `/specify`, `/clarify`, `/brainstorming` | Only when invoked by `/loom` | No | Requirements/design artifact |
| Project lint | `/lint-project` or script | No | No | Regex + structural violations |

## Full `/loom` lifecycle

```text
brainstorm → specify → clarify? → architecture → plan alignment → decompose
                                                                    |
                                                                    v
                                                    Wave 1 implementation Tasks
                                                                    |
                                                               Wave Gate
                                                                    |
                                                    Wave 2 ... → final Wave
```

The initial TaskGraph is created before Phase 0, activating ordering, direct-edit, state, model, Skill, and prompt guards.

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

Candidates, verdicts, ranking, and authority stay in a fresh run beneath the spec directory. A plan-alignment loop-back uses standard single-Agent architecture rather than opening a second panel.

**Pi transport:** the panel interviewer and other live-question phase roles run through `loom_interactive_subagent`, which relays the child Agent's standard UI requests to the parent Pi TUI. The normal Pi `subagent` transport remains headless and refuses these roles. See [Pi Interactive Phase Transport](pi-phase-agent-interviews.md).

### Phase 3.5: plan alignment

`plan-alignment-agent` maps the plan back to every requirement and writes:

```text
.claude/specs/<date-slug>/plan-alignment.md
```

If gaps remain, the user either loops back to architecture with the report or explicitly proceeds. Skip with `--skip-plan-alignment` only when that check is intentionally unnecessary.

### Phase 4: decompose

`decompose-agent` emits JSON. Before state changes, the engine validates:

- known implementation Agents;
- unique Task ids and valid dependencies;
- Wave order and bounded parallelism;
- declared files and test policy;
- spec anchors;
- executable lifecycle/pipeline/invariant bindings from the plan.

The user approves the proposed Tasks/Waves. Loom creates a GitHub Issue and `populate-task-graph` atomically installs the validated graph. Before population, optional operator-owned command authority is validated and installed through `helper write-verification-manifest`; direct writes to the guarded `.loom/verification-manifest.json` path are intentionally blocked. During population, the engine reads those exact bytes and freezes the resulting authority into the protected TaskGraph. Decompose JSON cannot provide or override it. An absent file selects the engine default with only reserved checks. The state file returns to mode `0444`.

Typical guidance is 8–12 Tasks, 4–5 Waves, and 4–6 parallel Tasks per Wave. These are planning bounds, not a license to force a small feature into needless Tasks.

### Verification manifest

Project-wide Wave checks are declared before Task population. Write the JSON to an unguarded temporary file, then install it through the sole validating write seam:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper write-verification-manifest < /tmp/loom-verification-manifest.json
```

The helper validates before writing, refuses symlinked paths and conflicting replacement, and refuses all changes after Tasks are populated.

```json
{
  "schemaVersion": 1,
  "kind": "loom-verification-manifest",
  "checks": [
    {
      "id": "project:typecheck",
      "scope": "wave",
      "executable": "npm",
      "args": ["run", "typecheck"],
      "cwd": ".",
      "timeoutMs": 600000,
      "report": { "kind": "not-required" }
    }
  ]
}
```

Commands always execute with `shell: false` under an explicit executable/subcommand policy:

- allowed basenames are the bounded build/test/runtime set `biome`, `bun`, `cargo`, `cmake`, `deno`, `dotnet`, `eslint`, `gcc`, `g++`, `go`, `gradle`, `gradlew`, `java`, `javac`, `jest`, `make`, `mvn`, `mvnw`, `ninja`, `node`, `npm`, `perl`, `pnpm`, `pytest`, `python`, `python3`, `python3.10`, `python3.11`, `python3.12`, `python3.13`, `python3.14`, `pypy3`, `ruby`, `rustc`, `tsc`, `vitest`, `yarn`;
- a project-local executable path is accepted only when its basename is in that same set (for example `node_modules/.bin/vitest` or `tools/gradlew`);
- `npm`, `pnpm`, and `yarn` accept only explicit `run`, `run-script`, `test`, `check`, or `build` script forms; `exec`, `dlx`, `x`, implicit binary dispatch, `npx`, and `bunx` are rejected;
- runtimes accept bounded file/test/check/build modes. Inline modes are rejected, including Node `-e`/`-p`/`--eval`/`--print`, Bun `eval`/`-e`/`x`, Deno `eval`, Python `-c`, and Perl/Ruby `-e`/`-E`.

Shells and generic dispatchers are not allowlisted. Traversal, duplicate/reserved ids, and surplus fields are also rejected. Required reports must live beneath `.loom/completion-reports/`; those report bytes are excluded from workspace authority, while tracked and non-ignored untracked implementation bytes remain bound by the Wave workspace digest. Once the TaskGraph is populated, changing the source file does not change the frozen command authority.

### Phase 5: execute

For each Wave, the orchestrator spawns all dependency-ready implementation Tasks in parallel. The selected Agent receives a complete prompt with:

- Task/Wave identity and dependencies;
- required Skill;
- exact spec anchors and plan context;
- declared file list;
- architecture and stack-specific rules;
- test and proof contract.

Direct parent edits are blocked while an orchestration is active. Implementation happens through Agents so completion, files, test evidence, and proof can be attributed.

A Task reaches `implemented` only when its proof obligations are satisfied **and** the Implementation Completion Oracle accepts an exact Task Completion Suite for the engine-issued Implementation Attempt. Completion prose, a Task id inferred from `executing_tasks`, and an unreserved harness result are cleanup evidence only.

Claude binds authority through a session+Agent sidecar published with no-replace semantics at SubagentStart; Pi stores the exact authority on its ReservedSlot. Duplicate delivery is idempotent, and a late result cannot release a newer reservation. Every applied transition appends one immutable settlement receipt and atomically updates lifecycle/evidence, clears only matching attempt fields, invalidates review/spec/Wave authority when required, and recomputes `impl_complete`.

The Slice 3 Task-local suite has one engine-owned check: `loom:task-byte-scope`. Its allowed set is the current `attempt_artifact_baseline` (declared plus previously attributed paths captured at registration). Current-attempt bytes compare that baseline; cumulative declared-artifact Proof still compares the first `artifact_baseline`. A transcript path outside the allowed set is semantic failure regardless of ownership. Baseline/path/read/Git uncertainty is infrastructure-blocked. The first unresolved repository baseline survives non-positive settlement and stale reclamation; a fresh attempt binds to it rather than laundering existing bytes. Shared exact settlement derives canonical sibling ownership under the TaskGraph lock from every other current-Wave Task's `file_list` and `files_modified`. Repository changes from the retained baseline classify as Task-local when currently allowed, inert/non-attributable when sibling-owned, and semantic out-of-scope otherwise; every unowned changed path enters `unresolved_repository_paths` even when omitted from the transcript. Reversion removes resolved paths, and accepted exact settlement clears the retained authority.

`executing_tasks` is parser-bound to the Task roster. An unknown reservation makes the TaskGraph corrupt and blocks readiness/writes until `repair-task-graph` explicitly removes it with a diagnostic. Session `.task_graph` pointers are bound through one Claude/Pi helper that canonicalizes the active graph, refreshes stale pointers atomically without following symlinks, and rolls back only an exact owned binding.

Task-local settlement runs **no arbitrary Task/project subprocesses**. Build, typecheck, test commands, package scripts, reports, and full-tier lint execute only in the quiescent Wave suite. Slice 3 records retry-required after semantic attempt 1 and escalation-required after semantic attempt 2, but dispatches neither. Slice 4 alone freezes retry diagnostics/context and launches attempt 2 or escalation.

## Task proof obligations

The engine derives proof from declared requirements and observed evidence. Depending on Task policy, obligations include:

- Agent completion;
- a passing regression test result;
- newly written tests;
- every declared artifact changed.

Evidence retains provenance:

- report-backed ledger evidence can produce `trusted-pass`/`trusted-fail`;
- Pi’s paired structured result remains `pi-structured`;
- transcript fallback is explicitly untrusted/degraded;
- a pass invalidated by later writes does not remain a pass.

A Task carries an explicit `verification_policy` with independent `regression` and `new_tests` requirements. Each arm is either `required` or `waived` with a typed reason. For example, `existing-tests-sufficient` waives new-test creation while retaining regression execution; `documentation-only` may waive both. Historical `new_tests_required` booleans remain read-compatible, but new TaskGraphs persist the explicit policy and reject conflicting dual declarations. Neither policy waives declared-artifact proof or review.

## Wave Gate

`/wave-gate` starts a fresh registered Wave Gate program. The engine, not the parent model, owns readiness checks, Review Packet publication, reviewer/model/Skill selection, retries, aggregation, refutation routing, advisory suspension, full-tier lint, and protected Wave advancement.

The parent executes only the returned action and resumes the same run.

### Review stage

For every Wave Task, Loom creates an immutable Review Packet and issues the exact reviewer roster:

- `code-reviewer`;
- `silent-failure-hunter`;
- `pr-test-analyzer`;
- `type-design-analyzer`;
- `comment-analyzer`.

`spec-check-invoker` runs once for the Wave. Exact transcript bytes are captured into engine-reserved slots. Missing/malformed output cannot be papered over by a clean sibling result.

### Remediation-aware reviews

Implementation changes increment `review_generation`. A new Review Run snapshots prior active Finding ids. Every expected reviewer must assess each prior Finding exactly once:

- `resolved_by_remediation` from the complete roster retires it into `resolved_findings`;
- any `still_present` assessment keeps it active;
- new Findings become active only at atomic finalization.

This prevents a clean rerun from silently erasing an old blocker by omission.

### Refutation panel

If critical Findings exist, Loom selects refutation lenses and issues one `review-verifier-agent` per lens. Every verifier covers the complete critical set.

Baseline lenses are `reproduction` and `intent`; signals can add `blast-radius`, `security`, or `test-coverage`. The default panel size is three.

A strict majority must refute a Finding. `uncertain` is neutral and ties keep the Finding. Refuted Findings move to `refuted_findings` with all reasoning; they are never deleted.

Only criticals are refuted. Advisories are user-policy decisions, not verifier work.

### Advisory decision

A Wave with surviving advisories reaches `await-user`. The user records a disposition and reason. The lifecycle has one “decision accepted” transition; fixed/deferred/dismissed meaning remains in the decision payload rather than multiplying lifecycle states.

### Quiescent completion suite, full lint, and completion

After every current-Wave implementation Agent has stopped and Task proof/test requirements pass, the registered Wave Gate executes the frozen completion suite against the integrated Git-visible workspace. Exit code, timeout, signal, spawn failure, and required-report production remain independent facts. Missing, duplicate, surplus, stale, malformed, or conflicting results fail closed; infrastructure failures remain distinct from semantic check failures.

The engine publishes the exact result immutably in the Wave Run Directory. An accepted result is then bound into protected state with run, Wave, registration revision, manifest, suite, result, and workspace digests. Resume reuses the protected receipt or recovers it from exact immutable result bytes after a crash; it never reruns commands over ambiguous occupied evidence. `/loom --status` reports accepted, stale, rejected, pending, or unavailable suite authority without executing commands.

Full-tier lint is the reserved `loom:full-tier-lint` suite check. During migration, the existing terminal lint invocation also remains as a fail-closed canary. Structural failures such as forbidden imports, I/O in pure modules, oversized functions, or changed generated integrity block advancement.

The final protected-state commit re-observes the workspace and checks implementation proof, completion-suite authority, reviews, spec alignment, surviving criticals, and required lifecycle artifacts. Success archives a schema-v2 completion record, marks Tasks completed, and advances the Wave; otherwise a typed diagnostic explains the block. Historical schema-v1 Waves and active TaskGraphs created before this feature remain read-compatible and are never rewritten. The direct `complete-wave-gate` helper is compatibility-only: it refuses every graph carrying `verification_manifest`. Modern corrected findings are stored first and then the exact registered Wave Gate is resumed (or `/wave-gate` is started when no registration exists), so no direct helper can bypass suite execution or invent current-workspace/Run Directory authority.

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
8. publishes authoritative `artifacts/result.json`.

The result separates `surviving_critical_findings`, `advisory_findings`, and `refuted_critical_findings`. A missing roster member or invalid panel result blocks publication.

Review aspects are `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, and `all` (default). Architecture review is included explicitly for `all`/`architecture` and by size/shape policy for large structural changes.

## `/review-and-fix`

This workflow composes two registered programs around semantic remediation:

1. **Standalone review and adjudication.** Produce authoritative review `result.json`.
2. **Plan.** Record exact scope, surviving criticals, accepted advisories, refuted audit, concrete fixes, and validation commands.
3. **Implement and validate.** Fix only surviving/accepted Findings and run real checks. `--dry-run` stops before implementation.
4. **Registered remediation.** Freeze the source result plus explicitly allowed support paths, audit observed dirty paths, reject unrelated or evidence paths, stage literal paths in a temporary Git index, prove audited equals staged, recheck repository witnesses under the real index lock, and atomically install the verified index.
5. **Commit/push.** Commit the installed index and push unless `--no-push`. Loom never force-pushes.

The parent must not substitute its own `git add` recipe: exact staged-set installation is a security and correctness boundary, not convenience automation.

## Standalone requirement workflows

- `/brainstorming` — collaborative idea exploration without starting full stateful orchestration.
- `/specify` — create or update a formal spec only.
- `/clarify [path]` — resolve clarification markers in a spec.
- `/spec-check` — read-only implementation/spec comparison with machine-readable finding counts.

When invoked inside `/loom`, their phase Agents and hooks update protected phase state. Invoked independently, they produce artifacts without creating a feature TaskGraph.

## Lint workflow

The immediate tier runs automatically after Edit/Write. The full tier runs at Wave Gate. For an explicit project scan:

```bash
bun scripts/lint-project.ts <path>
```

The `lint-project` Skill can create project rules/configuration and explain violations. See [Lint Rules](../lint-rules/README.md).
