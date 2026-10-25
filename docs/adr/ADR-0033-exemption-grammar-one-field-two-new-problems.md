# ADR-0033: Exemption grammar: one field, two new problems

## Status
Accepted (2026-10-23). Shipped with G5b owner enforcement
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-3; interview Q4a).

## Context
G5b makes the Wave Gate check every owned Invariant whose family the Wave changed. The check has two halves:
sibling coverage (the matrix test imports the owner and every sibling) and mutation verification (every mutant
of the owner's changed lines is killed). Some owners have changed lines that no test can meaningfully kill,
such as timing-only code. The plan author needs a way to turn off the mutation half for one Invariant.
FR-018 says the exemption needs a mandatory, non-empty reason. FR-020 says it turns off only the mutation half,
so sibling coverage still runs.

The opt-out goes into a grammar that is already strict. G5a's `parseOwnership` reads every `### INV-N` block
into a three-state `InvariantOwnership` (`owned` | `unowned` | `malformed`). A `malformed` value holds a
non-empty list of `OwnershipProblem`s, so one validation run names every problem it can decide from the text.
Misplaced model labels become `strays`, so a typo can never act as an opt-out. A new opt-out field runs into
these forces:

- **No silent opt-out.** A mutation exemption weakens a gate. If a malformed exemption is read as "exempt",
  or a malformed declaration is quietly ignored, the gate weakens without anyone noticing.
- **No new refusal path.** Populate, repair and validate already refuse malformed ownership through one plan
  check (`validate-model-bindings.ts`). FR-019 needs both new failure modes refused there and nowhere else.
- **Backward compatibility of meaning.** FR-021 says plans without the field must validate exactly as before.
  On such a plan, every owned Invariant must default to full verification.
- **Persistence.** The policy is stamped into the TaskGraph's `owner_obligations`. The wire must not load a
  state that the grammar refuses.

## Options Considered

1. **One field, `**Mutation exemption:** <reason>`, folded into `InvariantOwnership` (chosen)**
   - Pros:
     - Presence is the opt-out and the value is the reason, so an exemption without a reason cannot be
       written correctly. It shows up as a visible blank field, which the grammar names.
     - Reuses the three-state ownership type: two new `OwnershipProblem` kinds, and nothing else changes in
       how malformed ownership flows through validation.
     - No new refusal call site. The existing `renderOwnershipProblem` gains two arms, and its exhaustive
       `match` forces both to exist.
     - Plans without the line still parse as before, plus `mutation: { kind: "verify" }`.
   - Cons:
     - "Is this exempt" and "why" share one line, so a reason cannot span several lines or carry a list.
     - The parser has to tell "absent" apart from "present but blank". The old `fieldValue` helper merged
       those two cases, so it needed a new `fieldLine` primitive.

2. **Two fields: `**Mutation:** exempt` plus `**Exemption reason:** <text>`**
   - Pros: mirrors the existing `Owner module: none` + `Unowned reason:` pair, and leaves room for future
     values of `Mutation:`.
   - Cons:
     - Adds states the grammar would have to refuse: `Mutation: exempt` with no reason line, a reason line
       with no `Mutation:` (or with `Mutation: verify`), and an unknown `Mutation:` value. Each one needs its
       own problem kind and its own message.
     - Two labels join the misplaced-label list instead of one.
     - Rejected: it opens a state space only to close it again.

3. **A boolean or flag with no reason (`**Mutation exemption:** yes`)**
   - Pros: smallest grammar.
   - Cons: breaks FR-018's mandatory reason. A reviewer, the status projection, or a later reader cannot see
     why the gate was weakened. Rejected.

4. **Exemption outside the plan grammar (an operator-side list in the verification manifest)**
   - Pros: no plan grammar change.
   - Cons:
     - Splits an Invariant's declaration across two files.
     - The exemption escapes plan validation, the TaskGraph stamp, and plan-drift detection.
     - The architecture phase, which owns the Invariant, cannot decide it.
     - Rejected.

## Decision
**An owned Invariant may carry exactly one optional field, `**Mutation exemption:** <reason>`. It parses into
`owned.mutation: MutationPolicy`, and both of its misuses are two new `OwnershipProblem` kinds that the existing
plan check refuses.**

- **Types**
  - `engine/src/core/owner-verification/types.ts` defines the policy:
    ```ts
    type MutationPolicy = { kind: "verify" } | { kind: "exempt"; reason: string }
    ```
  - `exempt` exists only with a non-blank reason. `reason` is a plain `string`: the plan grammar and the
    State File wire parse (below), the only producers, refuse a blank one. The type has no third state.
  - `engine/src/types.ts` adds `mutation: MutationPolicy` to the `owned` arm of `InvariantOwnership`. It also
    extends `OwnershipProblem` with `{ kind: "exemption-without-reason" }` and
    `{ kind: "exemption-on-unowned" }`.
- **Parsing** (`parseOwnership` in `engine/src/core/parse-plan-models.ts`)
  - The field is read through `fieldLine`. It returns `absent`, or `present` with a value that is trimmed,
    has backticks stripped, and is `null` when blank. The label regex allows only spaces and tabs after the
    colon, so a blank exemption never takes the next line as its reason.
  - On an owned block:
    - field absent → `{ kind: "verify" }`;
    - non-blank value → `{ kind: "exempt", reason }`;
    - blank or whitespace-only value → no `owned` value. The block is `malformed`, and
      `exemption-without-reason` is listed with every other problem the block has (`reason-on-owned`, missing
      or malformed siblings, missing matrix test).
  - On an `**Owner module:** none` block, any exemption line, with or without a reason, adds
    `exemption-on-unowned`. The block is then `malformed` and never `unowned`. This problem is listed with
    `unowned-without-reason` and `owner-fields-on-unowned` when they also apply.
  - On a block with no `**Owner module:**` line, only `missing-owner` and a malformed sibling line are
    reported. Whether an exemption is allowed depends on the owner, so it cannot be decided, just as for
    siblings.
- **Strays.** `"Mutation exemption"` joins the parser's `labelHomes` list with home `Invariants`. The label
  anywhere outside `## Invariants` becomes a `misplaced-label` stray.
- **Refusal** (`renderOwnershipProblem` in `engine/src/handlers/helpers/validate-model-bindings.ts`)
  - The function renders both new kinds, naming the Invariant and the field:
    - "has no reason — state why the owner's mutants need not be killed, or remove the line";
    - "on an unowned invariant — … remove it, or name the owner module".
  - Populate, repair and validate refuse these plans through the one existing plan check, with no new call
    site (FR-019).
- **Stamp and wire**
  - `engine/src/core/owner-verification/obligations.ts` (the INV-3 owner) copies `ownership.mutation` into
    each stamped `OwnerObligation`.
  - `parseMutationPolicy` in `engine/src/state-file-wire.ts` accepts only `{kind:"verify"}` or
    `{kind:"exempt", reason}`, with exact fields and a non-blank reason. A hand-edited blank exemption in
    TaskGraph state is refused on load instead of loading as an opt-out.
- **Effect**
  - An `exempt` obligation skips only the mutation half. `verdict.ts` reports `{ kind: "exempt", reason }`,
    and coverage still runs (FR-020).
  - Population requires an `affectedRunner` only when the plan has a non-exempt owned Invariant
    (`owner-verification-runner-missing` in `engine/src/core/task-graph-population.ts`), so an exempt
    Invariant needs no runner.
  - Adding an exemption after population changes the stamped obligation. The next gate then blocks with
    `plan-drift` until the graph is re-populated (`docs/operations.md`, Owner verification).
- **Compatibility (FR-021).** A plan without the field produces the same `PlanModels` as before, plus
  `mutation: { kind: "verify" }` on each owned Invariant.
- **Documentation.**
  - The grammar is documented in `references/plan-template.md` (the optional `**Mutation exemption:**` line
    and the "Mutation exemption" rule).
  - Its operator effects are documented in `docs/operations.md`.
- **Tests.**
  - `engine/tests/core/parse-plan-models-exemption.test.ts` pins every case above (AS-019, AS-020, AS-021).
  - The same file has properties: adding a reasoned exemption changes only the mutation policy, and any
    exemption line on an unowned block makes it malformed.

## Consequences

**Positive:**
- Every way to misuse the exemption is a named, refused problem. None of them weakens the gate silently. The
  wire repeats the guarantee for persisted state.
- No new validation path. The exhaustive `match` in `renderOwnershipProblem` makes a future problem kind
  without a message a compile error.
- One malformed block reports all its problems in one run, including the exemption problem, as G5a's
  collecting design intended.
- Existing plans and oracle plans still validate with no change. Every owned Invariant defaults to `verify`,
  so the stricter behavior is the default.
- The reason travels with the obligation into the TaskGraph, the verdict and the status projection, so the
  reader of a gate report sees why mutation was skipped.

**Negative:**
- The reason is a single line. A long reason has to fit on the label line, and the grammar cannot hold a
  structured or multi-line reason.
- The exemption covers the whole Invariant: all or none of the owner's mutants. A per-line or per-operator
  exemption cannot be written, so one hard-to-kill line exempts the whole owner's changed lines.
- Exempting after population is plan drift. Every Task resets to `pending` on re-population, so a late
  exemption costs a re-run. This is intentional, because the exemption should be decided in the architecture
  phase.
- An exemption line on a block with no owner line is not reported until the owner line is added. The author
  can fix `missing-owner` and then hit a second refusal for the same block.
- The grammar checks that a reason exists, not that it is good. A one-word reason passes, so judging the
  reason is left to plan review.
