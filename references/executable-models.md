# Executable Models Only — Standing Policy

A standing policy the architecture, decompose, and implementation phases
follow whenever a feature contains a real lifecycle, pipeline, or checkable
invariant. (Introduced by deterministic-core-convergence v2, "Phase C" — but
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
  `## Lifecycles` / `## Pipeline` / `## Invariants` with no suffix or colon
  (heading and label case is tolerated; block ids are uppercase-only);
  blocks `### LC-<n>: <title>` / `### INV-<n>: <title>` (numeric id, colon);
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
   every checkable `INV-N` rule file exists and is rule-shaped; near-miss
   declarations (typo'd headings/labels) are errors; an unreadable `plan_file`
   is an error, never a skipped check.
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

## Known residuals (honest limits)

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
