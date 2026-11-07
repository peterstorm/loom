# ADR-0061: One supported-language predicate, parsed once into a SkeletonTarget

## Status
Accepted (2026-11-07). Shipped with the G2 skeletons feature
(`.claude/specs/2026-11-02-g2-skeletons/spec.md`; plan `.claude/plans/2026-11-02-g2-skeletons.md`, AD-15 and
INV-6, closing plan-alignment gap OWN-1; interview Q16b). Related: ADR-0053 (the TypeScript surface seam),
ADR-0054 (the restricted Java lexer) and ADR-0055 (canonical skeleton bytes), which all consume the parsed
target this ADR defines.

## Context
G2 writes skeletons only for files in a language it can generate and judge: TypeScript, and Java under a
`src/main/java/` root (Q16b). Every other bound path reports "unsupported language, no skeleton" (AS-040). The
question "is this path a skeleton target, and in which language" is asked in many places:

- **Outcome derivation.** `outcomes.ts` (AD-13 step 4) has to name a bound but unsupported path
  `unsupported-language`, and the status report and the brief render that outcome.
- **Conformance scope.** `scope.ts` (AD-11) has to decide which of a Task's production files are TypeScript
  or Java, so it knows which ones owe completion conformance.
- **Generation.** Spawn materialization, the contract stub step (AD-9) and the Contract Revision refresh
  (AD-10) each choose a generator, and for Java they need the package and class name the bytes declare.
- **Frozen surface reading.** `frozen-surface-observation.ts` has to pick the TypeScript reader (ADR-0053) or
  the Java reader (ADR-0054) for a contract's types file.
- **State File parsing.** A stored skeleton record names a language, and the parser has to refuse a record
  whose language disagrees with its path.

These answers must agree. Suppose the outcome derivation calls a `.mts` file supported but the generator does
not, or the scope treats `src/test/java/C.java` as Java while materialization skips it. Then the engine reports
a skeleton it never wrote, or judges conformance on a file that never had one. The early design had exactly
this gap. `java-surface.ts` carried its own `javaPackageOf`, and each module was about to grow its own
extension check, which would have made four copies of one rule (plan-alignment OWN-1).

The Java case is more than an extension test. The package comes from the path segments after the first
`src/main/java/` run, the class from the basename, and both get spliced into generated source. A segment that
is not a Java identifier, or is a reserved word, would produce bytes that do not compile. So the decision has
to check those names, not just classify them, and generation has to be unable to receive a target that skipped
the check.

## Options Considered

1. **A per-module extension check, including the old `javaPackageOf` in `java-surface.ts`.**
   - Pros: Each module is self-contained, and no new module or shared type is needed. A local check can be
     tailored to the module, for example the reader only needing the Java package.
   - Cons: Four or more copies of one rule (OWN-1). Nothing stops them drifting: adding `.cts`, excluding
     `.d.ts`, or allowing a module prefix before `src/main/java/` would have to land in every copy at once.
     Drift shows up as contradictory outcomes rather than errors. The Java reader would also be classifying
     paths, which is not its job: ADR-0054 has it read text only. Name validity would be checked in some
     copies and not in others.

2. **Fold the predicate into `outcomes.ts`.**
   - Pros: One copy. The outcome derivation already needs the answer, and the other modules could import it
     from there.
   - Cons: It mixes two rules in one owner module. Outcome precedence (INV-4) and language support (INV-6)
     change for different reasons and have different sibling sets: `scope.ts` and the types-file reader need
     the language decision but name no outcome. Generation, scope and observation would depend on the outcome
     module for a decision that is not about outcomes. One invariant per owner rule is the plan's convention.

3. **A boolean `isSupported(path)` predicate in its own module, with each consumer deriving the language and
   Java names itself.**
   - Pros: One place decides "supported or not", and the module is small.
   - Cons: Validate rather than parse. Every consumer still re-derives the language from the extension and the
     Java package and class from the path, so the rule is split again, only one level down. A generator can
     still be called with a path that never went through the predicate, because a `string` carries no proof.

4. **One parsing predicate, `skeletonLanguageOf(path): SkeletonTarget | UnsupportedTarget`, in
   `engine/src/core/skeleton/language.ts`, returning a branded target (chosen).**
   - Pros: Parse, don't validate. The language, the Java package and the class name are computed once, the
     names are proved valid, and the result is carried as a value. The brand makes the target impossible to
     build anywhere else, so `generateSkeleton`, `judgeConformance` and `resolveBindings` cannot be handed an
     unparsed path. The unsupported case carries a typed reason that the outcome and the status report can
     show. One owner module, one matrix test.
   - Cons: A new module and a branded type that every consumer has to thread through. The brand is a
     compile-time device that a cast can defeat, so it is enforced by review and by the INV-6 matrix test, not
     by the runtime.

## Decision
**`engine/src/core/skeleton/language.ts` exports `skeletonLanguageOf`, the one supported-language predicate and
the only constructor of the branded `SkeletonTarget`. Every site that needs a language decision calls it, and
every consumer of the decision takes the parsed value.**

- **Types (`engine/src/core/skeleton/types.ts`, CT-1, frozen).**
  - `TsSkeletonTarget = { kind: "supported"; language: "typescript"; path }`.
  - `JavaSkeletonTarget = { kind: "supported"; language: "java"; path; package: string | null; className }`.
    `package` is null for the default package.
  - `SkeletonTarget = TsSkeletonTarget | JavaSkeletonTarget`. Both carry a `unique symbol` brand that is
    declared and never exported, so no module outside `language.ts` can build a target without a cast.
  - `UnsupportedTarget = { kind: "unsupported"; path; reason }`, where `UnsupportedReason` is
    `"other-extension" | "java-outside-main-root" | "java-invalid-name" | "jvm-non-java"`.
  - The signature is the frozen alias `SkeletonLanguageOfFn = (path) => SkeletonTarget | UnsupportedTarget`.
- **The rule.**
  - The extension is the basename's text from its last dot, provided that dot is not the first character.
  - TypeScript: `.ts`, `.tsx`, `.mts` or `.cts`, except a `.d.ts`, `.d.mts` or `.d.cts` declaration file.
  - Java: a `.java` file under the first `src/main/java` segment run in the path, so a module prefix such as
    `billing/src/main/java/...` is allowed. The package is the segments after that root joined with `.`, and
    the class is the basename without `.java`. Every package segment and the class name must be a Java
    identifier and not a reserved word, contextual `_` or a literal. If one is not, the reason is
    `java-invalid-name`. A `.java` file with no such root, such as `src/test/java/C.java` or `lib/C.java`, is
    `java-outside-main-root`.
  - `.kt`, `.kts` and `.scala` are `jvm-non-java`. Everything else is `other-extension`.
  - Results are frozen. The function is pure and lives under `engine/src/core/skeleton/`, which the purity
    linter lists (INV-2).
- **Refinements of plan AD-15.** AD-15 named only the TypeScript extensions `.ts`, `.tsx`, `.mts` and `.cts`,
  a Java target with `package` and `className`, and three unsupported reasons (other extension, Java outside a
  `src/main/java/` root, Kotlin or Scala). The shipped rule refines AD-15 with five additions. Each one narrows
  or makes explicit what AD-15 left open, and none widens what is supported:
  1. `.d.ts`, `.d.mts` and `.d.cts` declaration files are excluded from TypeScript, so they are
     `other-extension`.
  2. A fourth reason, `java-invalid-name`, separates a Java path whose package segment or class name cannot be
     spliced into source from one outside the main root.
  3. Every Java package segment and the class name are validated as Java identifiers that are not reserved
     words, contextual `_` or literals (`JAVA_RESERVED` and `isJavaName` in `language.ts`).
  4. Both target variants and `UnsupportedTarget` carry `kind` (`"supported"` or `"unsupported"`) and `path`
     fields, so a consumer can discriminate the result and needs no second argument.
  5. `JavaSkeletonTarget.package` is nullable (`string | null`), and `null` is the default package. AD-15's
     interface sketch typed it as `string`.
- **Sites that decide (INV-6 siblings), all calling `skeletonLanguageOf`:**
  - `engine/src/core/skeleton/outcomes.ts`: AD-13 step 4, a bound path that parses as unsupported is
    `unsupported-language` and carries the reason.
  - `engine/src/core/skeleton/scope.ts`: AD-11, which production files and which types file are TypeScript or
    Java for conformance.
  - `engine/src/orchestration/skeleton-materialization.ts`: parses each bound path into the target it
    generates at registration. The Contract Revision refresh in `engine/src/handlers/helpers/revise-contract.ts`
    reuses these candidates.
  - `engine/src/orchestration/contract-stub-materialization.ts`: parses each bound path at the contract Task's
    stop.
  - `engine/src/orchestration/frozen-surface-observation.ts`: picks the TypeScript or Java reader for a types
    file.
  - `engine/src/orchestration/contract-conformance-observation.ts` and `engine/src/state-file-wire.ts`: the
    first skips conformance for a contract whose types file is unsupported, and the second refuses a stored
    skeleton record whose path is no target or whose language disagrees with its path.
- **Consumers that never decide.** `generateSkeleton` (`generate.ts`) takes a `SkeletonTarget`, so it has no
  language refusal of its own, and its Java bytes splice only names the predicate proved valid.
  `judgeConformance` (`conformance.ts`) receives each `ConformanceFile` with its target. `resolveBindings`
  (`resolve.ts`) receives a surface already tagged with its language. `java-surface.ts` reads text and never
  classifies paths, and the old `javaPackageOf` is gone.
- **Invariant and tests.** INV-6 (advisory tier) names `language.ts` as owner.
  `engine/tests/core/skeleton-language.test.ts` covers the rule.
  `engine/tests/core/skeleton-language.matrix.test.ts` runs one path table (`.ts`, `.tsx`, `.mts`, `.cts`,
  `src/main/java/a/b/C.java`, `src/test/java/C.java`, `lib/C.java`, `.kt`, `.scala`, `.rs`) through the owner
  and every sibling: outcomes, scope, spawn materialization, frozen-surface observation, contract stubs and
  revision refresh. Each row must give the same supported or unsupported verdict and the same Java package, so
  a change to the predicate fails at every row.

## Consequences

**Positive:**
- The AS-040 outcome, the conformance scope, the generator's input and the types-file reader all follow from
  one decision, so they cannot disagree. Widening support later, for example to another Java root or another
  language, is one edit in one module plus new matrix rows.
- Generated Java cannot carry an invalid package or class name. Validity is proved where the target is built,
  and the type makes it impossible to skip that step without a cast.
- Downstream modules are simpler. The generator, judge and resolver have no language branches on raw paths
  and no "unsupported" error arms that could drift from the outcome. Their tests build targets through the
  real predicate instead of faking a classification.
- The unsupported reason is a typed value, so the status report and the brief can say why a bound path gets no
  skeleton, not just that it gets none.
- State File parsing reuses the same rule, so a hand-edited record cannot claim a language its path does not
  have.

**Negative:**
- The brand exists only at compile time. A cast (`as SkeletonTarget`) elsewhere would defeat it, and
  `language.ts` itself mints through two casts. Review and the INV-6 matrix test are the guard. INV-6 is
  advisory: no lint rule forbids an inline extension check in a new module.
- Every site that needs a decision depends on `language.ts`, and the matrix test has to grow a row whenever a
  new sibling appears. Forgetting to add one leaves that sibling unchecked.
- The rule is deliberately narrow. A Java project with a different source root (Gradle source sets with custom
  directories, `src/java/`), Kotlin and Scala files, and TypeScript declaration files all get no skeleton.
  Their Tasks lose the frozen-signature guarantee and fall back to conformance-free completion for those
  files.
- Some decisions are recomputed. Several sites parse the same path in one engine call. This is cheap and
  pure, so caching was not worth adding, but it means the parsed value is not threaded end to end in every
  flow.
