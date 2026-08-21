---
name: deepen
version: "1.0.0"
description: "This skill should be used when the user asks to 'improve the architecture', 'find refactoring opportunities', 'deepen modules', 'reduce coupling', 'make this more testable', 'simplify the interface', 'consolidate these modules', 'find shallow abstractions', or needs proactive architectural improvement of an existing codebase. Surfaces friction, proposes deepening opportunities, and walks the design tree with the user. Also preloaded by the architecture-tech-lead reviewer during review passes. NOT for reviewing PRs directly (use /review-pr, whose architecture reviewer runs this skill in review mode) or designing new features (use architecture-tech-lead)."
---

# Deepen — Proactive Architecture Improvement

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The goal is testability, locality, and leverage.

**This is a PROACTIVE skill** — you go looking for problems in existing code. For PR review use `/review-pr` (its `architecture-tech-lead` reviewer preloads this skill in review mode). For new feature design use `architecture-tech-lead`. For behavior-preserving cleanup *within* existing interfaces — duplication, dead code, control-flow noise — use `distill`; deepen is for when the interface itself is the problem. The two skills share vocabulary (see `references/LANGUAGE.md`); distill is the smaller knife.

---

## Context Loading

Before exploring, load the project's architectural context:

**Always read:**
- `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` — FC/IS, DDD, ports, immutability
- `CONTEXT.md` at the repo root (if it exists) — ubiquitous language

**Language-specific (if identifiable):**
- `${CLAUDE_PLUGIN_ROOT}/rules/java-patterns.md`
- `${CLAUDE_PLUGIN_ROOT}/rules/typescript-patterns.md`
- `${CLAUDE_PLUGIN_ROOT}/rules/rust-patterns.md`

**Also read:**
- `docs/adr/` — existing architectural decisions (don't re-litigate these)

---

## Vocabulary

Use these terms consistently in every suggestion. See [LANGUAGE.md](./references/LANGUAGE.md) for full definitions.

- **Module** — anything with an interface and an implementation (function, class, package, slice)
- **Interface** — everything a caller must know: types, invariants, error modes, ordering, config. Not just the type signature.
- **Depth** — leverage at the interface. **Deep** = a lot of behaviour behind a small interface. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place. (Use this instead of "boundary" to avoid collision with DDD bounded contexts.)
- **Adapter** — a concrete thing satisfying an interface at a seam (aligns with our Port/Adapter pattern)
- **Leverage** — what callers get from depth
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place

**Key tests:**
- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam.
- **One adapter = hypothetical seam. Two adapters = real seam.** This aligns directly with our port rule: "skip the port and call the concrete thing" unless a real fake exists.

---

## How This Connects to Our Architecture

The depth/seam vocabulary maps to our existing patterns:

| Depth Concept | Our Pattern | Connection |
|---------------|------------|------------|
| Deep module with small interface | **Functional Core** | Pure functions with clean input/output — deep by nature |
| Seam with adapter | **Port** at I/O edge | Our ports ARE seams; adapters satisfy them |
| Shallow pass-through | Anti-pattern: wrapper-for-the-sake-of-wrapping | Our rules say "skip the port and call the concrete thing" |
| Internal seam | Private test fake | A deep module can have internal seams its own tests use |
| Locality | **Aggregate** consistency boundary | Invariants concentrate in one place (pure command functions) |

When proposing deepenings, frame them in terms of our FC/IS + DDD model:
- "This logic is scattered across 3 shell orchestrators — extract a pure domain function in the functional core"
- "These 5 small validators are shallow; merge into one aggregate command function with a rich Either error type"
- "This port wraps another port — one adapter, hypothetical seam, delete the indirection"
- "This orchestrator imports from infra/ directly — introduce a port in domain/port/, move the concrete to infra/"

Refer to the package structure in `java-patterns.md` or `typescript-patterns.md` → "Package Structure" when proposing where things move.

---

## Two Modes

The skill runs in exactly one of two modes. Decide which before exploring.

### Review mode — findings, never a session

Active when preloaded by the `architecture-tech-lead` reviewer (standalone `/review-pr` or any engine-issued review), or whenever the user asks for an assessment rather than a design session.

- Scope is the exact frozen scope you were given. Explore it with the questions from Process step 1, but never widen it.
- Report each candidate as a finding: **files**, **problem** (depth/leverage/locality terms), **proposed deepening**, **benefits**. Stop at Process step 2 — the candidates ARE the findings.
- Do not walk the design tree, do not design interfaces, do not update `CONTEXT.md`, and never edit files. The output is findings.

**Severity discipline.** Deepening findings are almost always **advisory** — an interface can nearly always be deepened later. Reserve **critical** for shallowness that hides *wrongness*: a seam whose adapters disagree about its contract, an invariant enforced in some callers and not others, business logic in the shell that no test can reach. "This module could be deeper" is advisory, always. When the reviewer wire contract applies (Machine Summary), the agent shim defines it — the skill defines judgment, not wire format.

### Session mode — walk the design tree

Active when the user invokes deepen directly. Run the full Process below: explore, present candidates, grill, optionally design interfaces, and update `CONTEXT.md` inline as decisions land.

---

## Process

### 1. Explore

Read `CONTEXT.md` and any relevant ADRs first. Then explore the codebase organically. Note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where has logic been extracted "for testability" but the real bugs hide in how it's called? (No **locality**)
- Where do tightly-coupled modules leak across their seams?
- Where is business logic mixed with I/O? (FC/IS violation = deepening opportunity)
- Where are there ports with only one adapter and no test fake? (Hypothetical seams)
- Where are aggregates too large (god aggregate) or too fragmented (logic scattered)?

Apply the **deletion test** to anything suspicious: would deleting it concentrate complexity, or just move it?

### 2. Present Candidates

Present a numbered list of deepening opportunities. For each:

- **Files** — which files/modules are involved
- **Problem** — why the current shape causes friction (use depth/leverage/locality language)
- **Deepening** — plain English description of what changes
- **Benefits** — in terms of locality, leverage, testability, and FC/IS alignment

**Use `CONTEXT.md` vocabulary for the domain, depth vocabulary for the architecture.** If `CONTEXT.md` defines "Order", say "the Order aggregate command functions" — not "the OrderHandler" or "the order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real. Mark it: _"contradicts ADR-0007 — worth reopening because…"_

Do NOT propose interfaces yet. Ask: **"Which of these would you like to explore?"**

### 3. Grilling Loop

Once the user picks a candidate, drop into an interactive design session. Walk the design tree depth-first:

- What are the constraints any new interface must satisfy?
- What dependencies does this module have? Classify them (see [DEEPENING.md](./references/DEEPENING.md)):
  - **In-process** (pure, no I/O) → merge freely
  - **Local-substitutable** (Testcontainers Postgres, in-memory FS) → port interface as seam, real-engine stand-in for integration tests
  - **Port/Adapter** (own services across network) → port at seam, in-memory fake for tests
  - **True external** (Stripe, Twilio) → injected port, fake adapter
- What sits behind the seam? What's the interface?
- What tests survive the refactor? What gets deleted?

**Side effects happen inline:**

- **New domain concept emerges?** Add to `CONTEXT.md` immediately (follow [CONTEXT-FORMAT.md](../grill/references/CONTEXT-FORMAT.md))
- **Sharpening a fuzzy term?** Update `CONTEXT.md` right there
- **User rejects candidate with a load-bearing reason?** Offer to record as an ADR — but only when a future explorer would genuinely re-suggest this refactor without the context

### 4. Interface Design (Optional)

If the user wants to explore alternative interfaces for the deepened module, propose **2-3 radically different designs**:

1. **Minimal interface** — 1-3 entry points max. Maximum leverage per entry point.
2. **Flexible interface** — supports many callers and extension points.
3. **Default-optimized** — the most common caller's path is trivial.

For each design, show:
- Interface shape (types, methods, invariants, error modes)
- Usage example for the most common caller
- What the implementation hides behind the seam
- Dependency strategy and adapters
- Trade-offs: where leverage is high, where it's thin

Compare by **depth** (leverage at interface), **locality** (where change concentrates), and **seam placement**. Give your recommendation — be opinionated.

### 5. Testing Strategy

When deepening, tests change too:

- Old unit tests on shallow modules become waste once tests at the deepened interface exist — **delete them**
- Write new tests at the deepened module's interface. The interface IS the test surface.
- Tests assert on observable outcomes, not internal state
- Tests should survive internal refactors
- For pure core deepenings: property tests on invariants (jqwik / fast-check)
- For port deepenings: in-memory fake adapter, integration test with Testcontainers

---

## What NOT to Do

- Don't re-litigate existing ADRs unless friction is real and specific
- Don't propose deepenings that only reduce line count — depth is about leverage, not brevity
- Don't introduce seams without two adapters (production + test minimum)
- Don't deepen across bounded context boundaries without checking `CONTEXT.md`
- Don't implement — this skill proposes and designs, implementation is a separate task
- Don't batch `CONTEXT.md` updates — write them as decisions land

---

## Completion

**Review mode output:** the candidate findings, each anchored to its files, severity-disciplined as above — nothing designed, nothing written.

**Session mode** — complete when:
1. Selected candidates are designed to shared understanding
2. Interface shapes are agreed (if explored)
3. Testing strategy is clear
4. Any `CONTEXT.md` updates are written

**Output:**
- Summary of deepening decisions
- `CONTEXT.md` changes (terms added/modified)
- Suggested implementation order (what to do first)
- Whether this warrants a `/loom` orchestration or is a targeted refactor
