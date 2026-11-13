# CONTEXT.md Format

## Structure

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A concise description of the term — one or two sentences. Define what it IS, not what it does.}
_Avoid_: Purchase, transaction
_Mechanics_: {Optional. How the term's rule is carried out, when a reader needs that to use the term correctly.}

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account

## Relationships

- An **Order** produces one or more **Invoices**
- An **Invoice** belongs to exactly one **Customer**

## Example Dialogue

> **Dev:** "When a **Customer** places an **Order**, do we create the **Invoice** immediately?"
> **Domain expert:** "No — an **Invoice** is only generated once a **Fulfillment** is confirmed."

## Flagged Ambiguities

- "account" was used to mean both **Customer** and **User** — resolved: these are distinct concepts.
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under _Avoid_.
- **Flag conflicts explicitly.** If a term is used ambiguously, call it out in "Flagged Ambiguities" with a clear resolution.
- **Keep definitions tight.** One or two sentences. Define what it IS, not what it does.
- **`_Mechanics_:` is optional.** A term may end with one `_Mechanics_:` line, after `_Avoid_:`, stating how its rule is carried out: what happens, in what order, with what effect. It keeps the definition itself short. Leave it out when the definition is enough.
- **Show relationships.** Use bold term names and express cardinality where obvious.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.
- **Write an example dialogue.** A conversation between a dev and a domain expert that demonstrates how the terms interact naturally and clarifies boundaries between related concepts.
- **Include DDD terms when project-specific.** If the project uses DDD concepts (Aggregate, Value Object, Bounded Context) with project-specific meaning, include them. If they're used in their textbook sense, skip them.

## Single vs Multi-Context Repos

**Single context (most repos):** One `CONTEXT.md` at the repo root.

**Multiple contexts:** A `CONTEXT-MAP.md` at the repo root lists the contexts, where they live, and how they relate:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) — manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched`; Billing generates invoices
- **Ordering ↔ Billing**: Shared kernel for `CustomerId` and `Money`
```

Loom's own repository is an example of the multi-context form. The root `CONTEXT.md` holds the core vocabulary and is always read. `CONTEXT-MAP.md` lists six areas, each with its own file at `docs/contexts/<area>/CONTEXT.md` (for example `docs/contexts/review/CONTEXT.md`), and says when to read each one. A term is defined in exactly one file, and a new term goes into the file of the area it belongs to.

## When to Create

Create files lazily — only when there's something to write:
- If no `CONTEXT.md` exists, create one when the first term is resolved
- If a project clearly has multiple bounded contexts, create `CONTEXT-MAP.md` pointing to per-context files
- Never create empty placeholder files
