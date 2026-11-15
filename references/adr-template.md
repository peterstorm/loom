# ADR Template

Used by `adr-writer-agent` when expanding plan AD-N seeds into full ADRs (one task per AD, scheduled by `phase-decompose.md` rule 6). Substitute all `{...}` placeholders. The output path is the one in the task's `file_list`: decompose names it after the existing filename convention in `docs/adr/` and pre-allocates the number.

## Norms

- **Size.** Target 6KB; the hard cap is 10KB.
- **Status.** A status from the vocabulary below (`Superseded by ADR-NNNN` is one) and a date, then any relation to another ADR ("Amends ADR-NNNN", "Amended by ADR-NNNN").
- **Changing a decision.** Write a new ADR that supersedes or amends the old one, and add that relation to the old one's Status. Do not rewrite the old ADR's decision in place; a Status relation, a moved link or a corrected fact is not a rewrite.
- **What stays out.** Implementation notes, review-round history, test counts and digests belong in the PR or the plan, not the ADR.

---

# ADR-{NNNN}: {Title}

## Status
{Accepted | Proposed | Superseded by ADR-NNNN | Deprecated} ({YYYY-MM-DD})

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
