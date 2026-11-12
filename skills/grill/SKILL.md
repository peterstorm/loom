---
name: grill
version: "1.0.0"
description: "Interactive session that stress-tests a plan or design against the project's documented domain model and ubiquitous language ('grill me', 'challenge this design', 'check my terminology'). Updates CONTEXT.md as terms are settled. Not for producing a design (architecture-tech-lead) or writing code."
---

# Grill — Domain-Aware Design Challenge

Interview the user about every aspect of their plan until you share one understanding of it. Walk each branch of the design tree and resolve the decisions it depends on before moving on.

- Ask one question at a time and wait for the answer.
- With every question, give the answer you would choose and why. The user can agree, disagree or refine it.
- If the codebase can answer a question, read the codebase instead of asking.

## Before Starting

If not already in context this session, read `${CLAUDE_PLUGIN_ROOT}/rules/architecture.md` and the one language rule matching the files in scope.

Then load the domain context:

1. `CONTEXT.md` at the repo root.
2. `CONTEXT-MAP.md`, if it exists: read only the context files it lists for the area under discussion.

If no `CONTEXT.md` exists, create one when the first term is settled (format: [CONTEXT-FORMAT.md](./references/CONTEXT-FORMAT.md)).

## During the Session

### Challenge Against the Glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately:

> "Your CONTEXT.md defines '**Task**' as a discrete unit of implementation work assigned to one agent. But you're using 'task' to mean a TODO item in a checklist — which is it? Should we introduce a new term, or are you talking about a loom Task?"

### Sharpen Fuzzy Language

When the user uses vague or overloaded terms, propose a precise canonical term:

> "You're saying 'service' — do you mean a **shell orchestrator** (sequences I/O via ports + pure logic), a **Port** (interface at the I/O boundary), or a **domain function** (pure logic in the functional core)? Those are different concepts in our architecture — and 'service' isn't any of them."

### Discuss Concrete Scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about boundaries between concepts:

> "You said a Wave Gate can be 'partially passed'. What happens if 3 of 4 tasks pass review but one is blocked? Does the whole wave block, or do passing tasks advance individually?"

### Cross-Reference with Code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it:

> "You said hooks only fire on SubagentStop, but I see `validate-phase-order.ts` fires on PreToolUse — it checks before the agent is even spawned. Is your mental model outdated, or is this a bug?"

### Update CONTEXT.md as Terms Settle

Write each term to `CONTEXT.md`, or to the context file `CONTEXT-MAP.md` lists for that area when a map exists, the moment it is settled, in the format of [CONTEXT-FORMAT.md](./references/CONTEXT-FORMAT.md): a new term with a tight definition and an _Avoid_ list, an existing term whose meaning shifted, a new relationship, or a resolved collision under Flagged Ambiguities.

### Challenge the Domain Model

| Topic | Challenge |
|-------|-----------|
| **Aggregate boundaries** | "What's the consistency boundary here? Can these two things change independently? This aggregate has 6 entities — can you split it?" |
| **Cross-aggregate references** | "You're referencing another aggregate by object. Use an ID." |
| **Value object vs entity** | "Does this concept have identity, or is it defined entirely by its attributes?" |
| **Invariant enforcement** | "Where is this invariant checked? If it's not in a constructor or aggregate command function, it can be violated." |
| **Domain events** | "When this state change happens, who else needs to know? That's a domain event, not a method call." |
| **Bounded context ownership** | "Who owns this concept? These two contexts share 4 types — are they one context, or do the types mean subtly different things in each?" |
| **Anti-corruption layer** | "You're importing types from an external system directly. That couples your domain to their model." |
| **Ubiquitous language** | "Would a domain expert use this word? If not, we're leaking implementation into the model." |

## Question Order

- **Depth-first.** Pick the riskiest branch and drill until it is resolved, then take the next.
- **Dependency order.** Don't ask about error handling before the success path is known.
- **Concrete over abstract.** "What happens when X?" beats "How do you feel about Y?"

## What NOT to Do

- Don't write implementation code.
- Don't produce a final design document; `architecture-tech-lead` does that.
- Don't accept a vague answer.

## Completion

The session is complete when every branch of the design tree is resolved, every new or changed term is in `CONTEXT.md`, and the user is satisfied or no question is open.

**Final output:**
- Summary of decisions made
- List of `CONTEXT.md` changes (terms added or modified)
- Suggested next step (usually `/loom` or `architecture-tech-lead`)
