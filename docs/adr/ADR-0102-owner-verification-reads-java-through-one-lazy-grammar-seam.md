# ADR-0102: Owner verification reads Java through one lazy grammar seam

## Status
Accepted (2026-11-23). Extends ADR-0036 and ADR-0071 to Java; leaves ADR-0054 as it is.

## Context
Issue #254: a Java 25 / Maven project (alert-bridge) reached an owned invariant's Wave Gate and the gate
blocked on two failures that were both false. The owner GatedDecision.java was reported
`owner-unparseable`, and the matrix test was reported as not importing the owner although it did
(`import dk.secondbrand.alertbridge.domain.decision.GatedDecision;`). The cause was not the project: owner
verification was TypeScript-only in four places.

- `core/owner-verification/import-graph.ts` parsed modules with the TypeScript compiler API, the only edge
  source.
- `coverage.ts` resolved only TypeScript specifiers: relative paths, tsconfig `paths`, the extension ladder.
- `mutation-plan.ts` found sites on a TypeScript tree and its replacements were TypeScript text
  (`return undefined`, `===`), so any Java owner came out `owner-unparseable`.
- The Task mutation check skipped every non-TypeScript file by design, by extension list.

The gap is structural, not a missing extension or two. Coverage needs Java's own reach rule (no re-exports:
a file is reached by naming it), and the plan needs the exact span and a replacement that the Java compiler
accepts, on the changed lines only. Text matching cannot give either: a `true` inside a text block is not a
boolean literal, and `<` inside a generic type is not a comparison.

Constraints. Everything owner verification does under `engine/src/core/` is pure: no filesystem, no child
process, no toolchain, so `javac` cannot be asked. The existing seams parse already-read text
synchronously (`ts.createSourceFile`); an async grammar would force every caller of the plan and the
coverage rule to become async for one language. The linter hooks load the engine on every edit, so a grammar
must be paid for only by an obligation that reads Java (ADR-0095 takes the same measure).

## Options Considered

1. **Extend the restricted Java lexer from ADR-0054.**
   - Pros: No new dependency; Q14a's constraint holds by construction.
   - Cons: The lexer reads declarations, not expressions. Mutation sites need statement and expression
     structure, operator classification and pattern scoping; a hand-written reader for that is a parser
     project with its own bug surface, and it would become a second Java reader beside the skeleton's. Q14a
     forbids a new dependency *for the skeleton feature*, whose question was a declaration shape; owner
     verification's question is a syntax tree, and its decision was left open by the issue.

2. **A tree-sitter Java grammar.**
   - Pros: A real grammar; small and fast.
   - Cons: The WASM build loads asynchronously (`Parser.init()`, `Language.load(wasmBytes)`), so the pure
     seams would have to become async. The native binding loads under Node but not under Bun 1.4, the
     runtime the engine's own suite runs on. Either way the engine gains a build step or loses a runtime.

3. **`java-parser` 3.0.1, a Chevrotain grammar for Java 21, required lazily through one pure seam
   (chosen).**
   - Pros: Synchronous `parse()` over raw text; a real Java 21 grammar (generics, lambdas, switch
     expressions and patterns, records, sealed types, text blocks); CST nodes carry offsets, so mutation
     spans are exact UTF-16 indices with no byte conversion; loads under Node 22 and Bun 1.4; required on
     first use, so an edit's lint hook never pays for it.
   - Cons: A new runtime dependency with a closure of Chevrotain and lodash; the grammar's own utils
     module reads `process.env` at load to toggle its grammar self-checks, and two lodash helpers it never
     calls reference `Math.random` and `Date.now`.

## Decision
**Java enters the engine through one pure, parse-only seam,
`engine/src/core/owner-verification/java-syntax.ts`, granted the exact `java-parser` specifier and
`node:module` by the boundary config. Like the TypeScript compiler seams (ADR-0042), the package is a
capability granted per seam, not a package-prefix allowance: `machine-purity.test.ts` walks it as such and
proves a non-seam module that imports `java-parser` is refused.**

- **One projection.** `parseJava(text)` returns the file's package, its imports (`class`, `static-member`,
  `static-wildcard`, `class-wildcard`), the identifiers and dotted names used outside `package`/`import`
  declarations, and every mutation site as `(operator, start, end, replacement)`. A grammar refusal is one
  `java-syntax-error` diagnostic, never a throw; a grammar that cannot load, or any other internal error,
  throws, and the shell reports it as `unexpected-error`, so a broken install is never the owner's syntax.
  An identifier or keyword spelled with `\uXXXX` escapes is refused because javac decodes escapes before
  lexing and the grammar reads raw text. A name is every token the grammar files under its `Identifier`
  category, contextual keywords included, so a package such as p.record or p.module keeps every segment.
- **Language picks the reader.** `language.ts`'s `ownerLanguageOf` classifies a path from the path alone:
  the TypeScript and JavaScript extensions, `.java` under a Maven main or test source root (module prefixes
  allowed), and one unsupported reason otherwise. A Java classification carries the file's identity
  (`javaFileIdentityOf`: its source root, package, simple name and fully-qualified name, which is what an
  import is compared against). One obligation reads one language; `obligationLanguageOf` decides it once
  from the matrix test and the due paths (the owner first), and a mixed family, or a path no reader reads,
  is `unsupported-language`, never `owner-unparseable`. A Java family's reading carries every path's
  identity, so the reach rule is never handed a path it cannot read.
- **Java's reach rule has its own home.** `java-reach.ts` decides reach by naming: an explicit import of the
  file or a nested class of it, a static import of one of its members, a wildcard-imported package with its
  simple name used, the same package with its simple name used, or its fully-qualified name written out.
  For a Java family, `coverage.ts` reads the matrix test's bytes for reach and checks that each due path
  exists and is readable (an absent path is missing, an unreadable one is that read's infrastructure
  failure); it never walks imports and never loads the tsconfig. The aliases reach coverage through a lazy
  port the TypeScript arm alone calls, after the language is decided, so a broken tsconfig can neither block
  a Java family nor mask an `unsupported-language` refusal.
- **The plan stays language-blind.** `mutation-plan.ts` keeps the operator sets, the changed-line filter,
  the cap and the mutant id; it dispatches to the reader and maps both readers' sites to the same
  `ReportedSite`. The Task mutation check's `isMutableSource` asks the language predicate and, for Java,
  accepts only a `main` source root, because the frozen test-file classification cannot see a Java test.
- **Operator texts are per language.** `return-value-replacement` is `!(e)`, `0` or `null` by the method's
  declared return type, and offers nothing in a `void` method; `comparison-flip` has no `===`; a condition
  that declares a pattern variable offers no `condition-negation`, `guard-removal` or `logical-swap`,
  because each would put the variable out of scope, or leave it not definitely matched, where it is used.
- **What the seam can prove.** It resolves no symbol and runs no compiler, so it proves only that every
  mutant still parses (a property test holds it to that), and it withholds every site it knows javac
  rejects: the constant-`true` loop conditions, every site inside a `try` block whose handlers catch, the
  pattern-variable sites above, a removed plain assignment in a constructor or initializer (a final field's
  one assignment) or to a local declared without an initializer (its definite assignment), and a removed
  `break` guard inside a loop whose condition is absent or the constant `true`. A mutant javac still
  rejects for a reason no rule reads is an invalid run, never a kill.

## Consequences

**Positive:**
- A Java owner and its Java matrix test are verified like a TypeScript family: the reported false failures
  of issue #254 cannot recur, because coverage reads the same import the compiler does and the plan reads
  spans from a grammar instead of failing to parse at all.
- The Java grammar is paid for only by an obligation that reads Java, and the purity audit keeps it out of
  every other module, exactly as the compiler seams are held.
- The seam is deterministic: same bytes, same projection; a refused file is data, so a broken matrix test
  names its diagnostics instead of reaching nothing silently. Only a grammar that cannot load, or an
  internal error, throws, and the shell names it `unexpected-error`. A test in a fresh process pins that the
  grammar loads only when Java text is parsed.

**Negative:**
- A new runtime dependency (ten packages) whose closure the purity audit treats as a capability rather than
  a byte-audited runtime. The two impurity sites are load-time and unreachable from the projection: the
  grammar's self-check toggle, and lodash helpers the grammar never calls.
- The grammar is Java 21, not 25. A construct it cannot read is refused as `owner-unparseable`, which blocks
  the gate honestly rather than mutating from a garbled tree.
- Reach by "simple name used" is a name-level approximation: a same-package class whose name appears only as
  an unrelated identifier reads as reached. It can only over-report reach for one due path, never
  under-report an import the compiler honours.
