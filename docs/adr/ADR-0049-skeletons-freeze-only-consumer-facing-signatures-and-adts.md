# ADR-0049: Skeletons freeze only consumer-facing signatures and ADTs

## Status
Accepted (2026-11-07). Shipped with the G2 skeletons feature
(`.claude/specs/2026-11-02-g2-skeletons/spec.md`, FR-004, FR-008, FR-022, FR-043, OOS-002, OOS-003, OOS-004;
plan `.claude/plans/2026-11-02-g2-skeletons.md`, AD-2). This ADR refines ADR-0020. It does not supersede it.

## Context
G1's contract Wave freezes a types file that holds only declarations. The Acceptance Freeze stamps its bytes
(ADR-0044), and the compiler checks it, because the frozen acceptance tests import it. Implementers were still
free to invent their own signatures next to that file and to shadow its types with local copies. G2 makes the
frozen types file the one source of truth for consumer-facing signatures and data shapes. The engine writes a
skeleton at each new bound implementation path. At Task completion the declared-artifact proof refuses a bound
export that has been deleted, renamed or retyped, or that is still unimplemented, and it refuses a frozen ADT
that has been shadowed or re-listed.

Anything a skeleton freezes becomes a contract the implementer cannot change. ADR-0020 already settled how far
that may go. It rejected "a full skeleton of every internal helper frozen up front", because such a skeleton
freezes guesses before any behavior has tested them. It becomes a second specification that drifts from the
code, and its stubbed files give a RED that says nothing about behavior. ADR-0020's invariant is "freeze only
what consumers need". G2 adds a new freezing mechanism, so it must state where its boundary lies, or the
mechanism could grow into the kind of skeleton ADR-0020 rejected.

Three questions need an answer:

- **What a skeleton contains.** Only the bound exports, or also helpers, extra exports and module layout.
- **Where signatures come from.** The plan's Component Design `**Interface:**` blocks are a tempting second
  source. They exist at plan time, before any types file does, and they read like signatures.
- **Whether frozen ADTs are skeleton targets.** An ADT could be generated into each implementation file, or
  only enforced when the implementation imports it.

## Options Considered

1. **Freeze only the bound exports, with signatures from the frozen types file and ADTs enforced by checks only (chosen)**
   - Pros: Everything frozen was already frozen and compiled by the contract Wave, so the skeleton adds no new
     guess. ADR-0020's invariant holds unchanged. Implementers keep full control of internals: helpers, extra
     exports and module structure (FR-022). Signatures cannot drift from the types the acceptance tests import.
     The skeleton is small and deterministic, and it is a pure function of the frozen surface and the bindings
     (FR-009, FR-010). ADT misuse is still caught, by the syntactic shadowing and re-listing checks.
   - Cons: Signatures cannot be bound before the types file exists. The plan names aliases, and those aliases
     are checked only at stage two, when an implementation Task spawns, so a typo surfaces late (AS-008). Only
     function-type aliases can be bound. Constants, classes and type re-exports are not skeleton targets
     (OOS-004). The ADT checks are syntactic and miss structural copies that use different names.

2. **Derive signatures from the plan's `**Interface:**` blocks (brainstorm approach B, OOS-002)**
   - Pros: Skeletons could exist at population, before the contract Wave. Plan authors already write those blocks.
   - Cons: The blocks are free-form, unchecked pseudo-signatures, and no compiler has ever seen them. They would
     create a second signature source that can disagree with the frozen types file, which is exactly the drift
     ADR-0020 warns about. The engine would need a prose-to-type parser, with ambiguous refusal semantics.

3. **Skeletonize internal helpers and module structure as well (OOS-003)**
   - Pros: The implementer gets a fuller scaffold. Parallel Tasks would have less to negotiate.
   - Cons: This is the exact failure ADR-0020 names. Helpers are guesses at the contract Wave, and freezing them
     turns each guess into a constraint the implementer must either keep or argue away through a Contract
     Revision. Every extra frozen line is one more place where the conformance judge could raise a false
     positive.

4. **Generate frozen ADTs into implementation files as skeleton targets**
   - Pros: Implementers would see the data shapes inline.
   - Cons: A generated copy of an ADT is itself a re-declaration of the frozen type, which is the very thing
     FR-015 and FR-016 forbid. The correct use is an import, so a check enforces it better than a generated copy
     would.

## Decision
**A skeleton freezes only the plan-bound exports, typed by function-type aliases read from the frozen,
compiler-checked types file. Frozen ADTs are enforced by the conformance checks and are never generated, and
all other module internals stay the implementer's choice.**

Concretely:

- **Skeleton content (FR-008, OOS-003).** `generateSkeleton` (`engine/src/core/skeleton/generate.ts`) emits one
  header comment, the imports of the bound aliases (sorted, without duplicates), and one export for each binding,
  in plan order. Nothing else. TypeScript emits `export const name: Alias = () => { throw new Error("unimplemented: name"); };`.
  Java emits one `public static final Alias name = (p0, …) -> { throw new UnsupportedOperationException("unimplemented: name"); };`
  member per binding inside a `public final class` with a private constructor, typed by the frozen holder's
  alias (plan AD-7). The lambda's arity is the parameter count of the alias's single abstract method, as
  resolved at stage two. No helper, private member, extra export or module layout is generated.
- **One signature source (FR-004, OOS-002).** Bindings are parsed from the File Structure `**Export bindings:**`
  grammar (`engine/src/core/skeleton/bindings.ts`, plan AD-3). They hold only `name: Alias` pairs. The
  signature itself is resolved at stage two by `resolveBindings` (`engine/src/core/skeleton/resolve.ts`). It
  reads the digest-verified frozen types file through the parse-only seams `ts-surface.ts` and
  `java-surface.ts`. A missing, non-function or generic alias blocks the spawn. No code path reads a plan's
  `**Interface:**` block to obtain a signature.
- **Implementer freedom (FR-022).** `judgeConformance` (`engine/src/core/skeleton/conformance.ts`) checks only
  the bound exports, which must be present, keep their name, keep their frozen alias annotation and drop the
  exact `unimplemented: <name>` marker. It also checks for frozen ADTs that have been shadowed or re-listed.
  Extra exports, internal helpers and any other throw are invisible to it.
- **ADTs by check, not by generation (OOS-004, FR-015..FR-017).** TypeScript discriminated unions and branded
  types, and Java sealed interfaces, records and their permitted variants, appear in the frozen surface as
  `FrozenAdt` values (`engine/src/core/skeleton/types.ts`). They feed only the `shadows frozen ADT` and
  `re-lists frozen variants` reasons. The remedy the judge names is an import, either the frozen type itself or
  `Extract<FrozenUnion, …>`.
- **Relationship to ADR-0020.** ADR-0020's invariant "freeze only what consumers need" and its rejection of
  helper skeletons both stand. This ADR makes them precise for engine-written skeletons: "what consumers need"
  means the exports the plan binds and the ADTs the contract Wave already froze. A change to either goes through
  a Contract Revision (`helper revise-contract`, plan AD-10), never through the implementer.

## Consequences

**Positive:**
- No frozen guess is added. Every frozen signature and ADT has already passed the contract Wave's compiler and
  its Acceptance Freeze, so ADR-0020's concern does not reopen.
- The types file and the implementations can no longer drift silently. A changed, removed or still-stubbed
  bound export is a named completion refusal through the existing declared-artifact channel (FR-021).
- Implementers keep the design space ADR-0020 meant to protect: helper structure, extra exports and internal
  data shapes.
- Skeletons stay small, deterministic and idempotent, which keeps generation pure and the no-clobber writer
  simple (plan AD-8, AD-12).
- Only one signature source exists, so neither plan prose nor implementer taste can introduce a competing one.

**Negative:**
- Binding errors surface after the freeze, not at plan validation. A misspelled alias blocks the next
  implementation spawn instead of the plan (stage two, AS-008, AS-009).
- Coverage is limited to function-type aliases. Constants, classes and type re-exports are not frozen by a
  skeleton, and generic function aliases are refused at stage two (`generic-alias` in `resolveBindings`). Each
  stub is typed by the bare alias name, with no type arguments. The TypeScript stub is a zero-parameter throwing
  arrow, which is assignable to any non-generic function type. The Java stub is a lambda whose arity is taken
  from the alias, and a lambda cannot implement a generic abstract method. Neither stub can satisfy a
  type-parameterised alias.
- The ADT checks are syntactic. A structurally identical copy under a new name, or a string-literal union, is
  not caught. This limit is accepted and stated (plan AD-11, ADR-0058).
- **Limit: a frozen union with an imported member is no frozen ADT.** The frozen surface is read from the types
  file's text alone (`readTsTypesSurface`, ADR-0053). A union member is object-shaped only when it is a type
  literal, `Readonly<…>` of one, an intersection with an object-shaped part, or a reference to an object-shaped
  type declared in the same file. A reference to an imported type is never object-shaped, because its shape is
  not in that text. So a union whose members include an imported type reference is not recognised as a
  discriminated union, gets no `FrozenAdt` entry, and has no shadowing or re-listing protection. Contract
  authors who want a union protected declare all its variants in the types file itself.
- Plan authors must keep their `**Interface:**` prose consistent with the types file by hand. The engine ignores
  that prose, so any disagreement is a documentation defect, not a refusal.
- Freezing only what consumers need means that internal shape is not checked across Tasks. Two Tasks can
  build divergent private helpers for the same job, and only review catches that.
