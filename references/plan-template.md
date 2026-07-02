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
See `references/executable-models.md` — a declared lifecycle MUST bind to a
machine file that a task implements, or decompose validation fails.

### LC-1: {Lifecycle Name}

**Machine file:** `{path/to/machine.ts}`
**Kind:** typed-reducer | xstate
**States:** {state, state, state}

| Event | From | To |
|---|---|---|
| {event} | {state} | {state} |

---

## Pipeline

Only if the feature is a real pipeline AND the project uses fugue AND the
user opted in at the approach gate. Delete section if not. The AuthoredDag
sidecar must exist before decompose (architecture phase authors it).

**AuthoredDag:** `{path/to/feature.dag.authored.json}`

| Node | Kind | Purpose |
|---|---|---|
| {node-id} | fetch \| llm \| transform \| human-review | {one line} |

---

## Invariants

Only if the design has invariants worth stating. Delete section if not.
Checkable invariants MUST have a rule file (written during this phase);
non-checkable ones are honestly tiered advisory.

### INV-1: {Invariant Title}

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-{slug}.json`
**Statement:** {what must always hold}

### INV-2: {Invariant Title}

**Tier:** advisory
**Statement:** {what should hold, and why it can't be deterministically checked}

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

**Executable Models (Lifecycles / Pipeline / Invariants):**
- Opt-in sections — most features need none of them. Absent = policy satisfied.
- A model either executes or it doesn't exist: lifecycle → machine file the
  implementation imports; pipeline → AuthoredDag that generates the graph;
  checkable invariant → lint rule enforced fail-closed on every edit.
- Never describe a lifecycle/pipeline in prose without the executable binding
  — `validate-task-graph` blocks decompose on unbound models.
- Full policy: `references/executable-models.md`

**What NOT to include:**
- Implementation code (that's the impl agent's job)
- Full API response bodies
- Database migration SQL
- Detailed error message strings
