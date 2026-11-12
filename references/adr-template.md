# ADR Template

Used by `adr-writer-agent` when expanding plan AD-N seeds into full ADRs (one task per AD, scheduled by `phase-decompose.md` rule 6). Substitute all `{...}` placeholders. The output path is the one in the task's `file_list`: decompose names it after the existing filename convention in `docs/adr/` and pre-allocates the number.

## Norms

- **Size.** Target 6KB; the hard cap is 10KB.
- **Status.** One line: a word from the vocabulary below plus a date.
- **Changing a decision.** Write a new ADR that supersedes the old one, and add the one line "Superseded by ADR-NNNN" to the old one's Status. Do not amend the old ADR in place.
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
