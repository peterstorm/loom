# ADR-0093: A re-reviewed Task's roster follows what changed

## Status
Accepted (2026-11-18). Extends ADR-0091 (a fresh Wave Gate carries unchanged Tasks' accepted reviews): a reviewed Task that does not carry is issued only the reviewers its change needs. Issue #213, Cause 5 (PR b).

## Context
ADR-0091 stopped a fresh Wave Gate from re-reviewing unchanged Tasks. A Task that did change was still issued its whole derived roster: five or six reviewers for a one-line doc-comment fix, or for a new test case. In the #213 advisory round the one changed Task still cost five reviewer requests where a comment change needs one.

The engine already holds what it needs to judge the change. The last accepted review names its run, Review Packet and reviewed head (`accepted_review_authority`), and that run's Review Packets carry the exact bytes the reviewers saw (the `wave-frozen-source` section), with the Task context they were shown. But reopening a Task cleared the acceptance (`invalidateTaskReview`, `returnToRevalidation`), so the next start had nothing to compare against.

## Options Considered

1. **Keep the full roster for every changed Task**
   - Pros: nothing to classify, nothing to trust.
   - Cons: the cost of #213 for every small fix.

2. **Let the operator name the roster**
   - Pros: no classifier.
   - Cons: an operator choice is not evidence; nothing would stop a code change being reviewed by `comment-analyzer` alone.

3. **Classify the change against the last accepted review's frozen bytes, and freeze the selection into the registration**
   - Pros: the decision is a pure function of protected and frozen evidence, replayed exactly; anything in doubt is a full review.
   - Cons: a new optional field on the Task, the Review Run, the acceptance, the resolution and the registration; a conservative comment lexer.

## Decision
**Option 3.**

- **Review Basis.** A Task's basis is its current-protocol accepted review, or, once a reopening cleared that, the `review_basis` the reopening kept (`invalidateTaskReview`, `returnToRevalidation`). `review_basis` is optional and parsed at the State File boundary, so a State File without it loads byte-identically. A legacy acceptance is no basis.
- **The shell reads the basis, the core judges it.** `start wave-gate` opens the basis run's Run Directory, reads that Task's Review Packets (`packetId` of the basis) and hands the pure planner their frozen source, Task context and owner-map and contract-surface sections. The core proves the frozen source is the basis's: same Task, same scope, `workspaceHeadSha` equal to the accepted `head_sha`. A missing, unreadable or mismatched basis means the full roster.
- **Change Class.** `classifyReviewChange(before, after)` (core/review-change.ts) returns `unchanged`, `scope-changed` (a path added or removed), `context-changed` (description, agent, plan context, Requirement anchors and contributions, declared files, plan file, owner map or contract surface differ, or a section was not observable in the basis) or the set of classes among `comment`, `doc`, `test` and `code`. Per changed file: a test file by the frozen Test-File Classification (engine default when none is frozen) is `test`; a Markdown, reStructuredText, AsciiDoc or text file is `doc`; a TypeScript, JavaScript or Java file whose comment-stripped form is unchanged is `comment`; anything else, including binary files and created or deleted files, is `code`.
- **Comment-only is conservative.** The comment lexer reads C-family comments, strings, template literals and regular expressions, and keeps a line break where a block comment held one. It returns no stripped form, so the file counts as code, for an unterminated literal, a quote inside a regular expression, or a comment on a line where it took a `/` for division. JSX and TSX, where `//` can be text, are not read. Stripping is idempotent.
- **Role table** (`selectReviewRoles`):
  - no basis, unchanged, scope change, context change or any code → the full derived roster;
  - comment-only or doc-only → `comment-analyzer`;
  - test-only → `code-reviewer` and `pr-test-analyzer`;
  - a mix → the union;
  - always the owner of every prior Finding the run is issued whose owner is on the derived roster;
  - `architecture-tech-lead` only for a code change (an owner-map or contract-surface change is a context change, so it is a code change), unless it owns an issued prior Finding;
  - roster order is kept, so each role keeps its slot index. A selection covering the whole roster is the derived roster.
- **Frozen into the registration.** `narrowedReviews` lists each narrowed Task with its issued roles, the derived roster it was narrowed from, its change classes and its basis. Absent when nothing narrowed, so such a registration is byte-identical to before. A restart's replacement inherits it from the run it replaces. A carried Task (ADR-0091) is planned first and is never narrowed. The batch epoch commits to it.
- **One issued roster.** `IssuedWaveReviewRoster` widens `WaveReviewRoster` deliberately: a derived roster, or a `NarrowedWaveReviewRoster`, a branded proper subsequence minted only by `issuedWaveReviewRoster`. Issuance, the locked install, retries, slot membership, the restart carry, completion verification and the completed-protocol replay all compare against `issuedWaveTaskRoster` (the registration's narrowing when its derived roster still holds, else the derived roster). The Subject Digest keeps the derived roster.
- **The Review Run and its acceptance record the narrowing** (`narrowing: {from, change, basis}`), so a later run cannot mistake a narrowed acceptance for a full-roster review. A narrowed acceptance carries (ADR-0091) like any other: its basis chain ends in a full review.
- **Retirement.** In a narrowed run a prior Finding retires only when its owner voted to retire it; a Finding whose owner was not issued carries forward. Its resolution records `narrowed_from`, and the stored-resolution validator applies the same rule.
- **The start reports the roster.** `wave-gate-start-roster` on stderr names each reviewed Task's issued roles and why: carried, full (with the reason) or narrowed (with the change classes).

## Consequences

**Positive:**
- A doc-comment fix is reviewed by one reviewer, a new test by two.
- The selection is replay-exact: the registration and epoch hold it, and every consumer reads it through one function.

**Negative:**
- A basis whose packets did not include `code-reviewer` (owner map) or `type-design-analyzer` (contract surface) cannot show that section, so the next change after such a narrowed review is reviewed in full unless the basis roster was the base five.
- Only TypeScript, JavaScript and Java comments are recognised; a comment change in another language is reviewed in full.
- A Task reopened before this change has no `review_basis` and is reviewed in full once.
