# Feature: G2 — skeletons from the frozen types

**Spec ID:** 2026-11-02-g2-skeletons
**Created:** 2026-11-02
**Status:** Draft
**Owner:** Peter Storm (operator)

**Sources:** `brainstorm.md` (approach A: skeletons from the frozen types file at wave start), plus the operator interview of 2026-11-02. Where they conflict, the interview wins. It made two changes. **Java is in this slice** and follows the same model as TypeScript. **Frozen algebraic data types are enforced** at Task completion in both languages: implementers must use the frozen ADTs and must not re-declare them.

## Summary

G1's contract Wave freezes a types file that holds only declarations, but implementers are still free to invent their own signatures and shadow its types. G2 makes the frozen types file the single source of truth for consumer-facing signatures and data shapes.

- The plan binds each new implementation file to the exports it must provide, each typed by a function-type alias that the frozen types file declares.
- At the start of every implementation Wave, the engine writes a deterministic skeleton at each not-yet-existing bound file_list path. The skeleton imports the frozen types and gives every bound export an explicitly unimplemented body.
- The implementer's job becomes "make these signatures work".
- At Task completion, the declared-artifact proof gains semantic teeth:
  - every bound export survives with its frozen type;
  - no bound export is still unimplemented;
  - no implementation file shadows or re-lists a frozen ADT.

This applies to both TypeScript and Java. Every case where no skeleton is produced is reported honestly; none are skipped silently.

---

## User Scenarios

### US1: [P1] The plan binds new implementation files to frozen function types

**As a** plan author
**I want to** declare, per file in File Structure, which exports the file provides and which frozen function-type alias types each one (`name: AliasFn`)
**So that** the signatures implementers must satisfy are fixed by the contract, not by the implementer's taste

**Why this priority:** Without bindings there is nothing to generate or to check, so every other scenario depends on this one.

**Acceptance Scenarios:**
- AS-001: Given a plan whose File Structure entry for a new implementation file lists `parseOrder: ParseOrderFn` and `priceOrder: PriceOrderFn`, when the plan is validated, then validation accepts the bindings and records both exports against that file.
- AS-002: Given a binding on a path outside the repository or otherwise unsafe, when the plan is validated, then validation refuses the plan with a diagnostic naming the file and the reason.
- AS-003: Given a binding on a frozen path (the types file itself or an acceptance test), when the plan is validated, then validation refuses the plan with a diagnostic naming the path.
- AS-004: Given one file whose bindings reference aliases from two different contracts' types files, when the plan is validated, then validation refuses the plan with a diagnostic naming the file and both contracts.
- AS-005: Given a syntactically malformed binding (missing name, missing alias, duplicate export name in one file), when the plan is validated, then validation refuses the plan with a diagnostic naming the file and the malformed entry.
- AS-006: Given a plan with no bindings anywhere, when the plan is validated, then validation accepts it and the run proceeds with no skeletons. Each affected file is reported as "no bound exports, no skeleton".

### US2: [P1] A binding to an alias the frozen types file does not declare is caught after the freeze

**As an** operator
**I want** bindings checked against the actual frozen types file as soon as it is frozen
**So that** a binding that names a non-existent alias never reaches an implementer

**Why this priority:** Signatures come only from the frozen, compiler-checked file. The types file does not exist when the plan is written, so this second stage is the only place the alias can be checked.

**Acceptance Scenarios:**
- AS-007: Given a frozen types file that declares every alias the plan binds, when the contract Wave is frozen, then the next Wave starts normally.
- AS-008: Given a frozen types file that does not declare an alias the plan binds, when the next Wave tries to start, then the start is refused with a diagnostic naming the alias, the binding file and the types file.
- AS-009: Given a binding that names a type the frozen types file declares but which is not a function type, when the next Wave tries to start, then the start is refused with a diagnostic naming the alias and saying it is not a function type.

### US3: [P1] TypeScript skeletons are written at implementation Wave start

**As an** implementer agent
**I want** each new TypeScript file I own to exist, before I start, as a skeleton that imports the frozen types and declares every bound export with its frozen alias and an unimplemented body
**So that** my task is to make these signatures work, not to guess them

**Why this priority:** This is the core of G2.

**Acceptance Scenarios:**
- AS-010: Given an implementation Wave whose Task owns a not-yet-existing `.ts` file bound to `parseOrder: ParseOrderFn`, when the Wave starts, then the file exists before the implementer is spawned. It contains a type import of `ParseOrderFn` from the frozen types file and one export `parseOrder` annotated `ParseOrderFn`, whose body throws an error carrying the exact marker `unimplemented: parseOrder`.
- AS-011: Given the same frozen types file and plan bindings, when skeleton generation runs 100 times, then all 100 outputs are byte-identical.
- AS-012: Given a skeleton the engine has already written and nobody has touched, when skeleton generation runs again, then 0 bytes change.
- AS-013: Given a file_list path that already exists when the Wave starts, when the Wave starts, then the file is not modified. Status and the brief say "exists, not skeletonized", and the completion checks of US5 still apply to the bound exports.
- AS-014: Given a not-yet-existing TypeScript file with no bindings, when the Wave starts, then no file is written. Status and the brief say "no bound exports, no skeleton".
- AS-015: Given a skeleton written by the engine, when the Task's attempt-scope delta is computed, then the engine-written bytes are not counted as implementer writes.

### US4: [P1] Java skeletons are written at implementation Wave start from the frozen Java types

**As an** operator who writes Java with sealed interfaces, records and functional interfaces
**I want** Java implementation files to get the same skeleton treatment as TypeScript, sourced from the contract's frozen Java types
**So that** my Java plans get the same signature discipline, and my ADTs are respected

**Why this priority:** The operator called sealed interfaces in Java essential, and this reverses the brainstorm's plain-stub-only position for Java.

**Acceptance Scenarios:**
- AS-016: Given a contract whose frozen Java types declare functional interfaces, sealed interfaces and records, and a plan binding `priceOrder: PriceOrderFn` on a not-yet-existing `.java` file, when the Wave starts, then the file exists before the implementer is spawned. It references the frozen types and declares one bound member `priceOrder` whose type is fixed by `PriceOrderFn` and whose body throws an unsupported-operation error carrying the exact marker `unimplemented: priceOrder`. [NEEDS CLARIFICATION: the exact shape of a bound Java member (for example, a method mirroring the functional interface's single abstract method, or a field or constant of the functional-interface type) is a technical choice for architecture; the spec fixes only that the signature comes from the frozen functional interface and survives verbatim.]
- AS-017: Given the same frozen Java types and bindings, when skeleton generation runs 100 times, then all 100 outputs are byte-identical; a re-run over an untouched skeleton changes 0 bytes.
- AS-018: Given a not-yet-existing Java file with no bindings, when the Wave starts, then no file is written. Status and the brief say "no bound exports, no skeleton".
- AS-019: Given an existing Java file_list path, when the Wave starts, then the file is not modified, it is reported as "exists, not skeletonized", and the completion checks still apply.

### US5: [P1] Completion refuses a changed signature or an unimplemented export

**As an** operator
**I want** a Task's completion refused when a bound export was removed, renamed or retyped, or still carries the unimplemented marker
**So that** "declared artifact changed" means the frozen signature was honored and actually implemented, not merely that bytes moved

**Why this priority:** Without this, a skeleton is only a suggestion.

**Acceptance Scenarios:**
- AS-020: Given a bound file where every bound export is present with its original name and its original frozen-alias annotation, and none contains its `unimplemented: <name>` marker, when the Task completes, then the semantic check passes.
- AS-021: Given a bound export that was deleted, when the Task completes, then completion is refused through the declared-artifact channel with a diagnostic naming the file, the export and the reason `deleted`.
- AS-022: Given a bound export that was renamed, when the Task completes, then completion is refused with reason `renamed` (equivalently, the bound name is reported as missing).
- AS-023: Given a bound export whose alias annotation was removed or replaced by a different type (even one that still compiles), when the Task completes, then completion is refused with reason `retyped`.
- AS-024: Given a bound export whose body still contains its exact `unimplemented: <name>` marker, when the Task completes, then completion is refused with reason `still unimplemented`.
- AS-025: Given a bound export that throws some other error on a legitimate path, when the Task completes, then the unimplemented check does not trip.
- AS-026: Given an implementer who added internal helpers and extra exports beyond the bound ones, when the Task completes, then the semantic check passes.
- AS-027: Given an implementer who deleted the whole skeleton file, when the Task completes, then every bound export of that file is reported as `deleted` and completion is refused.
- AS-028: Given several violations in one Task, when completion is refused, then the diagnostic lists every violation (file, export, reason), not only the first.
- AS-029: Given a Java bound member that was deleted, renamed or retyped, or still carries its marker, when the Task completes, then completion is refused with the same reasons and diagnostic shape as for TypeScript.

### US6: [P1] Completion refuses shadowed or re-listed frozen ADTs

**As an** operator
**I want** completion refused when an implementation file declares its own copy of a frozen ADT or re-lists a frozen union's or sealed hierarchy's variants
**So that** each frozen ADT keeps a single definition and implementers have to import and use it

**Why this priority:** The operator added this as P1: "we respect the types, and this also means ADTs".

**Acceptance Scenarios:**
- AS-030: Given a frozen TypeScript discriminated union `OrderEvent`, and an implementation file that declares its own type, interface or class named `OrderEvent`, when the Task completes, then completion is refused with a diagnostic naming the file, the local declaration and the frozen ADT, with reason `shadows frozen ADT`.
- AS-031: Given a frozen TypeScript discriminated union whose variants are tagged `placed | paid | shipped`, and an implementation file that declares a differently named local union with the same set of discriminant values, when the Task completes, then completion is refused with reason `re-lists frozen variants`.
- AS-032: Given a frozen TypeScript branded type, and an implementation file that declares a local type with the same name, when the Task completes, then completion is refused with reason `shadows frozen ADT`.
- AS-033: Given a frozen Java sealed interface `Shape permits Circle, Square`, and an implementation file that declares its own sealed interface or class whose permitted subtypes have the same simple names, when the Task completes, then completion is refused with reason `re-lists frozen variants`.
- AS-034: Given a frozen Java sealed interface or record, and an implementation file that declares a type with the same simple name, when the Task completes, then completion is refused with reason `shadows frozen ADT`.
- AS-035: Given an implementation file that imports the frozen ADTs, pattern-matches on them and constructs their variants, when the Task completes, then the ADT check passes.
- AS-036: Given an implementation file that declares a local TypeScript union, or a local Java sealed interface or class, re-declaring two or more of a frozen ADT's variants (a strict subset or the full set), when the Task completes, then completion is refused with reason `re-lists frozen variants`, treated as a parallel hierarchy. The diagnostic names the remedy: derive the subset from the frozen union (for example `Extract<FrozenUnion, ...>`) or use the frozen types directly. A local declaration that shares only a single variant name is caught only by the same-name rule (AS-030, AS-034), not by this rule.
- AS-037: Given a file that is legitimately waived (documentation-only or generated-artifact) or attested (the `declared-artifact-attested` verify-only arm), when the Task completes, then neither the signature check nor the ADT check runs on it, and nothing is reported against it.

### US7: [P1] Every case without a skeleton is reported honestly

**As an** operator
**I want** every case where no skeleton was produced to be named in the brief and in `helper orchestration status`
**So that** a missing skeleton is never mistaken for one that was generated correctly

**Why this priority:** Honest reporting when the engine falls back is a hard constraint from the brainstorm.

**Acceptance Scenarios:**
- AS-038: Given a file with no bound exports, when the Wave starts, then the brief and status name the file with "no bound exports, no skeleton".
- AS-039: Given a contract declaring `Types file: none`, when its implementation Waves start, then no skeletons are written for its files. The brief and status say "contract has no types file, no skeletons", and the signature and ADT checks are not applied to its files.
- AS-040: Given a bound file in a language other than TypeScript or Java, when the Wave starts, then no file is written, and the brief and status name the file with "unsupported language, no skeleton".
- AS-041: Given an existing file_list path, when the Wave starts, then the brief and status name it with "exists, not skeletonized".
- AS-042: Given any Wave, when status is queried, then every new file_list path of that Wave's implementation Tasks is listed with exactly one outcome: skeleton written, or one of the four reasons above.

### US8: [P2] The engine writes the contract stubs

**As a** contract Task author
**I want** the stubs that the acceptance tests import to be written by the engine, from the plan's bindings and the types file I wrote
**So that** contract stubs follow the same deterministic grammar as implementation skeletons and I stop hand-writing them

**Why this priority:** This is significant value, but implementation-Wave skeletons and their checks work without it.

**Acceptance Scenarios:**
- AS-043: Given a contract Task whose types file exists and whose plan bindings cover the files the acceptance tests import, when the engine writes the contract stubs, then each stub follows the same skeleton format as US3 and US4 and exists before the acceptance tests run. [NEEDS CLARIFICATION: technical approach TBD. Stubs are needed before the freeze, so their source is the contract Task's not-yet-frozen types file; architecture must define the exact point in the contract Task at which the engine writes them.]
- AS-044: Given a contract stub the engine wrote, when the Acceptance Freeze runs, then freeze semantics are unchanged. The stub is treated as a skeleton, so the US5 and US6 checks apply to it in the implementation Wave that owns it.
- AS-045: Given the contract brief and decompose rule 12, when they are read after this change, then they say the engine writes the stubs and the contract Task no longer does.

### US9: [P2] The brief tells the implementer what is frozen

**As an** implementer agent
**I want** my brief to list, per owned file, the bound exports I must make work, their frozen aliases, and the frozen ADTs I must use rather than re-declare
**So that** I know the rules before I write code, not only when completion refuses me

**Why this priority:** It strongly reduces refused completions, but the checks enforce correctness without it.

**Acceptance Scenarios:**
- AS-046: Given a Task owning a skeleton file, when its brief is rendered, then the brief lists each bound export with its alias, and states that the signatures are frozen and that the `unimplemented` marker must be gone at completion.
- AS-047: Given a Task whose contract freezes ADTs, when its brief is rendered, then the brief names the frozen ADTs and says they must be imported, not re-declared or re-listed.
- AS-048: Given a Task with any fallback outcome from US7, when its brief is rendered, then the brief states that outcome for each affected file.

### US10: [P1] A contract revision re-validates bindings and refreshes only untouched skeletons

**As an** operator
**I want** `helper revise-contract` to re-validate every binding against the revised types file, regenerate skeletons that nobody has touched, and flag touched ones as stale
**So that** a revision never leaves implementers working against signatures that no longer exist, and never destroys their work

**Why this priority:** A revision is the one sanctioned way frozen types change, so bindings must follow it.

**Acceptance Scenarios:**
- AS-049: Given a revision whose revised types file still declares every bound alias, when the revision completes, then every skeleton still byte-identical to its engine-written content is regenerated from the revised types.
- AS-050: Given a skeleton the implementer has already modified, when a revision completes, then the file is not modified and status flags it `stale against revised contract`, naming the file.
- AS-051: Given a revision whose revised types file no longer declares a bound alias, when the revision is applied, then the US2 stage-two check reports the missing alias by name and blocks the next Wave start.

---

## Functional Requirements

### Core Requirements

- FR-001: The plan grammar MUST support per-file export bindings in File Structure of the form `name: AliasFn`, one or more per file.
- FR-002: Plan validation MUST refuse a binding with an unsafe path, a binding on a frozen path, a malformed or duplicate binding in one file, and a file whose bindings reference more than one contract's types file. Each refusal names the file and the reason.
- FR-003: The engine MUST verify, once the contract Wave's types file is frozen, that every bound alias is declared there as a function type. It MUST refuse the next Wave start with a diagnostic naming each missing or non-function alias.
- FR-004: Signatures MUST come only from the frozen types file. The engine MUST NOT derive signatures from the plan's free-form `**Interface:**` blocks.
- FR-005: At the start of each implementation Wave, the engine MUST write a skeleton for every not-yet-existing file_list path of that Wave's implementation Tasks that has at least one binding and whose language is TypeScript or Java. Writing completes before the implementer is spawned.
- FR-006: A TypeScript skeleton MUST contain type imports of the bound aliases from the frozen types file and, for each binding, one export with that name, annotated with the bound alias, whose body throws an error carrying the exact marker `unimplemented: <name>`.
- FR-007: A Java skeleton MUST reference the frozen Java types and, for each binding, declare one member with that name whose type is fixed by the bound frozen functional interface, and whose body throws an unsupported-operation error carrying the exact marker `unimplemented: <name>`.
- FR-008: The engine MUST NOT skeletonize internal helpers or non-exported structure. A skeleton contains exactly the bound exports and the imports they need.
- FR-009: Skeleton generation MUST be deterministic: the same frozen types and bindings produce byte-identical output.
- FR-010: Skeleton generation MUST be idempotent: re-running over an untouched skeleton changes 0 bytes.
- FR-011: The engine MUST NEVER modify a file that exists when the Wave starts.
- FR-012: Bytes the engine writes as skeletons MUST NOT count as implementer writes in the attempt-scope delta.
- FR-013: At Task completion, the declared-artifact proof MUST refuse completion for each bound export that is deleted, renamed, retyped (alias annotation removed or replaced), or that still contains its exact `unimplemented: <name>` marker. This applies to TypeScript and Java alike.
- FR-014: Deleting a skeleton file MUST count as deleting every bound export of that file.
- FR-015: At Task completion, the declared-artifact proof MUST refuse completion when an implementation file declares a type, interface, class or record with the same name as a frozen ADT or one of its variants.
- FR-016: At Task completion, the declared-artifact proof MUST refuse completion when an implementation file declares a local union or sealed hierarchy that re-declares two or more variants of a frozen discriminated union or sealed hierarchy, whether a subset or the full set. A single shared variant name is covered only by FR-015.
- FR-017: Frozen ADTs subject to FR-015 and FR-016 MUST include TypeScript discriminated unions and branded types, and Java sealed interfaces, records and the variants they permit.
- FR-018: Signature and ADT checks MUST apply to files that existed at Wave start (reported "exists, not skeletonized") whenever they carry bindings or belong to a Task whose contract freezes ADTs.
- FR-019: Signature and ADT checks MUST NOT run on files covered by the existing documentation-only waiver, the generated-artifact waiver, or the `declared-artifact-attested` verify-only arm.
- FR-020: No new override, waiver or bypass for the signature and ADT checks MAY be introduced. Only the existing waivers and attestations exempt a file.
- FR-021: A refused completion MUST be reported through the existing declared-artifact channel. It lists every violation as file, export or declaration, and one reason from: `deleted`, `renamed`, `retyped`, `still unimplemented`, `shadows frozen ADT`, `re-lists frozen variants`.
- FR-022: Extra exports and internal helpers an implementer adds MUST NOT trip any check.
- FR-023: The engine MUST write the stubs imported by the contract's acceptance tests, using the same skeleton format, and MUST NOT require the contract Task to hand-write them.
- FR-024: The implementer brief MUST list per owned file the bound exports and their frozen aliases, state that the signatures are frozen and that the marker must be gone at completion, and name the frozen ADTs that must be imported, not re-declared.

### Data Requirements

- FR-030: For every new file_list path of a Wave's implementation Tasks, the engine MUST record exactly one skeleton outcome: `skeleton written`, `no bound exports, no skeleton`, `contract has no types file, no skeletons`, `unsupported language, no skeleton`, or `exists, not skeletonized`.
- FR-031: The engine MUST keep enough record of each skeleton's engine-written content to tell an untouched skeleton from a modified one, for idempotency (FR-010) and contract revision (FR-033).
- FR-032: On a Task retry, the engine MUST keep whatever is on disk and regenerate only a skeleton file that is missing but still in file_list. Skeletons MUST NOT be deleted when a Task fails or is retried.
- FR-033: On `helper revise-contract`, the engine MUST re-validate every binding against the revised types file, regenerate every skeleton still byte-identical to its engine-written content, leave modified skeletons untouched, and flag each one as `stale against revised contract` in status.

### Integration Requirements

- FR-040: `helper orchestration status` and the brief MUST show each file's skeleton outcome (FR-030) and every stale flag (FR-033).
- FR-041: The contract brief and decompose rule 12 MUST be updated to say the engine writes contract stubs.
- FR-042: The decompose and architecture templates MUST teach the binding grammar, the one-contract-per-file rule, and the frozen-ADT rule.
- FR-043: An ADR MUST record the decision, refining (not superseding) ADR-0020. Skeletons freeze only consumer-facing signatures and ADTs; module internals stay the implementer's choice.
- FR-044: CONTEXT.md MUST define the terms Skeleton, Export Binding and Frozen ADT.
- FR-045: Every expected failure (refused binding, missing alias, check violation, unsupported language) MUST surface as a reported outcome, never as an unhandled crash.

---

## Non-Functional Requirements

### Performance

- NFR-001: Skeleton generation at Wave start MUST add at most 2 seconds of wall time for a Wave with 20 skeleton files.
- NFR-002: The added signature and ADT checks MUST add at most 2 seconds to a single Task's completion with 20 bound files.

### Security

- NFR-010: The engine MUST NEVER write a skeleton outside the repository root or to an unsafe path; such bindings are refused at plan validation (FR-002).
- NFR-011: The engine MUST NEVER write to a frozen path (the types file or acceptance tests) as part of skeleton generation.

### Reliability

- NFR-020: Generation and checking MUST keep the functional core pure. Expected failures are values reported at the boundary, not exceptions (ADR-0042, ADR-0043).
- NFR-021: A failure part-way through skeleton generation MUST NOT leave a partially written skeleton file. Each file is either fully written or absent, and a re-run completes the rest.

---

## Success Criteria

- SC-001: 100 out of 100 repeated generation runs over the same frozen types and bindings produce byte-identical skeletons, for both TypeScript and Java fixtures.
- SC-002: A re-run of skeleton generation over untouched skeletons changes 0 bytes in 100% of fixture runs.
- SC-003: Wave-start generation for a 20-file Wave adds ≤ 2 seconds of wall time.
- SC-004: 0 false positives from the signature and ADT checks across all existing waived and attested artifacts in the engine's fixture corpus.
- SC-005: 100% of fallback cases (no bound exports, `Types file: none`, unsupported language, existing file) are named in both the brief and status in fixture runs.
- SC-006: 100% of seeded violations in a fixture matrix covering both languages are detected, each with the correct reason. The matrix covers: export deleted, renamed, retyped, still unimplemented, skeleton file deleted, ADT shadowed by name, variants re-listed.
- SC-007: 0 pre-existing files are modified by skeleton generation across the fixture corpus.
- SC-008: 100% of plan-validation refusal cases (unsafe path, frozen path, malformed or duplicate binding, multi-contract file) and both stage-two refusals (missing alias, non-function alias) are refused with a diagnostic naming the file or alias.

**Measurement approach:** engine unit and property tests over the generator (determinism, idempotency), handler tests over Wave start, Task completion and contract revision, and a fixture matrix per language for seeded violations. Timing is measured on the 20-file fixture Wave.

---

## Out of Scope

Explicitly NOT part of this feature:

- OOS-001: Skeletons for Rust or any language other than TypeScript and Java. Those files get only the honest "unsupported language, no skeleton" report.
- OOS-002: Parsing the plan's free-form Component Design `**Interface:**` blocks as a signature source (approach B).
- OOS-003: Skeletonizing internal helpers or non-exported structure.
- OOS-004: Binding non-function exports as skeleton targets (constants, classes, type re-exports). Frozen ADTs are still enforced by the shadowing and re-listing checks; they are just not skeleton targets.
- OOS-005: Skeletons for test files.
- OOS-006: Rewriting, augmenting or reformatting files that already exist when a Wave starts.
- OOS-007: G3 exemplar anchoring.
- OOS-008: Changing Acceptance Freeze or Contract Revision semantics, beyond re-validating bindings and refreshing untouched skeletons on revision.
- OOS-009: A separate user-facing command just to generate skeletons.
- OOS-010: Any new waiver, override or bypass for the signature and ADT checks.
- OOS-011: Files whose bindings span more than one contract's types file. These are refused, not supported.

---

## Open Questions

Each of these is marked once, inline, at the scenario it affects:

1. Java bound-member shape: see AS-016.
2. When during the contract Task the engine writes the contract stubs: see AS-043.

Resolved 2026-11-02: re-declaring two or more of a frozen ADT's variants is a violation (AS-036, FR-016). Bound files in other languages get no file (AS-040), and contracts with `Types file: none` are exempt from the signature and ADT checks (AS-039).

---

## Dependencies

- G1: the contract Wave and its declarations-only types file.
- The Acceptance Freeze stamped by the contract Wave Gate (ADR-0044).
- The declared-artifact proof and its existing waivers and attestation arm.
- `helper revise-contract` (Contract Revision).
- `helper orchestration status` and brief rendering.
- ADR-0020 (freeze only what consumers need), ADR-0042 (compiler access through pure seams), ADR-0043 (purity linter).

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| The ADT re-listing check flags legitimate local types (for example, a view-model that happens to share variant names) | Med | Trip only at two or more re-declared variants, name the frozen-type remedy in the diagnostic, and add fixtures for near-misses |
| The Java check is less precise than the TypeScript one, so the two languages behave differently | Med | One shared fixture matrix with the same reasons for both languages (SC-006) |
| Contract stubs written before the freeze drift from the frozen types | Med | Treat stubs as skeletons, so the US5 and US6 checks apply to them in the owning implementation Wave |
| Stale skeletons after a revision are ignored by implementers | Low | Show stale flags in status and the brief; completion checks still enforce the revised aliases |
| Implementers satisfy the marker check by replacing the marker with another throw | Low | Accepted. AS-025 allows other throws by design, and acceptance tests remain the behavioral bar |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Skeleton | An engine-written file at a not-yet-existing file_list path that imports the frozen types and declares each bound export with its frozen type and an unimplemented body |
| Export Binding | A plan File Structure entry `name: AliasFn` that ties one export of a file to a function-type alias in the frozen types file |
| Frozen types file | The declarations-only types file that the contract Wave freezes and the Acceptance Freeze stamps |
| Frozen ADT | An algebraic data type declared in the frozen types file: a TypeScript discriminated union or branded type, or a Java sealed interface, record or permitted variant |
| Unimplemented marker | The exact text `unimplemented: <name>` carried by a skeleton export's body until the implementer replaces it |
| Skeleton outcome | The single recorded result for a new file_list path: skeleton written, or one of the four reported fallback reasons |
| Stale skeleton | A skeleton an implementer modified before a contract revision changed its frozen types; it is left untouched and flagged |
| Shadowing | An implementation file declaring its own type with the same name as a frozen ADT or one of its variants |
| Re-listing | An implementation file declaring a local union or sealed hierarchy that re-declares two or more of a frozen ADT's variants, forming a parallel hierarchy |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-11-02 | Initial draft from brainstorm and operator interview (Java in scope, ADT enforcement added) | specify agent |
