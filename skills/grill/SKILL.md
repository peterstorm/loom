---
name: grill
version: "1.0.0"
description: "This skill should be used when the user asks to 'stress-test my plan', 'challenge this design', 'grill me', 'check my terminology', 'validate against the domain model', 'does this match our language', or needs an interactive session that challenges a plan against the project's documented domain model and ubiquitous language. Updates CONTEXT.md inline as decisions crystallize."
---

# Grill - Domain-Aware Design Challenge

Interview the user relentlessly about every aspect of their plan until shared understanding is reached. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask questions **one at a time**, waiting for feedback before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead of asking.

---

## Before Starting

### Load Domain Context

1. Look for `CONTEXT.md` at the repo root
2. If `CONTEXT-MAP.md` exists, read it to find all bounded contexts
3. Load the relevant `CONTEXT.md` for the topic at hand
4. Read `rules/architecture.md` for architectural principles

If no `CONTEXT.md` exists, create one lazily when the first term is resolved (see [CONTEXT-FORMAT.md](./references/CONTEXT-FORMAT.md)).

---

## During the Session

### Challenge Against the Glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately:

> "Your CONTEXT.md defines '**Task**' as a discrete unit of implementation work assigned to one agent. But you're using 'task' to mean a TODO item in a checklist — which is it? Should we introduce a new term, or are you talking about a loom Task?"

### Sharpen Fuzzy Language

When the user uses vague or overloaded terms, propose a precise canonical term:

> "You're saying 'service' — do you mean the **Imperative Shell** (I/O orchestration), a **Port** (interface at the boundary), or something else entirely? Those are different concepts in our architecture."

### Discuss Concrete Scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about boundaries between concepts:

> "You said a Wave Gate can be 'partially passed'. What happens if 3 of 4 tasks pass review but one is blocked? Does the whole wave block, or do passing tasks advance individually?"

### Cross-Reference with Code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it:

> "You said hooks only fire on SubagentStop, but I see `validate-phase-order.ts` fires on PreToolUse — it checks before the agent is even spawned. Is your mental model outdated, or is this a bug?"

### Update CONTEXT.md Inline

When a term is resolved during the session, update `CONTEXT.md` immediately. Don't batch these up — capture them the moment they crystallize.

Follow the format in [CONTEXT-FORMAT.md](./references/CONTEXT-FORMAT.md):
- Add new terms with tight definitions and _Avoid_ lists
- Update existing terms if meaning has shifted
- Add to Relationships when new connections are established
- Add to Flagged Ambiguities when a collision is resolved

### Apply DDD Principles

Challenge domain modeling decisions against DDD fundamentals:

| Principle | Challenge Pattern |
|-----------|-------------------|
| **Aggregate boundaries** | "What's the consistency boundary here? Can these two things change independently?" |
| **Value Object vs Entity** | "Does this concept have identity, or is it defined entirely by its attributes?" |
| **Bounded Context ownership** | "Who owns this concept? If two contexts use the same word differently, we need to split it." |
| **Invariant enforcement** | "Where is this invariant checked? If it's not in a constructor or aggregate root, it can be violated." |
| **Ubiquitous Language** | "Would a domain expert use this word? If not, we're leaking implementation into the model." |

### DDD Modeling Challenges

When the user proposes domain structures, push on:

1. **Aggregate size** — "This aggregate has 6 entities. Can you split it? Large aggregates are contention magnets."
2. **Cross-aggregate references** — "You're referencing another aggregate by object. Use an ID reference — aggregates are consistency boundaries."
3. **Domain events** — "When this state change happens, who else needs to know? That's a domain event, not a method call."
4. **Anti-corruption layers** — "You're importing types from an external system directly. That couples your domain to their model. Add a translation layer."
5. **Context mapping** — "These two contexts share 4 types. Are they actually one context? Or do the types mean subtly different things in each?"

---

## Question Strategy

### Depth-First, Not Breadth-First

Don't ask surface-level questions about everything. Pick the riskiest branch of the design and drill deep until it's resolved, then move to the next.

### Dependency-Ordered

Resolve decisions in dependency order. Don't ask about error handling before you know what the success path looks like.

### Concrete Over Abstract

Prefer "What happens when X?" over "How do you feel about Y?" Force the user into specific scenarios.

### Provide Your Recommendation

For each question, state what YOU think the answer should be and why. The user can agree, disagree, or nuance.

---

## What NOT to Do

- Don't write implementation code
- Don't produce a final design document (architecture-tech-lead does that)
- Don't batch CONTEXT.md updates — write them as decisions land
- Don't accept vague answers — push for precision
- Don't ask more than one question at a time
- Don't skip codebase verification when you can check a claim

---

## Completion

The session is complete when:
1. All branches of the design tree have been resolved to shared understanding
2. Every new or changed term is captured in `CONTEXT.md`
3. The user says they're satisfied, or there are no more open questions

**Final output:**
- Summary of decisions made
- List of `CONTEXT.md` changes (terms added/modified)
- Suggested next step (usually: hand off to `/loom` or `architecture-tech-lead`)
