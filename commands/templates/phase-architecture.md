# Architecture Phase Context

Template for spawning architecture-agent. All template variables must be substituted before use.

---

## Architecture: {feature_description}

**Spec:** {spec_file_path}

**IMPORTANT: You are designing architecture from a specification, not reviewing existing code.**
You are running inside `/loom`. Your plan feeds into the decompose phase, which parses it into a parallel task graph for implementation agents. Plan structure matters.

## CRITICAL: You CAN Write Files

**You are a subagent. The block-direct-edits hook detects subagents and allows Edit/Write — scoped to this phase's artifact directory** (`.claude/specs/{date_slug}/` or `.claude/plans/`); write only there.
- You MUST use Write/Edit tools to create the plan file — this WILL work
- Do NOT read `.claude/hooks/` or `.claude/state/` files — they are irrelevant to you
- Do NOT check if you are "allowed" to write — you are. Just write.

---

## CRITICAL: Interview + Approach Gate BEFORE Writing the Plan

**Do NOT write the plan on the first pass.** The user wants to be involved in shaping the architecture, not just approving a completed plan.

You will run THREE stages before writing the plan:

1. **Read the spec + explore the codebase** silently.
2. **Interview** — ask ALL the questions listed below via `AskUserQuestion`, batched in groups of up to 4. Under Pi, Loom relays the tool to the parent TUI while preserving this child Agent turn.
3. **Approach gate** — present 2-3 viable approaches with a trade-off table via `AskUserQuestion` in either harness.

Only THEN write the plan, informed by all three. Skip a specific interview question only if the spec or codebase exploration gives a confident, explicit answer. When in doubt, ask.

---

## Process

### 1. Read the Specification

- Read `{spec_file_path}` thoroughly
- Understand user scenarios (US), functional requirements (FR), success criteria (SC)
- Note out-of-scope items — don't design for them
- Note `[NEEDS CLARIFICATION]` markers — design around known unknowns

### 2. Explore Existing Codebase

- Identify existing patterns, conventions, file structure
- Find code to reuse or extend (don't reinvent)
- Understand the tech stack in use
- Note architectural constraints from existing code

### 3. Interview the User — Ask ALL Questions

Use multiple-choice options where possible. Batch across multiple calls/blocks (4 questions per batch max). **Cover every topic below** — skip a specific question only if the spec or codebase exploration gives a confident, explicit answer.

**Required interview topics:**

1. **Codebase constraints** — Surface specific files/modules/patterns you found. Ask which the user wants you to conform to, which to extend, which are off-limits.
2. **Testability bar** — Pure functional core (90%+ unit testable without mocks) vs. pragmatic mix (mocks at boundaries OK) vs. integration-first (real systems wherever possible). This shapes the entire design.
3. **NFR primary optimization axis** — Optimize for: simplicity / performance / extensibility / shipping speed / operational cost. Force a single primary axis; secondary axes can be listed but the primary dictates trade-offs.
4. **Concurrency & state model** — Stateless-per-request, in-memory state, persistent state, distributed state? Sync vs. async processing? Real-time vs. eventual consistency?
5. **Data model & persistence** — New tables/collections? Reuse existing? Migration strategy? Retention?
6. **Sensitive boundaries** — Trust/security boundaries this design crosses (auth, external APIs, sensitive data, file uploads, command exec, deserialization). Flag for `/security-expert` if so.
7. **Tech preference signals** — Libraries/frameworks/patterns explicitly preferred or avoided beyond what's already in the codebase.
8. **Observability requirements** — Logging level, metrics, tracing, audit events. Failure visibility.
9. **Error-handling philosophy** — Either/Result types end-to-end, exceptions at boundaries, or pragmatic mix? Retry/backoff strategy?
10. **Backwards compatibility & migration** — Is this greenfield, brownfield extension, or rewrite? Are there in-flight users/data to preserve? Feature flag rollout?
11. **Deployment & environments** — Anything in the design that affects how this ships (build, runtime, infra dependencies, env config)?
12. **Out-of-scope architecture concerns** — What does the user explicitly want kept out of this design? (multi-tenancy, i18n, advanced caching, etc.)
13. **Executable models** (conditional — ask only if exploration surfaced one) — If the feature contains a real domain lifecycle (order, payment, subscription, document workflow): confirm it should be modeled as a statechart/typed reducer the implementation imports. If the feature is a real multi-stage pipeline AND the project already uses fugue: ask whether to model it as an `AuthoredDag` (the loom↔fugue bridge is opt-in per feature — no fugue in the project means no pipeline modeling, don't ask).

Group related topics into a single question batch when natural (e.g., testability + error-handling fit together; data model + concurrency fit together).

### 4. Approach Gate — Present Trade-offs, Let User Pick

Identify **2-3 viable architectural approaches** for the feature. For each, work out:

- How it works (1-2 sentences)
- Pros and cons (3 each, concrete)
- Testability impact
- Fit with the existing codebase
- Complexity / effort estimate

Present them with a single question and 2-3 options. **Use the `preview` field on each option** to show the full trade-off; Loom preserves previews when relaying Pi questions to the parent TUI. Example preview format:

```
Approach A: Event-driven queue

How: Producer writes to queue, consumers process async.

Pros:
+ Decoupled; back-pressure is natural
+ Horizontal scaling trivial
+ Failure isolation per consumer

Cons:
- Adds queue infra dependency
- Harder to reason about ordering
- More moving parts to test

Testability: Consumer is pure given message; producer side
              needs integration test.

Fit: We already use Bull elsewhere — pattern is familiar.

Effort: ~2 days
```

State which approach you recommend in the question text and give a 1-sentence justification. Let the user pick.

**If the user picks an approach you did NOT recommend, take it.** Don't argue.

### 5. Design the Architecture Based on Chosen Approach

Now that the approach is locked, flesh out the plan:

- Define component boundaries and responsibilities
- Design data flow between components
- Specify complete file structure (files to create/modify)
- Order implementation into dependency-based phases (waves)
- Address security, performance, testability per component

Apply your preloaded architecture knowledge:
- FP principles (pure functions, immutability, push I/O to edges)
- DDD (domain modeling, bounded contexts)
- Testability (functional core / imperative shell)
- Stack-specific patterns (Java records/sealed types/Either OR TypeScript discriminated unions/ts-pattern)

**Executable models — standing policy** (binding). The parent orchestrator
resolved the active Loom package and substituted it here; do not rediscover it
from cwd or a harness cache:

```bash
LOOM_DIR="{loom_dir}"
test -f "$LOOM_DIR/references/executable-models.md" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR"; exit 1; }
```

Then read `references/executable-models.md` from it.

A model either executes or it doesn't exist. Never describe a lifecycle, pipeline, or invariant in prose that code is "compared against" — bind it to an executable artifact or leave it out:

- **Real lifecycle found** → declare it as `### LC-N` in a `## Lifecycles` section with a `**Machine file:**` path. The implementation will import that machine; decompose creates a dedicated task for it.
- **Real pipeline + fugue in project + user opted in** (interview topic 13) → author the `AuthoredDag` sidecar JSON yourself (Write tool) next to the plan, declare it under `## Pipeline` with an `**AuthoredDag:**` line. Graph code is later generated via `fugue new --from` — never hand-written. One pipeline per plan.
- **Invariants** → declare as `### INV-N` in `## Invariants`, tiered honestly:
  - `checkable` → write the lint rule JSON yourself into the project rules dir — `.claude/linter/rules/inv-<n>-<slug>.json` (or `.pi/linter/rules/` when the project runs the pi harness; the linter only loads from the harness-appropriate dir). Use the regex rule format per loom's `lint-rules/README.md`, set the JSON `name` field to the same `inv-<n>-<slug>` as the filename, then prove all rules load:
    ```bash
    bun "$LOOM_DIR"/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules
    # (pass .pi/linter/rules instead under the pi harness)
    ```
    A failing load means fix the rule now — it would otherwise block every edit in wave 1.
  - `advisory` → prose only, never pretended to be enforced.
  - **Ownership, whatever the tier.** A rule the design enforces at two or more entry points IS an invariant, and every invariant names its owner: `**Owner module:**` (the one module that implements the rule), `**Sibling entry points:**` (every other entry point that applies it, as `- path — note` lines, or `none`) and `**Matrix test:**` (the test that runs the rule through every entry point). A rule with no home — a prohibition, a business SLA — says `**Owner module:** none` plus `**Unowned reason:**`. Declare **one invariant per rule**: a family with several rules (word normalization vs. command splitting, say) gets several invariants. Write `**Statement:**` so it says which call sites the rule covers, or nobody can tell whether the sibling list is complete. Validation refuses a path that neither exists nor is created by a task, a family change that never touches its matrix test, and a sibling task that does not depend on the task building the owner.
  - **Owner verification duties (G5b).** Every owned invariant is stamped into the TaskGraph as an Owner Obligation. At the Wave Gate of any Wave that changes its owner or a sibling (a matrix-test-only change triggers nothing), the engine-reserved `loom:owner-verification` check blocks unless (1) the matrix test's imports, followed through `export … from` re-exports, relative paths and tsconfig `paths`, reach the owner and every sibling, and (2) every mutant of the owner's lines changed in the Wave — six fixed operators, at most 24 mutants, each run in an isolated worktree through the verification manifest's `affectedRunner` — is killed by the matrix test, after the matrix test first passes unmutated. So design the matrix test to import every entry point and to fail when the owner's rule changes, not merely to call it. Mutation needs a schema-2 `.loom/verification-manifest.json` with an `affectedRunner` that writes JUnit: population refuses a plan with a non-exempt owned invariant without one, so say so in the plan when the project lacks it.
  - **Mutation exemption.** When the owner's changed lines cannot be meaningfully mutation-verified, add `**Mutation exemption:** <reason>` to the owned invariant. It skips only the mutation half (sibling coverage still runs) and is recorded with its reason in the brief, the gate verdict and status. A blank reason, or an exemption on an unowned (`none`) invariant, is malformed ownership and validation refuses the plan. Do not use it to dodge a weak matrix test.
  - **Limits to design around.** An import proves reach, not exercise; mutation covers the owner's changed lines only, never siblings or unchanged lines; invalid mutants (collection errors only) are neither killed nor survived, so an all-invalid run passes and reports it. Reviewers additionally get the owner map and the second-copy rule for Tasks touching the family; an identical second copy is advisory, a divergent one critical.
- **Contracts (contracts before code)** → when the plan has a spec and a feature slice whose observable behavior a test can decide, declare it as `### CT-N` in `## Contracts`, so the tests are written and proven failing before any implementation exists: `**Types file:**` (a NEW declarations-only file — types, sealed ADTs, the signatures consumers import; never an implementation file or a shared `types.ts`, because its bytes freeze) or `none` plus `**No types reason:**`; `**Acceptance tests:**` as `- path — FR-n, AS-n` lines naming NEW dedicated test files and only Requirements a test can decide; optional `**Supported domain:**` (the acceptance file holding the supported/unsupported table and laws as testcases); optional `**Entry point:**` (the production file the acceptance tests drive, such as a route or handler — declare it whenever a later Task builds it, so validation can refuse a claimant that would run before it exists); `**Statement:**` (the observable behavior and what is refused). Several contracts per feature are normal; a vertical slice with `**Types file:** none` carries the controls that must fail. Contracts need a verification manifest whose test check writes a JUnit report — if the project has none, say so in the plan so the operator installs it before population.

**These sections are parsed deterministically by a regex grammar — exact spelling matters.** Section headings must be `## Lifecycles`, `## Pipeline`, `## Invariants`, `## Contracts` — no suffixes, no colon (case is tolerated, but write them as shown). Block headings must be `### LC-<n>: <title>` / `### INV-<n>: <title>` / `### CT-<n>: <title>` (uppercase prefix, numeric id, colon). Field labels (`**Machine file:**`, `**AuthoredDag:**`, `**Tier:**`, `**Rule file:**`, `**Owner module:**`, `**Unowned reason:**`, `**Sibling entry points:**`, `**Matrix test:**`, `**Mutation exemption:**`, `**Types file:**`, `**No types reason:**`, `**Acceptance tests:**`, `**Supported domain:**`, `**Entry point:**`, `**Statement:**`) start at column 0 with the colon inside the bold, never bulletized; only the sibling and acceptance-test entries below their label are `- ` list lines. Declare machine-file paths repo-relative. Close every code fence — an unterminated fence hides everything after it. Near-miss variants are rejected by validation, not silently ignored — but don't make it guess.

Most features need none of these sections. A CRUD endpoint has no lifecycle; two sequential steps are not a pipeline. When in doubt, leave the section out — `validate-task-graph` fail-closes on declared-but-unbound models and near-miss declarations, not on absent sections.

### 6. Write the Plan Document

**Output location:** `.claude/plans/{date_slug}.md`

Read `references/plan-template.md` from the loom plugin dir (`$LOOM_DIR`, resolved above) and follow its structure.

**Required sections** (decompose agent parses these):

| Plan Section | What Decompose Extracts |
|---|---|
| **File Structure** | `file_list` per task |
| **Component Design** | Task `description` + boundary definitions |
| **Implementation Phases** | `wave` ordering + `depends_on` |
| **Architectural Decisions** | `plan_context` quoted to impl agents |
| **Testing Strategy** | Independent regression/new-test Verification Policy per component |
| **Lifecycles** (opt-in) | Dedicated machine-file task per LC-N; dependents wired to it |
| **Pipeline** (opt-in) | Codegen task + one node-body task per node |
| **Invariants** (opt-in) | No invariant tasks; owner-before-sibling ordering and the matrix test in the family's tasks (the engine renders each Task's ownership role into its brief) |
| **Contracts** (opt-in) | One contract task per CT-N writing the frozen types and acceptance tests, in an early Wave; every task completing a covered Requirement depends on it |

Record the chosen approach (and the interview decisions that shaped it) under `## Architectural Decisions` so future readers see WHY this approach won.

Commit: `git add .claude/plans/ && git commit -m "plan: {date_slug}"` — and when you wrote checkable-invariant rules, add them first with `git add .claude/linter/rules/`. Do NOT combine both paths in one `git add` unless both directories exist: a missing pathspec makes the whole `git add` fail, and the plan would silently go uncommitted.

**ADR seeds:** For decisions worth recording as ADRs (2+ alternatives evaluated, new dependency, data model change, cross-cutting pattern, or non-obvious invariant), ensure each is captured as a `### AD-N: <Title>` block in the plan's `## Architectural Decisions` section per `references/plan-template.md`. Decompose will turn each AD into a dedicated ADR-writing task in the final wave. The approach you picked at the gate is almost always one such AD. Skip ADs for trivial naming or file-placement choices. Do NOT write ADRs yourself in this phase.

---

## What NOT to Do

- Do NOT skip the interview or the approach gate. Both are mandatory.
- Do NOT write the plan first and gather user input retroactively.
- Do NOT skip interview topics for speed. The user explicitly wants the full questionnaire.
- Do NOT use the review process from your skill (no "Identify Testability Barriers" — there's no code to review yet)
- Do NOT produce review-format output (no "Issue/Impact/Root Cause" analysis)
- Do NOT write implementation code (that's impl agents' job)
- Do NOT design beyond spec scope (check Out of Scope section)

---

## Your Output Must Include

- Path to created plan file
- Implementation phases identified (count + names)
- Key architectural decisions with rationale (captured as `### AD-N` blocks in the plan)
- Which approach the user picked at the gate (and which you had recommended, if different)
- Executable models declared, if any: LC-N lifecycles (+ machine file paths), Pipeline AuthoredDag path, INV-N invariants (+ tier; rule file paths for checkable ones, with `validate-lint-rules` output; owner module, sibling count, matrix test and any mutation exemption with its reason — or the unowned reason), CT-N contracts (+ types file or reason, acceptance files and the Requirements each decides)

The architecture-agent has the `architecture-tech-lead` skill preloaded which provides FP, DDD, testability, and stack-specific domain knowledge. Use that knowledge to **design**, not to **review**.
