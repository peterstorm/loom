# Plan Template

Structure for architecture plan documents. Decompose agent parses this into task graph — structure matters.

---

```markdown
# Plan: {Feature Name}

**Spec:** {spec_file_path}
**Created:** {DATE}

## Summary

{2-3 sentences: what feature does, key architectural approach chosen}

---

## Architectural Decisions

### AD-1: {Decision Title}

**Choice:** {what was chosen}
**Why:** {rationale over alternatives}
**Rejected:**
- {Option A} — {why not}
- {Option B} — {why not}

### AD-2: {Decision Title}
...

---

## File Structure

All files to create or modify. Group by component.

### {Component/Domain A}

```
path/to/new/file.ts          — {purpose}
path/to/new/file.test.ts     — tests
```

**Export bindings:**
- `path/to/new/file.ts` — CT-1: priceOrder: PriceOrderFn, parseOrder: ParseOrderFn

Only when a contract (see `## Contracts`) declares a types file and this
group creates a file that provides functions it declares. Delete the label if
not. Column 0, outside the fence, directly under the group's fenced block; one
line per file and one contract per file. Grammar: executable-models.md §5.

### {Component/Domain B}

```
path/to/existing/file.ts     — {what changes}
path/to/new/file.ts          — {purpose}
```

---

## Component Design

### {Component Name}

**Responsibility:** {single sentence}
**Files:** `path/a.ts`, `path/b.ts`
**Interface:**

```
{key types, function signatures, or API contracts — concrete, not abstract}
```

**Depends on:** {other components or "none"}

### {Component Name}
...

---

## Data Flow

```
{Source} → {Component A} → {Component B} → {Output}
```

{1-2 sentences on key transformations}

---

## Lifecycles

Only if the design contains a real domain lifecycle. Delete section if not.
A declared lifecycle binds to a machine file that a task implements, or
decompose validation fails (executable-models.md §1).

### LC-1: {Lifecycle Name}

**Machine file:** `{path/to/machine.ts}`
**Kind:** typed-reducer
**States:** {state, state, state}

(Kind is `typed-reducer` — a pure `transition(state, event)` over closed unions, no new dependency — or `xstate` when the project already uses it. Write one concrete value, never both.)

| Event | From | To |
|---|---|---|
| {event} | {state} | {state} |

---

## Pipeline

Only if the feature is a real pipeline AND the project uses fugue AND the
user opted in during the architecture interview. Delete section if not. The
AuthoredDag sidecar must exist before decompose (the architecture phase
writes it; executable-models.md §2).

**AuthoredDag:** `{path/to/feature.dag.authored.json}`

| Node | Kind | Purpose |
|---|---|---|
| {node-id} | fetch \| llm \| transform \| human-review | {one line} |

---

## Invariants

Only if the design has invariants worth stating. Delete section if not.
A checkable invariant has a rule file (written during this phase); one that
cannot be checked is tiered advisory. A rule applied at two or more entry
points is an invariant, and every invariant names its owner, or says why it
has none (executable-models.md §3).

### INV-1: {Invariant Title}

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-{slug}.json`
**Owner module:** `{path/to/owner.ts}`
**Sibling entry points:**
- `{path/to/caller.ts}` — {what this entry point uses the rule for}
**Matrix test:** `{path/to/owner.matrix.test.ts}`
**Mutation exemption:** {OPTIONAL, owned only — why the owner's mutants need not be killed; delete the line to keep mutation verification}
**Statement:** {what must always hold, and which call sites it covers}

### INV-2: {Invariant Title}

**Tier:** advisory
**Owner module:** none
**Unowned reason:** {why no module owns it — e.g. a prohibition or a business SLA}
**Statement:** {what should hold, and why it can't be deterministically checked}

---

## Contracts

Only when the plan has a spec and a feature slice whose observable behavior a
test can decide. Delete section if not. Each contract becomes one contract
Task in an early Wave that writes the declarations-only types file and the
dedicated acceptance tests; later Tasks turn those tests green without
changing them. Every algebraic data type the feature shares goes in the
types file (executable-models.md §4 and §5).

### CT-1: {Contract Title}

**Types file:** `{path/to/feature-contract.ts}`
**Acceptance tests:**
- `{path/to/feature.acceptance.test.ts}` — AS-001, FR-001
**Supported domain:** `{path/to/feature.acceptance.test.ts}`
**Entry point:** `{path/to/the/production/file/the/tests/drive.ts}`
**Statement:** {the observable behavior consumers rely on, and what is refused}

### CT-2: {Vertical Slice Title}

**Types file:** none
**No types reason:** {why the slice needs no shared surface — e.g. it consumes CT-1}
**Acceptance tests:**
- `{path/to/slice.acceptance.test.ts}` — AS-002
**Statement:** {the end-to-end behavior, and the controls that must fail}

---

## Implementation Phases

Ordered by dependency. Maps directly to decompose waves.

### Phase 1: {Name} (no dependencies)

- {What to build — imperative}
- {What to build}
- **Files:** {list}

### Phase 2: {Name} (depends on Phase 1)

- {What to build}
- **Files:** {list}

### Phase 3: {Name} (depends on Phase 1+2)
...

---

## Testing Strategy

Per component, not global.

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| {name} | {pure functions to test} | {I/O boundaries} | {invariants, if any} |

---

## Security & NFR Notes

{Only if relevant. Delete section if not.}

- **Security:** {trust boundaries, validation, auth}
- **Performance:** {bottlenecks, caching}

---

## Verification

1. {Build/compile check}
2. {Test suite command + expected result}
3. {Manual verification steps}
```

---

## Guidelines

**File Structure:**
- Include test files alongside source files
- Use actual project paths (explore codebase first)
- Group by component/domain, not by file type

**Component Design:**
- Boundaries and interfaces, not internal details
- Concrete type signatures guide impl agents
- Explicit dependencies → drive wave scheduling

**Implementation Phases:**
- Phase 1 = zero-dependency foundation
- Later phases depend on earlier
- Within a phase, items run in parallel
- Maps 1:1 to decompose waves

**Architectural Decisions:**
- Only where real alternatives exist
- Brief rationale — gets quoted as `plan_context` for impl agents
- Don't document obvious choices

**Testing Strategy:**
- Per-component, not one big table
- Distinguish unit (pure) vs integration (I/O)
- Note property tests where invariants exist

**Executable Models (Lifecycles / Pipeline / Invariants / Contracts / Export bindings):**
- Opt-in sections. Most features need none of them, and an absent section satisfies the policy.
- A model either executes or it does not exist. Never describe a lifecycle or pipeline in prose without its executable binding: `validate-task-graph` blocks decompose on an unbound model and on a near-miss declaration (a misspelled heading or label is an error, not an opt-out).
- The sections are regex-parsed. Before declaring one, read its section of `references/executable-models.md`, which owns the grammar, the ownership rules, the contract fields and the export-binding rules, and copy headings and labels exactly as the template above shows them.

**What NOT to include:**
- Implementation code (that's the impl agent's job)
- Full API response bodies
- Database migration SQL
- Detailed error message strings
