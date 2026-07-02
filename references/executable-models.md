# Executable Models Only — Standing Policy

Phase C of deterministic-core-convergence v2. This is not a feature — it is a
standing policy the architecture, decompose, and implementation phases follow
whenever a feature contains a real lifecycle, pipeline, or checkable invariant.

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

**Decompose** maps each `LC-N` to a dedicated task in the earliest possible
wave: implement the machine file plus property tests (no event sequence
reaches a terminal state through an undeclared transition). Every other task
that touches the lifecycle depends on it.

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
  the full codegen → `defineDag` → lint gauntlet.
- **The LLM never hand-writes `defineDag`.** Graph code is always generated;
  agents only fill node *bodies* (fetch impls, `buildInput`, prompts — the
  imperative shell), constrained by the node's declared input/output schemas.

**Decompose** emits a wave-1 task that runs `fugue new --from <sidecar>`
(deterministic codegen, `new_tests_required: false`), then one task per node
body, each depending on the codegen task, with the node's purpose and schemas
pasted into `plan_context`.

## 3. Invariants → lint rules (or honest prose)

The plan declares invariants in an `## Invariants` section, each tiered:

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
  into the project's `.claude/linter/rules/` — so it is enforced fail-closed
  from the very first edit of wave 1, before any implementation agent runs.
  After writing rules, the architecture phase proves they load:

  ```bash
  bun ${LOOM_DIR}/engine/src/cli.ts helper validate-lint-rules
  ```

- `advisory` invariants stay prose. They are never enforced and never
  pretended to be — impl agents see them as design guidance, wave gates do
  not block on them.
- A "checkable" invariant that can't actually be expressed as a rule is not
  checkable. Re-tier it `advisory` rather than writing a rule that doesn't
  test the real property.

---

## Enforcement points (deterministic, already wired)

1. **`validate-task-graph`** (Phase 4a) cross-checks bindings: every `LC-N`
   machine file appears in some task's `file_list`; the `AuthoredDag` sidecar
   exists and is structurally sound; every checkable `INV-N` rule file exists
   and is rule-shaped. A declared-but-unbound model blocks decompose.
2. **`validate-lint-rules`** proves invariant rules load through the linter's
   fail-closed loader (malformed JSON, missing fields, ReDoS-unsafe patterns
   all fail) before implementation starts.
3. **PostToolUse `lint-file`** enforces checkable invariants on every edit,
   forever — they outlive the feature that introduced them.

## What NOT to do

- No `BehavioralModel` JSON, no `validate-model-alignment` structural diffing
  — not even "lightweight structural checks". If it doesn't run, it drifts.
- No modeling for its own sake. A CRUD endpoint has no lifecycle; a feature
  with two sequential steps is not a pipeline. Sections absent = policy
  satisfied trivially.
- No pretending. If enforcement is advisory, the plan says `advisory`.
- No loom↔fugue coupling. No fugue in the project → no Pipeline section.
