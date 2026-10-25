# Executable Models Only — Standing Policy

A standing policy the architecture, decompose, and implementation phases
follow whenever a feature contains a real lifecycle, pipeline, checkable
invariant, or test-decidable behavior contract. (Introduced by deterministic-core-convergence v2, "Phase C" — but
it is policy, not a feature, and outlives that plan.)

**The rule: a model either executes or it doesn't exist.** Descriptive models —
JSON or prose that code is "compared against" — are a second source of truth
with two-directional drift. They are never built. When the architecture phase
finds structure worth modeling, it lands in exactly one of three executable
forms:

| Structure found | Executable form | Enforced by |
|---|---|---|
| Lifecycle (order, payment, subscription, document workflow) | Statechart / typed reducer the implementation **imports and runs** | It *is* the code — drift is impossible |
| Pipeline (fetch → transform → LLM → review) | `AuthoredDag` sidecar; graph code **generated** by `fugue new --from`, never hand-written | fugue's `defineDag` validation + lint gauntlet |
| Checkable invariant | Lint rule JSON in `.claude/linter/rules/` | loom's linter, fail-closed at PostToolUse on every edit |
| Non-checkable invariant | Prose in the plan, tiered `advisory` | Nothing — and the plan says so honestly |
| Behavior contract (what a slice must do, decidable by a test) | Declarations-only types file + dedicated acceptance tests, written **before** the code and frozen | The Wave Gate: observed RED, then GREEN by Requirement, bytes frozen in between |

Everything else a model schema might capture (aggregate fields, command lists)
is what the type system already is. Types + `spec_anchors` cover it.

---

## 1. Lifecycles → running statecharts

When the architecture phase identifies a real lifecycle, the plan declares it
in a `## Lifecycles` section:

```markdown
## Lifecycles

### LC-1: Order lifecycle

**Machine file:** `src/domain/order/order-machine.ts`
**Kind:** typed-reducer
**States:** draft, submitted, paid, shipped, cancelled

| Event | From | To |
|---|---|---|
| submit | draft | submitted |
| pay | submitted | paid |
| ship | paid | shipped |
| cancel | draft, submitted | cancelled |
```

- `**Machine file:**` is required — a lifecycle without an executable machine
  is a descriptive model and fails `validate-task-graph`.
- `**Kind:**` is `typed-reducer` (default — no new dependency; a pure
  `transition(state, event)` function over closed unions, illegal transitions
  unrepresentable or rejected) or `xstate` (when the project already uses it).
- The states/transitions table is for humans and impl agents; the machine file
  is the source of truth the moment it exists.
- **Exact grammar**: these sections are regex-parsed. Headings
  `## Lifecycles` / `## Pipeline` / `## Invariants` / `## Contracts` with no
  suffix or colon (heading and label case is tolerated; block ids are
  uppercase-only); blocks `### LC-<n>: <title>` / `### INV-<n>: <title>` /
  `### CT-<n>: <title>` (numeric id, colon);
  labels at column 0 with the colon inside the bold. Machine-file paths are
  repo-relative. Near-miss variants, unterminated code fences, and declared
  sections with no blocks are validation errors ("stray model markers"),
  never silent opt-outs.

**Decompose** maps each `LC-N` to a dedicated task in the earliest possible
wave: implement the machine file plus property tests (no undeclared
transition is representable or accepted). Every other task that touches the
lifecycle depends on it.

**Implementation agents** import the machine. Re-implementing transition
logic, duplicating state-name string literals, or storing lifecycle state
outside the machine's types is a violation — pair the lifecycle with a
checkable invariant (below) where a lint rule can catch it.

## 2. Pipelines → the Fugue bridge (optional per feature)

Only when the project uses fugue AND the user opts in at the approach gate.
Loom and fugue stay uncoupled — the bridge is per-feature, never assumed.

The architecture phase authors a `dag.authored.json` (fugue's `AuthoredDag`
schema) next to the plan and declares it:

```markdown
## Pipeline

**AuthoredDag:** `.claude/plans/2026-07-02-orders.dag.authored.json`

| Node | Kind | Purpose |
|---|---|---|
| fetch-order | fetch | load order + line items |
| enrich | llm | classify fulfillment risk |
| review | human-review | approve high-risk orders |
```

- Loom validates the sidecar **structurally only** (exists, parses, has a
  `nodes` array). Deep validation belongs to fugue: `fugue new --from` runs
  the full codegen → `defineDag` → lint gauntlet. One pipeline per plan.
- **The LLM never hand-writes `defineDag`.** Graph code is always generated;
  agents only fill node *bodies* (fetch impls, `buildInput`, prompts — the
  imperative shell), constrained by the node's declared input/output schemas.
- If `fugue new --from` fails its gauntlet, the authored dag is defective —
  the failure is reported and routed back to the architecture phase; generated
  code is never hand-patched to pass.

**Decompose** emits a wave-1 task that runs `fugue new --from <sidecar>`
(deterministic codegen, both Verification Policy arms waived with `generated-artifact`), then one task per node
body, each depending on the codegen task, with the node's purpose and schemas
pasted into `plan_context`.

## 3. Invariants → lint rules (or honest prose)

The plan declares invariants in an `## Invariants` section, each tiered (the
order-domain paths below are illustrative):

```markdown
## Invariants

### INV-1: Order state literals only in the machine file

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-no-raw-order-states.json`
**Statement:** No file other than order-machine.ts may contain order-state string literals.

### INV-2: Refunds complete within 30 days

**Tier:** advisory
**Statement:** Business SLA — not deterministically observable from code.
```

- `checkable` invariants require a `**Rule file:**`. The **architecture phase
  itself writes the rule JSON** (regex rule format, see `lint-rules/README.md`)
  into the project rules dir — `.claude/linter/rules/`, or `.pi/linter/rules/`
  under the pi harness; the linter loads only from the harness-appropriate
  dir — so it is enforced fail-closed from the very first edit of wave 1,
  before any implementation agent runs. Filename and JSON `name` field share
  the same `inv-<n>-<slug>`. After writing rules, the architecture phase
  proves they load (`LOOM_DIR` = the loom plugin directory, resolved as
  `LOOM_DIR` resolved by the invoking Loom command from its own package root):

  ```bash
  bun "$LOOM_DIR"/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules
  # (.pi/linter/rules under the pi harness)
  ```

  Passing a nonexistent directory is an error — the proof step never treats a
  typo'd path as "no rules to check".

- `advisory` invariants stay prose. They are never enforced and never
  pretended to be — impl agents see them as design guidance, wave gates do
  not block on them. An advisory invariant that declares a rule file is a
  validation error (mis-tiered intent).
- A "checkable" invariant that can't actually be expressed as a rule is not
  checkable. Re-tier it `advisory` rather than writing a rule that doesn't
  test the real property.

### Invariant ownership (every invariant, whatever its tier)

Most repeated review rounds fixed one copy of a rule and missed the others.
So a rule enforced at two or more entry points is an invariant, and every
invariant names who owns it. The owned example below is Loom's own G5b
invariant (`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, INV-3,
statement abridged): every path it names exists in this repository. The
unowned INV-4 is **illustrative**: `src/domain/` and its rule file belong to
a hypothetical project, like the order domain of INV-1 and INV-2 above.

```markdown
### INV-3: Which owned Invariants a Wave or Task owes is decided only by obligations.ts

**Tier:** advisory
**Owner module:** `engine/src/core/owner-verification/obligations.ts`
**Sibling entry points:**
- `engine/src/core/owner-verification/suite-authority.ts` — authorizing the Wave's suite from the TaskGraph with `ownerCheckAuthority`; the gate helper and readiness both call it
- `engine/src/handlers/helpers/wave-completion-suite.ts` — the Wave's owed obligations (`ownerVerificationOwed`) that the owner check runs for
- `engine/src/core/wave-completion-suite-readiness.ts` — re-authorizing the suite roster through `suite-authority.ts`
- `engine/src/core/owner-verification/plan-integrity.ts` — the gate's drift check of plan against stamp (`stampAgreement`)
- `engine/src/state-file-wire.ts` — re-deriving the owner check from the stamp when a persisted receipt loads
- `engine/src/orchestration/owner-verification-runner.ts` — which owed obligations run mutants (`verifyOwed`)
- `engine/src/core/task-graph-population.ts` — which obligations need the frozen `affectedRunner` (`verifyOwed`)
- `engine/src/core/wave-review-authority.ts` — obligations a reviewed Task touches, which gate the owner-map section
- `engine/src/core/implementation-brief.ts` — obligations a Task touches, which drive the duty paragraph
**Matrix test:** `engine/tests/core/owner-obligations.matrix.test.ts`
**Statement:** Every call site that decides which Owner Obligations apply calls the obligations.ts selections over the opaque `OwnerScope` and never classifies roles inline; the State File wire parse re-derives the check authority from the stamp on purpose, because a receipt must not certify its own roster.

### INV-4: No console output in the domain (illustrative)

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-4-no-console-in-domain.json`
**Owner module:** none
**Unowned reason:** A prohibition; there is no implementation to home.
**Statement:** No file under src/domain/ writes to the console.
```

- `**Owner module:**` is required on every invariant. Owned: one path, the
  rule's only implementation. Unowned: `none` plus `**Unowned reason:**`.
- `**Sibling entry points:**` — every other entry point that applies the
  rule, as `- path — note` lines, or `none`.
- `**Matrix test:**` — the test that runs the rule through the owner and
  every sibling, so a divergent copy is caught.
- An unowned invariant may not carry sibling or matrix lines; an owned one may
  not carry an unowned reason. A malformed declaration is a validation error
  naming each problem — never a silent opt-out.
- **One invariant per rule.** A family with several rules (word
  normalization vs. command splitting) gets several invariants.
- **The statement defines scope**: it says which call sites the rule covers,
  so the sibling list can be judged complete.
- `**Mutation exemption:** <reason>` (optional, owned invariants only) opts
  the invariant out of mutation verification — see below. It must carry a
  non-blank reason, and it may not sit on an unowned invariant: validation
  (populate, repair and `validate-task-graph`) refuses either as malformed
  ownership (`exemption-without-reason`, `exemption-on-unowned`). Outside
  `## Invariants` the label is a stray, never ignored.

**Decompose** never creates invariant tasks, but an owned family shapes the
graph: a task changing a sibling depends on the task building the owner, and
any change to the family includes the matrix test. **The engine renders each
Task's role** — owner, sibling, matrix-test author — and the whole family into
its implementation brief from the plan, so the instruction does not depend on
a model copying plan text into `plan_context`.

### Owner verification at the Wave Gate (G5b)

Declaring an owner makes it an obligation the Wave Gate checks.

- **The stamp.** Population stamps every owned invariant into the TaskGraph
  as an **Owner Obligation** (`owner_obligations`: id, title, statement,
  owner, siblings, matrix test, mutation policy). The stamp is always
  written, `[]` included; only a graph populated before G5b lacks it, and such
  a graph owes nothing.
- **Plan integrity.** Whenever the graph carries the stamp, the completion
  suite gains the engine-reserved check `loom:owner-verification`. It re-reads
  the plan the graph names and blocks when there is no `plan_file`, the plan
  is unreadable, it has strays or malformed ownership, or the obligations it
  derives differ from the stamp (`plan-drift`: re-populate, or restore the
  plan). This runs even in a Wave that owes nothing.
- **Which invariants are checked.** Exactly the owned invariants whose family
  the Wave changed: some Wave Task's `file_list` holds the owner or a
  sibling. A change to the matrix test alone does not trigger the checks.
  Unowned invariants are never checked. One module decides this
  (`core/owner-verification/obligations.ts`).
- **Sibling coverage.** The matrix test's direct imports — static `import`,
  side-effect imports, `import x = require`, string-literal `import()` and
  `require()` — plus everything reached through `export … from` re-exports,
  resolved to files through relative paths (the extension
  ladder `""`, `.ts`, `.tsx`, `.mts`, `.cts`, a `.js`-family specifier mapped
  to its TypeScript source, then `index.ts`/`index.tsx`) and the matrix test's
  tsconfig `paths`, must include the owner and every declared sibling. A
  plain import chain is followed one hop only: siblings import the owner, so
  following them would make the owner "reached" through any sibling. A miss
  blocks, naming every missing path, owner first. Bare package specifiers
  reach nothing; a frontier of more than 512 files is an infrastructure
  failure.
- **Mutation verification.** The owner's lines changed in the Wave — against
  the `start_sha` of the Wave Tasks listing the owner, or their octopus
  merge-base — are mutated by six fixed operators: condition negation,
  comparison flip, logical swap, boolean-literal flip, return-value
  replacement (`return undefined`) and expression-statement removal. Sites
  are found with the TypeScript compiler API; the set is deterministic, at
  most 24 per invariant (evenly spaced over the candidates, the rest
  reported as unmutated). Each mutant runs in one detached git worktree per
  invariant (HEAD plus every uncommitted, untracked and deleted path of the
  real workspace, `node_modules` shared by symlink) through the frozen
  manifest's `affectedRunner`, with the matrix test as its only file and a
  time limit of 60 s clamped to the runner's own timeout. The matrix test
  must first pass unmutated: a red baseline blocks and runs no mutant. The
  runner's JUnit report decides each mutant: a failing testcase kills it, a
  timeout kills it, only collection errors make it invalid, a passing report
  means it survived. Any survivor blocks. A missing, unreadable or empty
  report, a spawn failure, or a passing report with a non-zero exit is an
  infrastructure failure that blocks and is never a kill. The real workspace
  is digested before and after, and any difference blocks
  (`real-workspace-changed`).
- **The runner.** Mutation verification needs a schema-2 verification
  manifest with an `affectedRunner` writing JUnit. Population refuses a plan
  with a non-exempt owned invariant and no such runner
  (`owner-verification-runner-missing`). An exempt invariant needs none.
- **Mutation exemption.** It disables only the mutation half; coverage still
  runs, and the exemption and its reason are recorded in the verdict and in
  status.
- **Where it shows.** The implementation brief of every Task that touches the
  family (as owner, sibling or matrix-test author) states the coverage duty
  and the mutation duty, or names the exemption. `helper orchestration
  status` reports each invariant's coverage and mutant counts, or the
  exemption, and a blocked gate's next action names the invariant and the
  remedy.

### The second-copy lens (G5b)

A Wave review packet for the code-reviewer and the architecture-tech-lead,
for a Task that touches an owned family, carries an engine-issued **owner
map**: each touched invariant's id, title, statement, owner, siblings, matrix
test and `<plan file>#INV-N` contract, then the fixed second-copy rule. The
section is inside the packet digest. The rule: a diff that implements a
declared-owned invariant's predicate outside its owner is a finding citing
`<plan file>#INV-N`; it is critical when the copy diverges from the owner on
some input (that input is the consequence), advisory when it is behaviorally
identical. Severity rules and the Refutation Panel apply unchanged. Packets
for the other roles, for Tasks touching no owned family and for standalone
reviews are byte-identical to what they were.

## 4. Contracts → frozen acceptance tests (contracts before code)

An LLM implementer that writes its own tests after its own code grades its own
homework: the tests encode whatever the code happens to do. A contract moves
the decision earlier. One task writes the surface consumers import and the
tests that decide the behavior, the engine proves those tests fail, freezes
them, and only then do other tasks write the code that turns them green.

```markdown
## Contracts

### CT-1: Payload submission

**Types file:** `src/payload/payload-contract.ts`
**Acceptance tests:**
- `tests/payload.acceptance.test.ts` — AS-001, FR-002
**Supported domain:** `tests/payload.acceptance.test.ts`
**Entry point:** `src/payload/submit-route.ts`
**Statement:** One valid call wins; a second call is refused with AlreadySubmitted.

### CT-2: Submission slice

**Types file:** none
**No types reason:** The slice consumes CT-1's surface.
**Acceptance tests:**
- `tests/submission.acceptance.test.ts` — AS-004
**Statement:** End to end, an unauthenticated submission is refused.
```

- `**Types file:**` — a NEW file holding declarations only: types, sealed
  ADTs, the function signatures consumers import. Never an implementation file
  or a shared `types.ts`: its bytes freeze. Or `none` with a
  `**No types reason:**`.
- `**Acceptance tests:**` — NEW, dedicated test files, one `- path — FR-n,
  AS-n` line each, naming only Requirements a test can decide. Every testcase
  is named after the Requirement it decides (`AS-001: one call wins`); the
  name prefix is how the engine attributes a testcase to its Requirement.
- `**Supported domain:**` (optional) — the acceptance file whose testcases
  hold the supported/unsupported input table and the relevant laws.
- `**Entry point:**` (optional) — the production file the acceptance tests
  reach the code through: a route, a handler, a CLI command. Not a frozen path.
  Plan validation refuses a Task that claims a covered Requirement but neither
  writes the entry point nor depends, directly or transitively, on a Task that
  does — its tests could not pass before the entry point exists. The contract
  Task never counts as its writer (it lists at most a stub). Declare it
  whenever the tests drive the code through something a later Task builds.
- `**Statement:**` — the observable behavior, and what is refused.

**The lifecycle the engine enforces:**

1. **Population** persists each contract as an Acceptance Contract with its
   one contract Task (the only Task writing every frozen path) and freeze state
   `awaiting-red`. A plan with contracts is refused unless the verification
   manifest has a project check that writes a JUnit report — the only way RED
   and GREEN can be observed.
2. **The contract Wave's gate expects RED.** Every acceptance testcase must be
   collected (a file that fails to load is not a behavioral RED) and FAIL, and
   nothing outside the acceptance files may fail. Each testcase must name a
   covered Requirement, and each covered Requirement must have a testcase. The
   accepted gate stamps the **Acceptance Freeze**: the sha256 of every frozen
   path and the roster of testcases it observed red. The stamp lands at
   completion, after the advisory decision, so status lists the advisories on
   frozen paths at that pause (`acceptance-freeze-pending`). Fix the relevant
   ones by re-dispatching the contract Task before approving; afterwards, only
   a Contract Revision can change those bytes.
3. **Red window.** A testcase is *pending* until the Wave completing all its
   Requirements, and *due* from then on. A pending testcase's failure is
   excused only at the Wave Gate — never in a task's own run. So every task
   from the contract Wave through the last Wave completing a covered
   Requirement that has no regression waiver of its own (an authored waiver
   is kept) gets the engine-only regression waiver `acceptance-red-window`,
   and the Wave Gate's engine-run suite (which knows what is pending) is their
   regression authority. Every other failure still fails the gate.
4. **Claimant Waves expect GREEN by Requirement.** Each due testcase must be
   present and passing; a roster testcase that no longer runs fails the gate.
   With an `acceptanceRunner` in the verification manifest (schema 2), each
   claimant meets this earlier: the **Acceptance Stop Check** runs its owed
   testcases when its agent stops and keeps that agent working while one
   fails (`docs/operations.md`). It is advisory to the gate, never evidence.
5. **Frozen means frozen.** Every gate re-hashes the frozen paths before it
   reuses or installs a suite receipt; any drift blocks as an artifact
   failure. Task byte-scope proof already stops a task writing a path outside
   its `file_list`, and only the contract task lists the frozen paths.
6. **Contract Revision** is the one way to change frozen bytes: the operator
   edits them and runs `helper revise-contract --contract CT-n --reason "…"`.
   It is refused while a Wave Gate is live, before the freeze, before the
   contract Wave completes, while implementation is reserved, and while any
   claimant sits in a completed Wave (reopen that Wave first). It re-stamps
   the bytes, clears the roster so the next gate re-records it green, appends
   an audited revision, returns the current Wave's implemented claimants to
   revalidation, and retires the current Wave's review and suite authority.

**Decompose** creates one contract task per `CT-N` (rule 12 of the decompose
template); claimants depend on it and may waive new tests with
`covered-by-acceptance-contract`. **The engine renders each Task's role** — the
contract task's write-the-surface-and-stubs instructions, a claimant's frozen
paths and the testcases it must turn green, a red-window task's note about
pending failures — into its brief.

---

## Enforcement points (deterministic, wired)

1. **`validate-task-graph`** (Phase 4a) cross-checks bindings fail-closed:
   every `LC-N` machine file appears in some task's `file_list`; the
   `AuthoredDag` sidecar exists, is structurally sound, AND every node named in
   the plan's `## Pipeline` table appears in the sidecar (a plan node absent
   from the sidecar is plan↔sidecar drift — the gate blocks it here rather than
   letting it reach fugue runtime; checked against the exact non-empty `id` of
   each node object, the narrow identity boundary Loom needs while Fugue retains
   ownership of deeper DAG-shape validation);
   every checkable `INV-N` rule file exists and is rule-shaped; every `INV-N`
   declares well-formed ownership, and an owned one's owner, siblings and
   matrix test each exist on disk or appear in a task's `file_list` (only
   ENOENT reads as absent), each path has one role, a task touching the family
   comes with a task touching the matrix test, and sibling tasks depend on the
   owner's task; near-miss declarations (typo'd headings/labels) are errors;
   an unreadable `plan_file` is an error, never a skipped check.
2. **`populate-task-graph`** — the only whitelisted helper that populates
   tasks into `active_task_graph.json` — runs the same binding checks before
   any state write, resolving the plan path from evidence-derived state
   (`plan_file`, else the recorded architecture phase artifact) in preference
   to the decompose payload, and persists the same path it validated. The 4a
   run advises the orchestrator; this one is the gate.
3. **`validate-lint-rules`** proves invariant rules load through the linter's
   fail-closed loader (malformed JSON, missing fields, ReDoS-unsafe patterns
   all fail) before implementation starts.
4. **PostToolUse `lint-file`** enforces checkable invariants on every edit,
   forever — they outlive the feature that introduced them.
5. **`complete-wave-gate`** verifies as evidence that every lifecycle machine
   file bound to a completing wave's tasks actually exists on disk — the
   decompose-time promise is re-checked when the wave claims it delivered.
   The plan is resolved from state `plan_file`, falling back to the recorded
   architecture phase artifact; a named-but-unreadable plan fails the gate.
   Only when state carries neither (legacy flows that never ran the
   architecture phase) is the check skipped, and it says so.
6. **The Wave Gate's completion suite** judges every Acceptance Contract the
   Wave owes something (RED in the contract Wave, GREEN by Requirement after),
   stamps the Acceptance Freeze from the accepted receipt in the same locked
   write, and blocks on frozen-path drift before reusing any receipt.
   Whenever the TaskGraph carries `owner_obligations`, the same suite runs
   `loom:owner-verification`: the plan re-read, then sibling coverage and
   mutation verification for each owned invariant whose family the Wave
   changed (see "Owner verification at the Wave Gate").

## Known residuals (honest limits)

- **Sibling completeness is declared, not proven.** Validation checks that
  every declared path is real and correctly ordered; it cannot know an entry
  point the plan forgot. Plan alignment (`OWN-N`) and review catch omissions.
  Sibling coverage proves the matrix test imports every *declared* entry
  point, and mutation verification proves it kills mutants of the owner; a
  forgotten entry point stays invisible to both.
- **An import is not proof of exercise.** Sibling coverage is a static import
  check: a matrix test that imports a sibling but never calls it through the
  rule passes coverage. Only imports that load the module count: a type-only
  import or re-export (`import type`, `export type … from`, every specifier
  `type`) is erased at runtime and reaches nothing. Mutation verification mutates the owner only, never a
  sibling, so a sibling that bypasses the owner is caught only by a matrix
  test that really drives it — and by the second-copy lens in review.
- **Mutation covers the owner's changed lines only.** Unchanged owner lines,
  siblings and every other file are never mutated, and a Wave that changed
  only a sibling runs the baseline but zero mutants (`owner unchanged in
  Wave`). Only constructs the six fixed operators can rewrite count; at most
  24 mutants run per invariant and the rest are reported as unmutated.
- **Invalid mutants are neither killed nor survived.** A mutant whose run
  shows only collection or import errors is counted `invalid`, and the
  verdict and status report the invalid count. A run whose every generated
  mutant is invalid carries no mutation evidence, so it blocks as the
  `no-valid-mutants` infrastructure failure rather than passing.
- **A matrix-test-only change triggers nothing.** The checks run when the Wave
  changed the owner or a sibling; a Wave touching only the matrix test owes
  no coverage or mutation run (the plan is still re-read).
- **The second-copy lens is review judgment.** Whether a copy diverges or is
  identical is the reviewer's call, checked by the Refutation Panel; an
  identical copy is advisory, so it does not block a Wave by itself.
  Standalone reviews carry no owner map at all: there is no TaskGraph to read
  obligations from, and there is no repository-wide owner registry.
- **"The matrix test exists" is not "the matrix test is complete".** A test
  that covers only well-formed input still satisfies the path check; mutation
  verification narrows this only for the owner's changed lines.
- **RED/GREEN is not discrimination.** A frozen acceptance test that a wrong
  implementation also passes still turns green. G5b's mutation verification
  runs against owned invariants' matrix tests, not against frozen acceptance
  tests, so this residual stands for contracts.
- **Mutation evidence is JUnit only.** The `affectedRunner` report is read as
  JUnit; testcases are attributed to the matrix test by reported file. A
  runner writing another format makes every run an infrastructure failure.
- **The family-site metric is a gauge.** `helper family-sites` counts line
  regex hits per known family outside its owners; a pattern can miss a
  reworded copy or count an innocent line. It blocks nothing.
- **Acceptance is observed through JUnit only.** Testcases are attributed by
  file (Vitest's relative `classname`, or a JVM class name) and by the
  `FR-n:`/`AS-n:` name prefix; a report in another format cannot carry a
  contract.
- **A non-zero exit is excused from the report alone.** The gate excuses a
  check's non-zero exit when every failing testcase in its JUnit report is a
  RED or pending acceptance testcase. A cause that never appears as a failing
  testcase — a coverage threshold, a chained lint or typecheck step, a crash
  after the report was written — is invisible to that judgment and would be
  absorbed. So the test runner must be its own project check, or the last
  step of one, with no thresholds that fail the exit code: then the report
  accounts for every way the exit can go non-zero. A runner followed by
  other steps also stops at the failing test step in the contract Wave, so
  those later steps would go unobserved there.

- **Import discipline is advisory-plus-lint.** "Dependents import the machine,
  never re-implement transitions" is enforced only where a paired checkable
  invariant (e.g. a no-raw-state-literals rule) can catch the violation;
  otherwise it is prompt guidance verified by wave-gate reviewers, not by the
  deterministic core. Mandating auto-generated rules from state lists is
  future work.
- **Generated-code STRUCTURE hand-edit protection is tamper-EVIDENT (integrity hash).**
  `fugue new --from` stamps each generated `dag.ts` with a banner whose
  `@fugue-integrity sha256:<hex>` covers the STRUCTURAL PROJECTION of the body —
  the generated body with each `@fugue-body-start … @fugue-body-end` region
  collapsed. So the machine-owned structure (imports, schemas, node ids, wiring,
  registration) is hashed, but the placeholder node bodies the scaffold tells you
  to implement live inside `@fugue-body` regions and are EXCLUDED — implementing
  them leaves the hash intact (no false positive on the sanctioned workflow).
  Loom ships the `fugue-generated-integrity` programmatic lint rule, which runs
  in the "full"/wave-gate tier ONLY (programmatic rules do not run on
  PostToolUse `lint-file` — that tier is regex-only), recomputes the hash over
  the same projection, and blocks on a mismatch, so a structural hand-edit during
  a loom wave is caught at the wave gate — the same detection-at-gate mechanism as
  every other lint rule, needing no path-based edit gate (which loom's model does
  not have). The tamper-evidence window is a wave, not a single tool call. The
  coupling is the marker convention (`@fugue-integrity sha256:` + the two
  `@fugue-body` strings + the collapse rule): fugue stamps it, loom verifies it,
  neither imports the other. Residual (honest): the target is an ACCIDENTAL
  structural edit. Removing the banner outright, or wrapping hand-edited structure
  in fake `@fugue-body` markers, both disable the check for that file and are
  equivalent deliberate circumventions — but `--from --force` regeneration
  overwrites the edit (a fixed point). Fugue itself does not re-verify the stamp;
  the detection lives in loom's rule.
- **Wave-gate artifact verification is existence, not semantics.** The machine
  file must exist; that it exports a real reducer is verified by its property
  tests and the trusted test-evidence machinery, not by the gate. An empty
  file at the declared path passes the gate and fails at test evidence.
- **Report artifacts are agent-writable.** A trusted-pass verdict rests on a
  report artifact (vitest JSON / JUnit XML) that the agent's own tools can
  write. The recorder rejects an explicit `--outputFile` path that appears as
  a `FileWrite` in the agent's own epoch (loudly) — Edit/Write tool calls AND
  Bash redirect/`tee` targets both mint `FileWrite`, including targets of the
  very command line being judged — and report freshness is call-scoped: a
  disk artifact may vouch only when its mtime is at/after the START of the
  tool call being judged (the PreToolUse call-start stamp orders it), so a
  previous-epoch or pre-staged artifact fails the ordering check. The
  remaining residuals (see machines/README.md "known residual limits") are
  same-call staging via a Bash write with no static target in the command
  text (`cp`/`mv`, `dd of=`, an interpreter-authored file via
  `python -c 'open(...)'`) and a "test" script that itself emits runner-shaped
  JSON. Full integrity (HMAC / out-of-reach storage) is the known follow-up.

## What NOT to do

- No `BehavioralModel` JSON, no `validate-model-alignment` structural diffing
  — not even "lightweight structural checks". If it doesn't run, it drifts.
- No modeling for its own sake. A CRUD endpoint has no lifecycle; a feature
  with two sequential steps is not a pipeline. Sections absent = policy
  satisfied trivially.
- No pretending. If enforcement is advisory, the plan says `advisory`.
- No loom↔fugue coupling. No fugue in the project → no Pipeline section.
