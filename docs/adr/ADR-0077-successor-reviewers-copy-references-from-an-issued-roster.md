# ADR-0077: Successor reviewers copy references from an issued roster

## Status
Accepted (2026-11-16). Builds on ADR-0010.

## Context
Issue #185. A standalone successor review (ADR-0010) blocked terminally on Claude Code. Every reviewer either
emitted the Reviewer Protocol v2 shape or emitted v3 that admission refused with "Assessment must respect the
exact prior decision and explicitly reopen retired history." Both attempts failed the same way, so the slot
ended terminal-blocked.

Two gaps caused it. First, the reviewer agent files carry a contract stamped from
`references/reviewer-wire/wire-contract.md`, and that contract showed only the v2 schema and example. A
successor reviewer saw no v3 shape outside the packet's schema section. Second, a v3 payload must carry
canonical digests: each prior's `origin` (a digest of its Finding Origin) and, for `retained` or `reopen`, the
`reference` of a recorded decision (a digest of a history entry, or a disposition revision's digest). The
packet carried only the raw lineage JSON, so a reviewer had to compute those digests, which it cannot do. It
also had to infer from the history which verdicts admission would accept for each prior. A retired prior
(dismissed, refuted or resolved) admits no `still-present` and no `repaired`, and nothing said so.

## Options Considered

1. **Document the digest algorithm and the standing rules in the agent files**
   - Pros: no packet change.
   - Cons: a reviewer would run canonical JSON hashing by hand; the rules would be written twice, once in
     prose and once in admission, and could drift.

2. **Let admission accept non-canonical references and resolve them**
   - Pros: reviewers could name decisions loosely.
   - Cons: an assessment would no longer cite an exact decision; ADR-0010's exact-reference guarantee is lost.

3. **Issue the references and the admitted verdicts as data, and judge admission against the same data**
   - Pros: the reviewer copies; nothing is computed or inferred. What a reviewer is told and what the engine
     accepts are one projection, so they cannot drift.
   - Cons: a new packet section, so every successor packet's context digest changes.

## Decision
**Every successor packet carries a Standalone Assessment Roster, and admission judges every assessment
against it.**

`engine/src/core/standalone-assessment-roster.ts` is a pure projection of the prepared successor. In issued
order, each row holds the prior's exact `origin`, its original Finding, its standing (`active` or
`retired`), every decision it may cite by `reference` (its history, then each selected disposition revision
naming it) and the verdicts admission accepts. The roster also holds `lineageDigest`, `snapshotDigest` and the
`repairablePaths` a `repaired` change may name.

`buildStandaloneSuccessorReviewerContext` encodes the roster as the `standalone-assessment-roster` fixed
section, between `standalone-lineage` and the frozen schema, so the section is part of the issued context
digest. `assessStandaloneSuccessor` builds the same roster and
admits an assessment only through `admitsStandaloneAssessment`. A refusal names the row's index, origin,
standing, the verdict given, the verdicts the row allows and its citable references, and the retry carries
that text.

The stamped wire contract gains a successor section: when the task says the request is a successor, every
v2 shape is refused, the payload is v3, and every digest is copied from the roster. It shows an example that
the v3 admission schema parses. The v3 schema is not repeated there, because the issued packet carries its
bytes. A top-level v3 schema refusal names the whole successor envelope.

## Consequences

**Positive:**
- A successor reviewer has everything its payload needs as data it can copy.
- Guidance and admission share one function, and a test checks the equivalence for every verdict, citation
  and repair path on parser-prepared successors.
- A refused attempt says which row was wrong and what it allows, so attempt 2 can correct exactly that row.

**Negative:**
- Every successor packet is larger by one section, and every newly issued successor context digest differs.
  Re-proof (`reprovesStandaloneSuccessorReviewerContext`, used by issued-reviewer parsing and by the retry
  recovery) accepts a packet in either issued layout, with or without the roster. A Run issued before this
  change therefore resumes, replays and serves as a predecessor with its exact original digests.
  Admission never reads the roster section; it recomputes it.
- The stamped reviewer contract every reviewer spawn reads grows by about 2KB.
