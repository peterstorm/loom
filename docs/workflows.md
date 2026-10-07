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

Project-wide Wave checks are declared before Task population. For the **first** installation, write the JSON to an unguarded temporary file, then pass it through the validating create-only seam:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper write-verification-manifest < /tmp/loom-verification-manifest.json
```

The helper requires an existing, loadable empty TaskGraph at the canonical `.claude/state/active_task_graph.json` or `.pi/state/active_task_graph.json` path. It validates before writing, accepts a byte-equivalent canonical replay, refuses to overwrite different existing authority, and refuses all changes after Tasks are populated. It is **not** an update command. In normal `/loom` use, Phase 0 initialization already supplied that empty graph. For an approved first installation without a live orchestration, use official `init-state` to create an empty bootstrap, install with `write-verification-manifest`, then use `helper cleanup-state` on that same graph. Prepare real metadata/spec directories as required by initialization; never hand-author state JSON, session pointers, Tasks, Waves, or completion receipts. Do not tear down an unrelated active graph. This metadata bootstrap installs source configuration only; it creates no Task/Wave verification authority.

Standalone remediation itself has no TaskGraph requirement. The empty-TaskGraph condition belongs only to this manifest creation helper. Replacing an existing operator manifest is an explicit operator-controlled action at an approved idle boundary under the repository's protected-state policy; the helper cannot perform it. Never bypass protected paths or mutate a populated graph. Existing TaskGraphs keep the commands frozen at their own population even after a later source replacement.

Loom's own repository uses this exact check; other projects choose their own operator-approved commands:

```json
{
  "schemaVersion": 1,
  "kind": "loom-verification-manifest",
  "checks": [
    {
      "id": "project:verify",
      "scope": "wave",
      "executable": "npm",
      "args": ["run", "verify"],
      "cwd": ".",
      "timeoutMs": 1800000,
      "report": { "kind": "required-file", "path": ".loom/completion-reports/verify.junit.xml" }
    }
  ]
}
```

For Loom, this is the same root `npm run verify` used locally and by Linux CI, including tag pushes: engine prerequisites, then typecheck, then the entire existing Vitest + six-smoke test script. Install both root and engine frozen dependencies first and use a full-history checkout: deterministic calibration tests resolve committed historical revisions from remote refs, so CI uses `actions/checkout` with `fetch-depth: 0`. See [Development validation](operations.md#development-validation). The manifest is an operator source, not an executable script: `verify` must not call the manifest runner or a Wave Gate, which would recurse. A local/CI process success does not mint a Wave receipt. Only the registered runtime suite observes the frozen command and installs its own evidence; never create a receipt manually. The user-approved 2026-09-09 idle enrollment changed only the report policy, not the fixed command. Its existing Vitest invocation now writes the required root JUnit file via `--reporter=default --reporter=junit --outputFile=../.loom/completion-reports/verify.junit.xml` from `engine/`; `.loom/completion-reports/` is Git-ignored and generated reports stay untracked. JUnit describes only Vitest tests; normal zero exit of the whole command also proves the compiler and six smokes passed. A green report never overrides a later smoke failure. This enrollment is not a completed live schema-v2 remediation; the registered engine must still observe a fresh passing command and report.

Critical-remediation checks must use `required-file`. For other projects, here is a complete Vitest alternative whose fixed argv names the exact output file:

```json
{
  "schemaVersion": 1,
  "kind": "loom-verification-manifest",
  "checks": [
    {
      "id": "project:repair-regression",
      "scope": "wave",
      "executable": "node_modules/.bin/vitest",
      "args": ["run", "tests/repair-regression.test.ts", "--reporter=json", "--outputFile=.loom/completion-reports/repair-regression.json"],
      "cwd": ".",
      "timeoutMs": 120000,
      "report": { "kind": "required-file", "path": ".loom/completion-reports/repair-regression.json" }
    }
  ]
}
```

A Node JUnit alternative is also parser-valid:

```json
{
  "schemaVersion": 1,
  "kind": "loom-verification-manifest",
  "checks": [
    {
      "id": "project:repair-regression",
      "scope": "wave",
      "executable": "node",
      "args": ["--test", "--test-reporter=junit", "--test-reporter-destination=.loom/completion-reports/repair-regression.xml", "tests/repair-regression.test.mjs"],
      "cwd": ".",
      "timeoutMs": 120000,
      "report": { "kind": "required-file", "path": ".loom/completion-reports/repair-regression.xml" }
    }
  ]
}
```

These are alternatives, not commands Loom adds automatically. The operator must choose a real repository test and ensure the selected fixed command produces the exact configured path. That path must be below `.loom/completion-reports/`, untracked, and Git-ignored; the config neither creates the report nor ignores it. Critical repair acceptance requires a newly produced report, normal exit, more than zero executed tests, and zero failures—an empty or all-skipped report is not evidence. Before launching, the engine removes the exact old ignored/untracked regular report via no-follow, descriptor-relative unlink anchored to its Linux parent; touching stale bytes cannot pass, but an identical fresh rewrite may. Reset failure blocks before launch. This strict critical-remediation reset is **Linux-only**; Darwin fails closed before launch, without changing zero-critical remediation or Wave behavior. Reports are bounded to **8 MiB** and XML depth **128**; v2 event reads, append reconciliation/new appends, and inspection are bounded to **12 MiB per encoded event, 64 MiB per encoded journal, 1024 records**. See [report boundary and enrollment](operations.md#enrolling-a-critical-repair-check) for exact scope and recovery. Do not add a generic root task runner solely for enrollment.

Commands always execute with `shell: false` under an explicit executable/subcommand policy:

- allowed basenames are the bounded build/test/runtime set `biome`, `bun`, `cargo`, `cmake`, `deno`, `dotnet`, `eslint`, `gcc`, `g++`, `go`, `gradle`, `gradlew`, `java`, `javac`, `jest`, `make`, `mvn`, `mvnw`, `ninja`, `node`, `npm`, `perl`, `pnpm`, `pytest`, `python`, `python3`, `python3.10`, `python3.11`, `python3.12`, `python3.13`, `python3.14`, `pypy3`, `ruby`, `rustc`, `tsc`, `vitest`, `yarn`;
- a project-local executable path is accepted only when its basename is in that same set (for example `node_modules/.bin/vitest` or `tools/gradlew`);
- `npm`, `pnpm`, and `yarn` accept only explicit `run`, `run-script`, `test`, `check`, or `build` script forms; `exec`, `dlx`, `x`, implicit binary dispatch, `npx`, and `bunx` are rejected;
- runtimes accept bounded file/test/check/build modes. Inline modes are rejected, including Node `-e`/`-p`/`--eval`/`--print`, Bun `eval`/`-e`/`x`, Deno `eval`, Python `-c`, and Perl/Ruby `-e`/`-E`.

Shells and generic dispatchers are not allowlisted. Traversal, duplicate/reserved ids, and surplus fields are also rejected. Required reports must live beneath `.loom/completion-reports/`; those report bytes are excluded from workspace authority, while tracked and non-ignored untracked implementation bytes remain bound by the Wave workspace digest. Once the TaskGraph is populated, changing the source file does not change the frozen command authority.

### Project Verification Coverage

Population reports coverage immediately. Canonical status and Wave Gate summaries expose the same independent `projectVerificationCoverage` projection:

| Value | Meaning |
|---|---|
| `not-configured`, reason `engine-default` | Source was absent at population; only reserved checks were frozen. |
| `not-configured`, reason `empty-operator-manifest` | Operator source explicitly contained zero project checks. |
| `not-configured`, reason `historical-unknown` | Archived accepted receipt has only reserved checks; absent-versus-empty source provenance is unavailable. |
| `configured`, non-empty sorted `checkIds` | Those project commands are configured; this alone says nothing about their outcome. |

Missing and empty manifests retain the existing engine-only advancing policy. An accepted reserved-only suite is **not** a project verification pass, nor a new waiver. Nonempty configuration must still earn accepted, current suite evidence; neither a count nor “configured” means passed. Coverage appears on `required`, `accepted`, `rejected`, and `stale` readiness. Completed schema-v2 Waves derive it from their archived accepted receipt roster, not today's source or frozen manifest. Legacy-unavailable readiness stays unavailable without invented coverage. No coverage field is persisted, no new strict requirement for all projects is introduced, and unconfigured test/build/typecheck categories are not implied to have run.

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

The Slice 3 Task-local suite has one engine-owned check: `loom:task-byte-scope`. Its allowed set is the current `attempt_artifact_baseline` (declared plus previously attributed paths captured at registration). Current-attempt bytes compare that baseline; cumulative declared-artifact Proof still compares the first `artifact_baseline`. A transcript path outside the allowed set is semantic failure regardless of ownership. Baseline/path/read/Git uncertainty is infrastructure-blocked. Shared exact settlement derives canonical sibling ownership under the TaskGraph lock from every other current-Wave Task's `file_list` and `files_modified`. Repository changes from the attempt's `repository_baseline` classify as Task-local when currently allowed, inert/non-attributable when sibling-owned, and semantic out-of-scope otherwise; an unowned changed path invalidates that settlement even when omitted from the transcript. Every exact settlement retires the repository boundary, so a retried or infrastructure-blocked Task re-arms on a fresh boundary and repository movement between attempts is never attributed to it; only an attempt that ends without settlement leaves its boundary for the next registration to reuse. No unresolved-path carry is persisted: the State File parser validates a legacy `unresolved_repository_paths` field and drops it.

`executing_tasks` is parser-bound to the Task roster. An unknown reservation makes the TaskGraph corrupt and blocks readiness/writes until `repair-task-graph` explicitly removes it with a diagnostic. Session `.task_graph` pointers are bound through one Claude/Pi helper that canonicalizes the active graph, refreshes stale pointers atomically without following symlinks, and rolls back only an exact owned binding.

The engine-owned Task Completion Oracle launches **no Task/project subprocesses**. Implementation Agents still run the Task-level regression commands required by their Verification Policy via Bash, producing evidence for settlement. Engine-owned build, typecheck, test commands, package scripts, reports, and full-tier lint execute only in the quiescent Wave suite.

Bounded retry is derived from immutable settlement history. Unversioned Slice-3 history uses a read-only compatibility projection until the next registration records protocol 2, a strict suffix start, and—when migrating into attempt 2—its predecessor retry receipt. Protocol-2 receipts from that cutover are reduced in wire order: a receipt is legal only for the current semantic attempt, and reordered, contradictory, wrong-attempt, skipped-terminal, or post-escalation history fails closed. A semantic attempt-1 failure emits `retry-required`; canonical status then publishes one exact `LOOM_IMPLEMENTATION_RETRY_CONTEXT` appendix binding the Task, attempt 2, predecessor receipt, and sorted failure kinds. The shared Claude/Pi spawn gate requires those exact status-issued bytes, freezes its prompt/context digest with the new attempt authority before dispatch, and refuses stale, altered, missing, duplicate, invented, or representation-different retry context. Infrastructure-blocked receipts never consume the semantic budget and remain eligible at the same attempt. Status excludes non-reclaimable Tasks already executing or carrying active attempt authority; policy-expired reservations become dispatchable only under observed-empty roster authority so registration can reclaim them atomically. It emits `await-wave-implementation` when nothing is dispatchable. A semantic attempt-2 failure emits `escalation-required`; status becomes non-retryable and no attempt 3 can be registered. An accepted current-attempt implementation receipt starts a fresh attempt-1 lineage if the non-completed Task is later deliberately reopened for remediation.

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

`spec-check-invoker` runs once for the Wave; its grammar, identity and Requirement Coverage floor are unchanged. Fresh reviewer registrations use Reviewer Protocol v2: exactly one JSON final payload under the issued packet's frozen schema/rubric, with engine-derived counts/IDs. Wave payloads echo packetId/generation and assess every prior ID once in packet order. Criticals require full Finding Basis; advisories require reason. Structure is not proof of truth or impact. Exact final bytes are captured into engine-reserved slots, then registered resume admits/settles them without legacy polling/concatenation. Malformed current output creates failed evidence, not a synthetic Finding. See [protocol operations](operations.md#reviewer-protocol-v2).

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

Only criticals are refuted. Advisories are user-policy decisions, not verifier work.
The same panel assesses the assertion including its preconditions, contract and
consequence, retaining full current basis. A true assertion is not refuted merely
because repair seems unimportant; surviving criticals block. No severity downgrade
or standalone severity-dispute action is added. The existing explicit Wave operator
override remains separate, never automatic fallback for malformed reviewer evidence.

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
8. publishes authoritative `result.json` at the Run Directory root.

The result separates `surviving_critical_findings`, `advisory_findings`, and `refuted_critical_findings`. A missing roster member or invalid panel result blocks publication.
Use `helper orchestration inspect --runs-root <root> --run <run>` for the
engine-rendered emitted/admitted and after-refutation summary from authenticated
published authority, not authored arithmetic. JSON inspection keeps its existing
shape; no summary artifact is added.

Completed and unfinished issued reviewer v1 runs retain their original protocol,
including all retry/replay prefixes and packet-first archived role/shared-wire
instructions. The archive does not invent an originally frozen rubric/persona.
Fresh starts select v2 internally, never by output sniffing or caller flag.

Review aspects are `code`, `errors`, `tests`, `types`, `comments`, `architecture`, `simplify`, and `all` (default). Architecture review is included explicitly for `all`/`architecture` and by size/shape policy for large structural changes.

## `/review-and-fix`

This workflow composes two registered programs around semantic remediation:

1. **Standalone review and adjudication.** Produce authoritative review `result.json`.
2. **Plan and account.** Copy every surviving-critical Finding ID exactly once into a disposition. Repaired dispositions point to separately named Declared Repair Groups; unresolved and out-of-scope dispositions are allowed but block installation. Keep advisories under the existing autonomous accepted/deferred/dismissed policy outside critical groups, and retain refuted criticals for audit without repairing them.
3. **Implement and validate.** Fix only repaired criticals and accepted advisories, declare root cause/invariant/sibling accounting/Historical RED with `DECLARED` provenance, and run real development checks. `--dry-run` stops before implementation.
4. **Registered remediation v2.** Always supply `defectFamily`, including `{ "kind": "not-required" }` for an authoritative source with zero surviving criticals. The engine authenticates the source, performs preflight before Run Directory creation, selects fixed report-producing operator checks for critical repairs, records fresh repaired-state observations, binds them to immutable candidate authority, audits paths, and installs only an opaque versioned assessment.
5. **Commit/push.** Read the actual nested `outcome.installation` receipt from `done`, commit that installed index, and push unless `--no-push`. Loom never force-pushes.

A Declared Repair Group does not replace or mint Finding IDs. Compatible sibling reuse across distinct groups is allowed; duplicate sibling paths inside one group or conflicting cross-group statuses are rejected. `repair-checked` means the repaired-state checks were engine-observed on unchanged candidate bytes. It does not prove the declared family, root cause, invariant, sibling completeness, or Historical RED, and it is not `ResolvedFinding` status. An operator-owned fixed command can still fabricate a syntactically valid new report; structured fresh engine observations are not semantic proof.

Completed schema-v1 remediation remains read-only `historical-unknown`, returning its old receipt without reinstalling; unfinished v1 cannot install and missing v2 authority never downgrades. Completed-v2 replay refuses missing/malformed checkpoint audit arrays with an explicit audit-path diagnostic. The source review's immutable publication remains source authority, not a new P3 assessment. P4 source review, merge, publication and runtime cutover remain pending. Subsequent review/install must use the actually admitted runtime, with unchanged P3 v2 report/install policy; a reviewer-v1 source is not a remediation-v1 run. The Skill 3.1 bootstrap in ADR-0008 remains historical P3 context. Reload/restart after package installation; never bypass runtime admission.

The parent must not substitute its own `git add` recipe or inject process outcomes, report bytes, manifests, installation receipts, or Run JSON through remediation input or hand-built run artifacts. Exact staged-set installation is a security and correctness boundary, not convenience automation. See the canonical [Review and Fix Skill](../skills/review-and-fix/SKILL.md) and [operations recovery](operations.md#remediation-and-git-safety).

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
