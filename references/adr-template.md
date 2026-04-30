# ADR Template

Used by `adr-writer-agent` when expanding plan AD-N seeds into full ADRs (one task per AD, scheduled by `phase-decompose.md` rule 6). Substitute all `{...}` placeholders. Output filename: `docs/adr/{NNNN}-{title-slug}.md`.

---

# ADR-{NNNN}: {Title}

## Status
{Accepted | Proposed | Superseded by ADR-NNNN | Deprecated}

## Context
{Why this decision is needed. Forces at play: technical, organizational, regulatory. 1–3 short paragraphs. State the problem, not the solution.}

## Options Considered

1. **{Option name}**
   - Pros: {list}
   - Cons: {list}

2. **{Option name}**
   - Pros: {list}
   - Cons: {list}

{Add more as needed. If no real alternatives existed (forced choice), state that explicitly: "Only viable option given X constraint" — but still record the decision.}

## Decision
**{One-line statement of the chosen option.}**

{Followed by detail: architecture, components, key invariants, file paths, naming conventions. Concrete enough that a future reader can map decision → code.}

## Consequences

**Positive:**
- {benefit}
- {benefit}

**Negative:**
- {cost / tradeoff / risk accepted}
- {cost / tradeoff / risk accepted}
