---
name: architecture-tech-lead
version: "2.0.0"
description: "This skill should be used when the user asks to 'design a feature', 'evaluate approaches', 'plan the architecture', 'domain modeling', 'DDD design', 'bounded contexts', 'functional core imperative shell', 'how should I structure this', 'what pattern should I use', or needs upfront architectural design for Java/Spring Boot, TypeScript/Next.js, or Rust codebases. For DESIGN decisions before implementation — not for reviewing existing code (use the architecture-tech-lead agent via /review-pr for that)."
---

# Architecture Tech Lead

Upfront architectural design — plan the structure before writing code. Evaluate approaches, model domains, design for testability.

**DESIGN only** — do NOT implement. After user approves, hand off to implementation.

## Relationship to Agent

- **This skill** = design new architecture (proactive, before code exists)
- **architecture-tech-lead agent** = review existing code (reactive, via `/review-pr`)

Don't duplicate the agent's work. If user wants a code review, point them to `/review-pr`.

## Context Loading

Before designing, load the relevant architectural rules. Read ONLY what's needed:

**Always read:**
- `~/.dotfiles/claude/project/meta/rules/architecture.md` — core principles (FC/IS, DDD, immutability)

**Java** (if designing for Java/Spring Boot):
- `~/.dotfiles/claude/project/java/rules/java-patterns.md` — records, sealed types, Either, railway-oriented programming
- `~/.dotfiles/claude/project/java/rules/property-testing.md` — jqwik invariants

**TypeScript** (if designing for TypeScript/Next.js):
- `~/.dotfiles/claude/project/typescript/rules/typescript-patterns.md` — discriminated unions, branded types, ts-pattern

**Rust** (if designing for Rust):
- `~/.dotfiles/claude/project/rust/rules/rust-patterns.md` — newtype, typestate, Result combinators

Apply loaded rules as architectural constraints for the design.

## Design Process

### Step 1: Understand the Problem

Ask the user (one question at a time):
- What does this feature/system need to do?
- What data flows in and out?
- What are the domain concepts? (nouns = entities, verbs = operations)
- What side effects exist? (DB, APIs, filesystem, time, randomness)

### Step 2: Model the Domain

- Identify domain entities, value objects, aggregates
- Map bounded contexts if multiple domains involved
- Define the "functional core" — pure business logic, no I/O
- Define the "imperative shell" — thin orchestration layer handling I/O

### Step 3: Evaluate Approaches

For significant decisions, present **2-3 options**:

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

1. **Component structure** — what modules/classes/functions, how they relate
2. **Data flow** — fetch → transform (pure) → persist pattern
3. **Error handling** — Either/Result types, where errors originate and propagate
4. **Test strategy** — what's unit testable (pure core), what needs integration tests (shell)
5. **Security implications** — flag if design introduces trust boundaries, auth decisions, or injection surfaces. Delegate deep review to `/security-expert`.
6. **NFR concerns** — flag scalability bottlenecks, performance traps, observability gaps if relevant to the design

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

- Present approaches before recommending — don't jump to a solution
- Be specific — use actual type names, function signatures from loaded rules
- Be pragmatic — balance ideal architecture with effort
- Explain the "why" — teach the principles, don't just prescribe
