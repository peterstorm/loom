# Executable Models

The policy and plan grammar the architecture phase follows when a feature contains a real lifecycle, pipeline, invariant or test-decidable behavior contract. Decompose and implementation agents act on what the plan declares here.

**The rule: a model either executes or it does not exist.** A descriptive model (JSON or prose that code is "compared against") is a second source of truth that drifts in both directions, so it is never built. Structure worth modeling takes one of the executable forms in this table:

| Structure found | Executable form | Enforced by |
|---|---|---|
| Lifecycle (order, payment, subscription, document workflow) | Statechart or typed reducer the implementation **imports and runs** | It is the code |
| Pipeline (fetch → transform → LLM → review) | `AuthoredDag` sidecar; graph code **generated** by `fugue new --from`, never hand-written | fugue's `defineDag` validation and lint gauntlet |
| Checkable invariant | Lint rule JSON in the project's rules directory | Loom's linter, fail-closed on every edit |
| Non-checkable invariant | Prose in the plan, tiered `advisory` | Nothing, and the plan says so |
| Behavior contract (what a slice must do, decidable by a test) | Declarations-only types file plus dedicated acceptance tests, written **before** the code and frozen | The Wave Gate: observed failing, then passing by Requirement, bytes frozen in between |

Anything else a model schema might capture (aggregate fields, command lists) is what the type system already is.

Most features need none of these sections. An absent section satisfies the policy.

`$LOOM_DIR` is the package root your prompt gives you.

How the engine enforces these declarations, and what that enforcement cannot see, is in `docs/executable-models-enforcement.md`. You do not need it to write a plan.

---

## Grammar rules for every section

The model sections are parsed by a regex grammar.

- Section headings are exactly `## Lifecycles`, `## Pipeline`, `## Invariants`, `## Contracts`: no suffix, no colon.
- Block headings are `### LC-<n>: <title>`, `### INV-<n>: <title>`, `### CT-<n>: <title>`: uppercase prefix, numeric id, colon.
- Field labels start at column 0 with the colon inside the bold (`**Machine file:**`), never as bullets. Only the entries under `**Sibling entry points:**`, `**Acceptance tests:**` and `**Export bindings:**` are `- ` list lines.
- Paths are repo-relative.
- Close every code fence. An unterminated fence hides everything after it.
- A near-miss heading or label, a label in the wrong section, and a declared section with no blocks are validation errors ("stray model markers"), never silent opt-outs.

---

## 1. Lifecycles

Declare a real domain lifecycle in a `## Lifecycles` section:

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

- `**Machine file:**` is required. A lifecycle without an executable machine is a descriptive model and fails `validate-task-graph`.
- `**Kind:**` is `typed-reducer` (the default: a pure `transition(state, event)` over closed unions, with illegal transitions unrepresentable or rejected, and no new dependency) or `xstate` (when the project already uses it).
- The states and transition table are for readers. Once the machine file exists, it is the source of truth.

Decompose gives each `LC-N` its own task in the earliest possible wave (the machine file plus property tests proving no undeclared transition is representable or accepted), and every other task touching the lifecycle depends on it. Implementation agents import the machine. Re-implementing transitions, duplicating state-name literals or storing lifecycle state outside the machine's types is a violation; pair the lifecycle with a checkable invariant where a lint rule can catch it.

## 2. Pipelines

Only when the project already uses fugue and the user opted in during the architecture interview (its executable-models topic). Loom and fugue stay uncoupled: the bridge is chosen per feature and never assumed.

Write a `dag.authored.json` (fugue's `AuthoredDag` schema) next to the plan and declare it:

```markdown
## Pipeline

**AuthoredDag:** `.claude/plans/2026-07-02-orders.dag.authored.json`

| Node | Kind | Purpose |
|---|---|---|
| fetch-order | fetch | load order + line items |
| enrich | llm | classify fulfillment risk |
| review | human-review | approve high-risk orders |
```

- One pipeline per plan.
- Loom checks the sidecar structurally only: it exists, parses, has a `nodes` array, and contains every node the table names. Deep validation is fugue's: `fugue new --from` runs codegen, `defineDag` and its lint gauntlet.
- Nobody hand-writes `defineDag`. Graph code is generated; agents fill only node bodies (fetch implementations, `buildInput`, prompts), bound by the node's declared input and output schemas.
- If `fugue new --from` fails, the authored dag is defective. The failure goes back to the architecture phase; generated code is never patched by hand to pass.

Decompose emits a wave-1 task that runs `fugue new --from <sidecar>` and one task per node body depending on it.

## 3. Invariants

Declare invariants in an `## Invariants` section. Each has a tier and names its owner:

```markdown
## Invariants

### INV-1: Order state literals only in the machine file

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-no-raw-order-states.json`
**Owner module:** none
**Unowned reason:** A prohibition; there is no implementation to home.
**Statement:** No file other than order-machine.ts may contain order-state string literals.

### INV-2: Refunds complete within 30 days

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A business SLA that code cannot observe.
**Statement:** Every refund completes within 30 days of the request.

### INV-3: Order totals are computed only by pricing.ts

**Tier:** advisory
**Owner module:** `src/domain/order/pricing.ts`
**Sibling entry points:**
- `src/api/checkout-route.ts` — prices the cart before payment
- `src/jobs/invoice-job.ts` — prices the order when it invoices
**Matrix test:** `tests/order/pricing.matrix.test.ts`
**Statement:** Every call site that needs an order total calls priceOrder from pricing.ts and never sums line items itself.
```

### Tiers

- **`checkable`** needs a `**Rule file:**`. You write the rule JSON yourself, in the regex rule format of `$LOOM_DIR/lint-rules/README.md`, into the project's one rules directory: `.claude/linter/rules/`, which both harnesses read (`.pi/linter/rules/` only in a Pi-only project that has no `.claude/linter/rules/`; never both). The filename and the JSON `name` field are the same `inv-<n>-<slug>`. The rule is then enforced from the first edit of wave 1. After writing rules, prove they load:

  ```bash
  bun "$LOOM_DIR"/engine/src/cli.ts helper validate-lint-rules
  ```

  With no argument it validates the project's rules directory. Naming a directory that does not exist is an error.
- **`advisory`** stays prose. It is never enforced and never presented as enforced. An advisory invariant that declares a rule file is a validation error.
- An invariant a rule cannot actually express is not checkable. Tier it `advisory` instead of writing a rule that tests something else.

### Invariant ownership

A rule the design applies at two or more entry points is an invariant, and every invariant, whatever its tier, says who owns it.

- `**Owner module:**` is required. Owned: one path, the rule's only implementation. Unowned: `none` plus `**Unowned reason:**` (a prohibition and a business SLA are reasons; "spread across modules" is a missing owner).
- `**Sibling entry points:**` lists every other entry point that applies the rule, as `- path — note` lines, or `none`.
- `**Matrix test:**` names the test that runs the rule through the owner and every sibling, so a divergent copy is caught.
- An unowned invariant carries no sibling or matrix lines; an owned one carries no unowned reason.
- **One invariant per rule.** A family with several rules (word normalization and command splitting, say) gets several invariants.
- **The statement defines scope.** It says which call sites the rule covers, so the sibling list can be judged complete.
- Every declared path must exist or be created by a task. A task changing a sibling depends on the task building the owner, and any change to the family includes the matrix test.

### Designing for owner verification

At the Wave Gate of any Wave that changes the owner or a sibling, the engine checks two things about each owned invariant. Design the matrix test for both.

- **Sibling coverage.** The matrix test must import the owner and every sibling, directly or through `export … from` re-exports. A type-only import does not count, and importing a module that merely imports the owner does not count.
- **Mutation verification.** The matrix test must pass, and then fail for every mutant of the owner's lines changed in that Wave. So write it to fail when the owner's rule changes, not merely to call the rule. This needs a schema-2 `.loom/verification-manifest.json` with an `affectedRunner` that writes JUnit; population refuses the plan without one, so say so in the plan when the project lacks it.
- **Timing.** The gate judges the matrix test as that Wave leaves it. Siblings may land Wave by Wave if each of those Waves updates the matrix test, and the matrix test must land no later than the first Wave that changes the owner or a sibling.
- **`**Mutation exemption:** <reason>`** (optional, owned invariants only) skips the mutation half; sibling coverage still runs. The reason is mandatory and is recorded in the brief, the gate verdict and status. A blank or placeholder reason (`none`, `n/a`, `tbd`, `todo`, `-` and the like), or the label on an unowned invariant, is malformed ownership and validation refuses the plan. Use it only when the owner's changed lines cannot be meaningfully mutated (timing-only code, say), never to excuse a weak matrix test.

Decompose creates no invariant tasks. The engine renders each Task's role (owner, sibling, matrix-test author) into its implementation brief from the plan.

## 4. Contracts

A contract fixes behavior before the code exists. One task writes the surface consumers import and the tests that decide the behavior; the engine proves those tests fail, freezes them, and only then do other tasks write the code that turns them green. Declare one for each feature slice whose observable behavior a test can decide:

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

- `**Types file:**` is a NEW file holding declarations only: types, sealed ADTs, the function signatures consumers import. Never an implementation file or a shared `types.ts`, because its bytes freeze. Or `none` with a `**No types reason:**`.
- `**Acceptance tests:**` lists NEW, dedicated test files, one `- path — FR-n, AS-n` line each, naming only Requirements a test can decide (measured or calibration Requirements stay off). Name every testcase after the Requirement it decides (`AS-001: one call wins`); the engine attributes testcases by that prefix.
- `**Supported domain:**` (optional) names the acceptance file whose testcases hold the supported and unsupported input table and the relevant laws.
- `**Entry point:**` (optional) names the production file the acceptance tests reach the code through: a route, a handler, a CLI command. Declare it whenever a later Task builds it. Validation then refuses a Task that claims a covered Requirement but neither writes the entry point nor depends on a Task that does.
- `**Statement:**` gives the observable behavior and what is refused.
- Several contracts per feature are normal. A vertical slice with `**Types file:** none` carries the controls that must fail.
- Contracts need a verification manifest whose test check writes a JUnit report, with the test runner as its own check or the last step of one. Say so in the plan when the project has none, so the operator installs it before Tasks are populated.

Decompose creates one contract task per `CT-N` in an early Wave, and every task completing a covered Requirement depends on it. The frozen bytes change afterwards only through an operator Contract Revision.

## 5. Export bindings

A contract with a types file can also fix where its signatures are implemented. In `## File Structure`, bind each NEW implementation file to the exports it provides:

```markdown
**Export bindings:**
- `src/payload/submit.ts` — CT-1: submitPayload: SubmitPayloadFn
- `src/main/java/com/acme/payload/Submit.java` — CT-3: submitPayload: SubmitPayloadFn
```

The engine writes each bound file as a skeleton (the frozen imports plus one export per binding whose body throws `unimplemented: <name>`) before its Task's agent starts, writes the contract's stubs itself when the contract Task stops, and refuses completion while a bound export is deleted, renamed, retyped or still unimplemented.

- **Placement.** A column-0 `**Export bindings:**` label directly under a File Structure group's fenced block, outside any fence. Anywhere else the label is a `misplaced-label` stray.
- **Line shape.** `` - `path` — CT-n: name: Alias, name: Alias ``: the backticked repo-relative path, a dash, one contract id, then comma-separated `name: Alias` entries. Each name and alias is an identifier (`^[A-Za-z_][A-Za-z0-9_]*$`) and no TypeScript or Java reserved word.
- **Name collisions.** On a TypeScript binding no name may equal an alias on its own line (`name-collides-with-alias`). On a Java binding a name may reuse an alias, but no alias may equal the file's own class name (`alias-collides-with-class`).
- **One contract per file.** A file is bound on exactly one line, to exactly one contract. The same path under two contracts is refused as multi-contract, and twice under one contract as a duplicate. A file that needs functions of two contracts is two files.
- **What an alias must be.** Declared by that contract's types file: in TypeScript a non-generic function type alias; in Java a non-generic interface with exactly one abstract, non-generic method, nested in the holder. The contract must declare a types file (not `none`). A missing, non-function or generic alias blocks the holder's spawn, so put the signature in the types file.
- **Who holds a bound path.** A non-contract Task's `file_list`, normally the one Task that implements it. Every Task listing it depends, directly or transitively, on the contract Task, and none waives regression as `documentation-only` or `generated-artifact`. Never the contract Task.
- **Languages.** TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`) and Java under a `src/main/java/` root get skeletons. Any other bound path is accepted and reported "unsupported language, no skeleton".
- **Java holder shape.** A Java contract's types file has exactly one top-level `public` interface or `final class` (the holder), and every functional interface, sealed interface and record the contract shares is nested inside it. Any other shape is refused with a named diagnostic.
- **Bind only consumer-facing signatures.** Helpers, extra exports and module structure stay the implementer's choice; binding them freezes guesses.

### Frozen ADTs

Every algebraic data type that crosses a module boundary is declared once, in the contract's types file. There it is a frozen ADT: a TypeScript discriminated union or branded type, or a Java sealed interface, record or permitted variant. Implementation files use it and never redeclare it.

Completion refuses a production file that declares its own type named like a frozen ADT or one of its variants (`shadows frozen ADT`), and a local union or sealed hierarchy that re-declares two or more of a frozen ADT's variants (`re-lists frozen variants`). The remedy is the frozen type itself, or a narrowing such as `Extract<FrozenUnion, { kind: "a" } | { kind: "b" }>`. So put every shared ADT in the types file, and plan no Task that "adds its own copy" of one. Test files are exempt, and a `**Types file:** none` contract has no frozen ADTs.

---

## What NOT to do

- No `BehavioralModel` JSON and no structural diffing of a model against code, not even a lightweight check. If it does not run, it drifts.
- No modeling for its own sake. A CRUD endpoint has no lifecycle; a feature with two sequential steps is not a pipeline.
- No pretending. If enforcement is advisory, the plan says `advisory`.
- No loom↔fugue coupling. No fugue in the project means no Pipeline section.
