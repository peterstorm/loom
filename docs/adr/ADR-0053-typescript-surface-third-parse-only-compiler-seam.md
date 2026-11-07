# ADR-0053: TypeScript enters through a third parse-only compiler seam

## Status
Accepted (2026-11-07). Shipped with the G2 skeletons feature
(`.claude/specs/2026-11-02-g2-skeletons/spec.md`, FR-003, FR-006, FR-015, FR-016, FR-017, NFR-020; plan
`.claude/plans/2026-11-02-g2-skeletons.md`, AD-6, INV-1 and INV-2; interview Q1a). **Amends ADR-0042**:
INV-1 now names three TypeScript compiler API seams instead of two. Everything else in ADR-0042 still holds:
the parse-only contract, one seam list with three enforcement points, the exact-specifier grant, the test
exemption and the `^5.9.0` runtime dependency.

## Context
G2 has to read the declarations in TypeScript files, which neither existing seam does:

- **Frozen types files (FR-003, FR-017).** Stage-two resolution checks that every bound alias is declared in
  the frozen types file as a function type, and refuses a generic one (AS-009). The conformance judge also
  needs the file's frozen ADTs: discriminated unions (the discriminant key, variant tags and named variants)
  and branded types.
- **Implementation files (FR-015, FR-016, FR-022).** At Task completion the judge has to see each exported
  binding: its declaration kind, the bare identifier it is annotated with, where that annotation is imported
  from, and the string literals in its initializer, so a leftover `unimplemented: <name>` marker can be
  found. It also needs every local type, interface, class and enum name, and every local object-member union
  with its discriminant literals, to catch a frozen ADT that has been shadowed or re-listed.
- **Frozen acceptance tests (AD-8).** The generator copies the specifier style (extensionless, `.js` or
  `.ts`) that the first acceptance file uses to import the types file.

These readings have to see past comments, strings, template literals, `Readonly<…>` wrappers,
intersections, same-file type references, interfaces that only look callable, and every export form
(`export const`, `export function`, `export { … }`, `export default`). Character matching gets these wrong,
and a wrong reading produces a wrong verdict: a renamed export accepted, or a correct one refused.

ADR-0042 still applies. Everything under `engine/src/core/` that the purity linter lists is pure, and
`engine/src/core/skeleton/` joins `DEFAULT_PURE_MODULES` in this feature (INV-2). `typescript` is granted one
file at a time through the exact list `TYPESCRIPT_COMPILER_API_SEAMS`. Any other core file that imports it
fails the INV-1 regex rule, the programmatic boundary rule and the machine-purity closure audit. ADR-0042
named exactly two seams, `mutation-plan.ts` and `import-graph.ts`. A third consumer of the parser needs a
recorded decision. The alternatives are a second copy of TypeScript lexing, which ADR-0042 forbids, or
merging concerns into a seam that exists for something else. NFR-020 also requires that expected failures,
such as an unparseable file, come back as values and are never thrown.

## Options Considered

1. **Widen `import-graph.ts` to export declaration surfaces as well.**
   - Pros: Two seams stay two. No change to the seam constant or the rule copies.
   - Cons: It mixes concerns, which ADR-0042 option 2 rejected for the same reason. `import-graph.ts` reads
     module edges for owner-verification coverage. Declaration extraction is unrelated to that. Skeleton
     conformance would come to depend on the owner-verification package, and a change to surface reading
     could break sibling coverage, or the reverse. The module's name would stop describing what it does,
     and its interface would grow wider and shallower.

2. **A hand-written tokenizer or regex reader for TypeScript declarations in `core/skeleton/`.**
   - Pros: No new compiler grant, and the seam list is unchanged.
   - Cons: It would be the second copy of TypeScript lexing that ADR-0042 forbids. It would misread comments,
     strings, template literals, nested generics, multi-line unions, intersections and re-export lists. A
     wrong reading becomes a wrong completion verdict. Java gets a hand lexer (AD-7) only because a Java
     parser package or `javac` would mean a new dependency or toolchain I/O (interview Q14a). TypeScript's
     own parser is already a declared runtime dependency.

3. **A Program or type checker (`ts.createProgram`, `ts.sys`, a language service), run from the shell.**
   - Pros: Real types: an alias that resolves through imports to a function type would be recognised, and
     assignability could be checked rather than read syntactically.
   - Cons: A Program reads the filesystem, so it cannot live in pure core. ADR-0042 option 4 rejected it for
     that reason. Moving the reading into the shell would make conformance untestable without disk fixtures.
     It would also load a much larger and slower part of the compiler at every spawn and every completion,
     which puts NFR-001 and NFR-002 (2 seconds for 20 files) at risk. The judge does not need semantic types.
     Its rules are syntactic by design: a name, its bare-identifier annotation and its import source.

4. **A third named seam, `engine/src/core/skeleton/ts-surface.ts`, parse-only, sharing `parseModule`
   (chosen).**
   - Pros: Real parsing, and each concern lives in its own seam behind a small interface. The
     path-to-script-kind rule keeps one home. The grant is an exact per-file entry, so no other skeleton file
     gains it. The existing lockstep machinery (constant, two rule copies, mirror test, purity audit) carries
     the third entry without new mechanism.
   - Cons: Three files now hold a heavyweight capability. ADR-0042 has to be amended, and three places have
     to be edited in lockstep.

## Decision
**`engine/src/core/skeleton/ts-surface.ts` is the third parse-only TypeScript compiler API seam. It is added to
`TYPESCRIPT_COMPILER_API_SEAMS` and granted `typescript` per file, by exact specifier.**

- **Interface.** All three readers take a path and already-read text.
  - `readTsTypesSurface(path, text): DomainResult<TsTypesSurface, SurfaceProblem>` returns every exported
    type alias and interface with its shape. An alias whose type is a function type is a function alias, and
    it is generic when the alias or the function type has type parameters. Interfaces, callable ones
    included, are never function aliases. It also returns the frozen ADTs. A discriminated union is an
    exported union of two or more object-shaped members that share a string-literal-typed key, and the
    result records the discriminant, the variant tags and the named variants. A brand is a primitive
    intersected with an object that carries a computed (unique-symbol) or `…brand…` key.
  - `readTsImplementationSurface(path, text): DomainResult<TsImplementationSurface, SurfaceProblem>` returns
    every exported name with its declaration kind, its bare-identifier annotation, the import that annotation
    comes from, and the string-literal values of its initializer or body. It also returns every local type,
    interface, class and enum name, and every local named union with the string-literal properties of its
    object-shaped members.
  - `typesImportSpecifier(acceptancePath, acceptanceText, typesPath): SpecifierStyle | null` returns the style
    of the first relative import, in declaration order, that resolves to the types file. It reads that list
    through `import-graph.ts`'s `moduleEdges`, so it adds no second edge reader (AD-8).
  - "Object-shaped" means a type literal, `Readonly<…>` of one, an intersection with at least one
    object-shaped part, or a reference to an object-shaped top-level alias or interface in the same file. A
    reference to an imported type is never object-shaped, because its shape is not in the text.
  - The signatures are the frozen aliases `ReadTsTypesSurfaceFn`, `ReadTsImplementationSurfaceFn` and
    `TypesImportSpecifierFn` in `engine/src/core/skeleton/types.ts`.
- **One parse.** The seam parses through `import-graph.ts`'s `parseModule` and checks `syntaxErrorsOf`. A
  file with syntax errors returns `{ kind: "unparseable", path, detail }`. A compiler that exposes no parse
  diagnostics also returns `unparseable`, so the check fails closed. Neither case throws (NFR-020).
- **Parse-only contract (unchanged from ADR-0042).** The seam calls only `ts.createSourceFile`, through
  `parseModule`, and node visitors. It never uses `ts.sys`, a Program, module resolution, a type checker or a
  language service. Its module header says so. Every reading is syntactic.
- **Callers.** Outside tests, the seam has exactly two importers.
  - The shell `engine/src/orchestration/frozen-surface-observation.ts` reads the frozen types file and
    acceptance texts, then calls `readTsTypesSurface` and `typesImportSpecifier`.
  - The pure judge `engine/src/core/skeleton/conformance.ts` calls `readTsImplementationSurface` and
    `typesImportSpecifier`.
  - `engine/tests/core/skeleton-generate.test.ts` also reparses generated TypeScript through the seam, which
    proves the canonical bytes (AD-8) read back as the bindings they came from.
- **Lockstep enforcement (amends ADR-0042's two-seam list).**
  - `TYPESCRIPT_COMPILER_API_SEAMS` in `engine/src/linter/programmatic/no-cross-boundary-imports.ts` lists
    `import-graph.ts`, `mutation-plan.ts` and `ts-surface.ts`. The core boundary's `perFileExactAllow` grants
    `["typescript"]` to each one.
  - `.claude/linter/rules/inv-1-typescript-compiler-api-seam.json` and its byte-identical mirror
    `.pi/linter/rules/inv-1-typescript-compiler-api-seam.json` list `.test.ts` plus exactly those three paths
    in `excludePatterns`. Their description and fix hint name the surface readers.
    `engine/tests/linter/project-lint-rules.test.ts` fails when either copy drifts from the constant.
  - `engine/src/linter/programmatic/no-io-in-pure-modules.ts` lists `engine/src/core/skeleton/` in
    `DEFAULT_PURE_MODULES` (INV-2). `engine/tests/linter/programmatic/machine-purity.test.ts` proves three
    things: the seam's closure audits clean and reaches `import-graph.ts`, a `typescript` import added to a
    sibling such as `types.ts` is an `unaudited package`, and a widened `typescript/lib/tsserverlibrary`
    import from the seam is refused.
- **Tests.** `engine/tests/core/skeleton-ts-surface.test.ts` exercises the seam over plain strings: function,
  non-function and generic aliases, discriminated unions, brands, every export form, marker literals and the
  specifier style.

## Consequences

**Positive:**
- Frozen-surface resolution, completion conformance and specifier copying all use TypeScript's own parser.
  Comments, strings, template literals, `Readonly` wrappers, intersections and multi-line unions are parsed
  rather than approximated. The engine still has one copy of TypeScript lexing.
- Each seam does one job. Mutation sites, module edges and declaration surfaces live in separate modules, so
  the skeleton feature cannot change owner-verification coverage, and owner verification cannot change
  skeleton conformance. The only shared code is `parseModule` and `moduleEdges`, which is the one shared rule
  ADR-0042 intended.
- The seam is deep: three functions over plain text that return values. Its tests and the conformance judge's
  tests need no fixture repository and no compiler host.
- The grant stays narrow and visible. Three enforcement points name the same three files, and the mirror test
  and the closure audit fail on any drift or widening.
- No new package. `typescript` was already a declared runtime dependency (ADR-0042).

**Negative:**
- Three files now hold the compiler-API grant. Readers have to consult ADR-0042 and this amendment to learn
  why each one exists.
- Adding the seam took coordinated edits to the constant and both rule copies in one Task, because the mirror
  test is red between them. Moving or renaming any seam keeps that cost.
- Parse-only means no type information. An alias that is a function type only after resolving an imported or
  conditional type is not recognised as a function alias. An imported object type is never object-shaped,
  so a union over imported members is not a frozen ADT. Both are accepted limits: frozen types files are
  expected to declare their shapes locally. Type-aware checking would need a shell-side Program and a new
  ADR. Reaching for a Program inside the seam is not allowed.
- The two languages differ. Java is read by a hand-written restricted lexer (AD-7) and TypeScript by the
  real parser, so the two surfaces can disagree on edge cases that each language's tests have to cover
  separately.
- The seam reuses `import-graph.ts` from the owner-verification package, so skeleton core depends on that
  package's exports. Changing the signature of `parseModule`, `syntaxErrorsOf` or `moduleEdges` now affects
  three seams, not two.
