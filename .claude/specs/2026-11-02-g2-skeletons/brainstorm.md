# Brainstorm Summary

**Building:** G2 (I1, generation-quality sequence). Once G1's contract Wave freezes a declarations-only types file, Loom deterministically generates a skeleton at each implementation Task's not-yet-existing file_list path: imports of the frozen types, plus one export per function-type alias the plan binds to that file, each with an `unimplemented` body. The implementer's job collapses to "make these signatures work". `declared-artifact-not-changed` gains semantic teeth: a frozen exported signature must survive, and its body must stop being `unimplemented`.

**Approach:** A — Skeletons from the frozen types file at wave start. The contract's frozen types file (its function-type aliases) is the only source of signatures. The plan's File Structure binds each new implementation file to the exports it provides (`name: AliasFn`). After the Acceptance Freeze, an engine step at the start of each implementation Wave writes the skeletons, and engine-written stubs replace the stubs the contract Task currently writes by hand.

**Key Constraints:**
- ADR-0020 holds: freeze only what consumers need. Skeletons contain only the exports the plan binds to an alias declared in the frozen types file. Internal helpers are never skeletonized, and module internals stay the implementer's choice.
- Signatures come only from the frozen, compiler-checked types file, never from the plan's free-form `**Interface:**` pseudo-signatures. The types file's bytes are stamped by the contract Wave Gate (ADR-0044), so generation happens at wave start after the freeze, not at population.
- Skeletons are written only to file_list paths that do not exist when the Wave starts. A file that a Task modifies and that already exists is never overwritten.
- Generation is deterministic and idempotent: the same frozen types and plan bindings produce byte-identical skeletons, and re-running over an existing skeleton changes nothing.
- The new proof check must not trip on files that are legitimately waived or attested (the `declared-artifact-attested` verify-only arm, documentation-only and generated-artifact waivers).
- The TypeScript compiler API enters only through the existing pure seams (ADR-0042). The functional core stays pure (purity linter, ADR-0043), and expected failures are values, never exceptions.
- Degradation is explicit and honest, never silent. The brief and `helper orchestration status` name it in each of these cases:
  - a file with no bound exports;
  - a contract with `Types file: none`;
  - a non-TypeScript target.

**In Scope:**
- A plan grammar addition: per-file export bindings to function-type aliases in File Structure (`name: AliasFn`). Parsing and validation refuse an alias the types file does not declare, an unsafe path, or a binding on a frozen path.
- A deterministic skeleton generator for TypeScript: type imports from the frozen types file, `export const name: AliasFn = (...) => { throw new Error("unimplemented: name") }`.
- A wave-start engine step that writes skeletons for not-yet-existing file_list paths of that Wave's implementation Tasks.
- Engine-generated contract stubs (the functions the acceptance tests import), replacing the hand-written stubs. The contract brief and decompose rule 12 are updated to match.
- Semantic teeth for the declared-artifact proof:
  - every skeleton export is still present with its alias annotation (the signature was not changed);
  - no export still throws `unimplemented` at completion.
- Plain-stub degradation:
  - a file with no bindings, or a contract with no types file, gets a plain module stub or nothing (the rule is decided in specify);
  - Java files get plain stubs in this slice.
  The brief and status state the degradation in every case.
- Brief rendering: the implementer is told which skeleton exports it must make work, and that their signatures are frozen.
- Docs: an ADR for the decision (refining, not superseding, ADR-0020), CONTEXT.md terms (Skeleton, Export Binding), and the decompose and architecture templates teaching the binding grammar.

**Out of Scope:**
- Java skeletons (interfaces plus `UnsupportedOperationException` stubs); a later slice.
- Rust or other languages beyond plain stubs.
- Parsing the plan's Component Design `**Interface:**` blocks (approach B).
- Skeletonizing internal helpers or non-exported structure.
- Rewriting or augmenting files that already exist.
- G3 exemplar anchoring.
- Changing the Acceptance Freeze or Contract Revision semantics, except as needed so that a revision regenerates or rechecks bindings.

**Open Questions:**
- Are skeleton files themselves frozen (signature-level), or only checked at completion? What is the exact semantic of "signature changed": alias annotation removed, renamed, retyped, or export deleted?
- Does a file with no bindings get a plain module stub or no file at all? Which one does a Java file get?
- Does the generator run as a separate engine helper, inside wave start or implementation issuance, or in population for the contract Task's stubs? Contract stubs are needed before the freeze, so their source is the plan-declared bindings plus the types file the contract Task writes. How is that ordering resolved?
- How do bindings interact with `helper revise-contract`? Does a revised types file re-validate the bindings and regenerate skeletons that have not been touched yet?
- Can a Task claim a file whose bindings reference aliases from more than one contract's types file?
- Is the skeleton written to the working tree before the agent spawns, and how is it kept out of the attempt-scope delta, so that engine-written bytes are not counted as implementer writes?
