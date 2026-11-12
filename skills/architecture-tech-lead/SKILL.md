---
name: architecture-tech-lead
version: "2.0.0"
description: "Upfront architectural design for Java/Spring Boot, TypeScript/Next.js or Rust: evaluate approaches, model the domain (DDD, bounded contexts), place the functional core and the shell, before code exists. Not for reviewing existing code (/review-pr) or improving it (deepen)."
---

# Architecture Tech Lead

Upfront architectural design: plan the structure before code is written. Evaluate approaches, model the domain, design for testability.

Design only; do not implement. After the user approves, hand off to implementation. This skill designs new architecture. Review of existing code is the `architecture-tech-lead` agent, reached through `/review-pr`.

## Context Loading

If not already in context this session, read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` and the one language rule matching the files in scope.

Also read `CONTEXT.md` at the repo root if it exists (ubiquitous language and domain relationships); if a `CONTEXT-MAP.md` exists, read only the context files it lists for the area you are working in. The loaded rules are constraints on the design.

## Under `/loom`

When this skill is preloaded by a `/loom` architecture phase, the phase template governs the interview: its topics, its batches of up to four questions, the approach gate and the plan format. Use Steps 2 to 5 below as design knowledge, and leave `CONTEXT.md` alone: it is updated only when this skill runs outside `/loom`.

## Design Process

### Step 1: Understand the Problem

Ask the user, one question at a time when not running under `/loom`:
- What does this feature or system need to do?
- What data flows in and out?
- What are the domain concepts? (nouns = entities, verbs = operations)
- What side effects exist? (DB, APIs, filesystem, time, randomness)

If the user introduces a term that conflicts with `CONTEXT.md`, call it out immediately. If they use a vague or overloaded term, propose the canonical term from the glossary or suggest adding one.

### Step 2: Model the Domain

Work through the strategic design checklist:

1. **Bounded context** — does this belong to an existing context or need a new one?
2. **Ubiquitous language** — which terms does the domain expert use? They go in `CONTEXT.md`.
3. **Aggregates** — what must change together atomically? Group only that; when in doubt, split. "Can these change independently? Then they're separate aggregates."
4. **Immutable data** — aggregates and entities are records, not mutable objects.
5. **Command functions** — `(Aggregate, Command) → Either<Error, Aggregate + Events>` in the functional core. Invariants live here and in constructors, not in callers.
6. **Value objects** — what has no identity and is defined by its attributes? These are the building blocks.
7. **Domain events** — which state changes do other contexts need to know about? Commands return them; the shell publishes them.
8. **Context relationships** — how does this context talk to the others? Pick from the table below.
9. **Ports** — repositories and external adapters as interfaces in domain terms; the shell implements them.
10. **Shell orchestrators** — load, call the pure core, persist. No business logic.

| Context relationship | Where it lives | When to use |
|---|---|---|
| **Published Language** | Between contexts | Upstream defines a stable schema (OpenAPI, events) for its consumers |
| **Anti-Corruption Layer** | Imperative shell | Downstream translates upstream's model into its own domain terms |
| **Shared Kernel** | Functional core (shared types) | Two contexts co-own a small set of types; use sparingly, it couples them tightly |
| **Conformist** | Imperative shell | Downstream accepts upstream's model as it is; fine for trivial integrations |

An anti-corruption layer lives in the shell because translating between external and internal representations is I/O-adjacent work: parsing foreign formats, calling external APIs, mapping foreign types.

Place each concept using "Package Structure" in the language rule (`domain/`, `orchestrator/`, `infra/`).

When a domain term is defined or sharpened during this step and you are not running under `/loom`, update `CONTEXT.md` at once: a tight definition, an _Avoid_ list, and any new relationship.

### Step 3: Evaluate Approaches

For significant decisions, present two or three options:

| | Approach A | Approach B | Approach C |
|---|---|---|---|
| **How it works** | | | |
| **Pros** | | | |
| **Cons** | | | |
| **Testability** | | | |
| **Complexity** | | | |
| **Fit with codebase** | | | |

Recommend one with justification.

### Step 4: Design the Architecture

Produce a design covering:

1. **Component structure** — modules, classes and functions, and how they relate
2. **Data flow** — fetch → transform (pure) → persist
3. **Error handling** — Either/Result types, where errors originate and how they propagate
4. **Effects** — which shell operations change the world, and how each is made retry-safe
5. **Test strategy** — what is unit testable (pure core), what needs integration tests (shell)
6. **Security implications** — trust boundaries, auth decisions, injection surfaces. Delegate deep review to `/security-expert`.
7. **NFR concerns** — scalability bottlenecks, performance traps, observability gaps, where relevant

### Step 5: Validate Testability

Before finalizing, verify:
- Can 90%+ of business logic be unit tested without mocks?
- Are all side effects at the edges?
- Can property tests verify domain invariants?
- Is the functional core truly pure?

If not, iterate the design until it passes.

## Output Format

```
## Architecture Design: [Feature Name]

### Summary
[1-2 sentences: what we're building and the chosen approach]

### Domain Model
[Entities, value objects, relationships]

### Component Design
[Modules, their responsibilities, data flow diagram]

### Approach Decision
[If multiple approaches evaluated — which one and why]

### Test Strategy
- Unit: [what's testable as pure functions]
- Property: [invariants to verify]
- Integration: [minimal I/O tests needed]

### Risks & Concerns
[Security, scalability, or complexity flags]

### Next Steps
[What to implement first, suggested order]
```

## Constraints

- Present approaches before recommending one.
- Be specific: actual type names and function signatures in the shapes the loaded rules use.
- Be pragmatic: balance the ideal architecture against effort.
- Explain why, so the principle is learned and not only the prescription.
