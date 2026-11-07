# ADR-0054: Java restricted lexer, frozen holder shape and typed static final constant per binding

## Status
Accepted (2026-11-07). Shipped with the G2 skeletons feature (plan
`.claude/plans/2026-11-02-g2-skeletons.md`, AD-7; interview Q6a, Q14a, Q16b, Q18a; resolves AS-016,
supports AS-009 and SC-006).

## Context
G2 writes a skeleton for every export binding before an implementation Task starts. Each skeleton holds
the bound names, typed by the frozen contract aliases, with bodies that throw an "unimplemented" marker.
When the Task completes, the conformance judge checks that every bound name is still there with its frozen
type and that no marker remains. TypeScript has a natural shape for this: `export const name: Alias = …`,
read through the existing compiler-API seam (ADR-0042). Java needs its own answers to three questions.
How does the engine read a Java types file and a Java implementation file? Which types-file shapes does
it accept? What Java construct is a "bound member" that javac can check against the frozen signature?

Several forces apply. Everything under `engine/src/core/skeleton/` is pure core: no filesystem, no child
processes, no toolchain, so the engine cannot run `javac` to learn a signature. Q14a forbids a new
dependency, which rules out a Java parser package. SC-006 requires the conformance violations and their
reasons to be the same in both languages. The plan lists Java/TypeScript parity drift as a risk, so the
Java check should be the TypeScript check with different syntax, not a second design. Java also has its
own constraints. A file may declare only one public top-level type. A default-package type cannot be
imported (JLS 7.5). Functional interfaces may inherit their single abstract method. Comments, strings,
text blocks and unicode escapes can all hide or fake declarations.

Java source roots and other JVM languages are out of scope for the reader. Whether a path is a Java
skeleton target at all (`src/main/java/` only; Kotlin, Scala and other roots report "unsupported
language, no skeleton", Q16b) is decided once by AD-15's `skeletonLanguageOf` in
`engine/src/core/skeleton/language.ts`. This ADR covers only how Java text is read and what bytes are
written for a target that predicate already accepted.

## Options Considered

1. **A restricted, hand-written pure lexer and declaration reader, a single frozen holder, and one typed
   `public static final` lambda constant per binding (chosen).**
   - Pros: No new dependency and no toolchain I/O, so it stays in the pure core. The bound member
     `public static final Alias name = (p0, p1) -> { throw … }` has the same shape as TypeScript's
     `export const name: Alias`: a name, a declared type token and an initializer that holds the marker.
     Both languages therefore share one conformance check and one set of reasons (SC-006). javac checks the
     lambda against the alias's single abstract method, so the signature is compiler-checked, not compared
     as text. Requiring one holder makes every alias importable as `<package>.<Holder>.<Alias>`, and any
     other file shape is refused by name rather than guessed at.
   - Cons: The engine owns a partial Java grammar, about 1,200 lines, that has to track the language
     features it claims to read. Frozen Java types files must use the holder layout, which is a convention
     that contract authors have to follow.

2. **A static method that mirrors the single abstract method, plus an anchor constant.**
   - Pros: It reads as ordinary Java, and the method body is where an implementer expects to write code.
   - Cons: The signature lives in two places, the method and the anchor, and they can drift. Conformance
     would need to compare the method's parameter and return types to the alias as text, without javac's
     help. It would also diverge from the TypeScript check, so the two languages would report different
     reasons.

3. **A class that implements the functional interface.**
   - Pros: javac checks the signature through `implements`.
   - Cons: It allows one binding per class, so each binding needs its own file or nested class, and
     binding names no longer map to member names. Neither fits a skeleton that holds every binding for a
     file.

4. **A Java parser package (for example a JavaParser-style library) or invoking `javac`.**
   - Pros: Full-fidelity parsing, and javac would give exact signatures.
   - Cons: A parser package is a new dependency (forbidden by Q14a) and a new per-file package grant in the
     pure core. `javac` is toolchain I/O that cannot run in the pure core, and it would make skeleton
     generation depend on a JDK being installed and configured.

## Decision
**Java is read by a restricted pure lexer and declaration reader. A frozen Java types file must be one
top-level holder, and each binding becomes a typed `public static final` lambda constant in one
`public final class <FileBasename>`.**

**The reader: `engine/src/core/skeleton/java-surface.ts`.** It is pure, and every stage returns a
`DomainResult`.
1. Unicode escapes (`\uXXXX`) are translated first, everywhere, as javac does. A malformed escape is
   `unparseable`.
2. The lexer blanks comments. String literals, char literals and text blocks each become a single token
   that keeps its decoded value, with incidental whitespace stripped from text blocks, so markers can
   still be detected. Nothing inside a comment or literal can reach the declaration reader.
3. The declaration reader reads `package` and `import` lines and every type declaration (`class`,
   `interface`, `record`, `enum`, `@interface`). For each one it records modifiers, `sealed`/`non-sealed`,
   supertypes and `permits`, with nested permitted subtypes inferred when `permits` is absent. Its members
   are methods (parameter types, generic-ness, whether there is a body), fields (type token and initializer
   span) and nested types, plus local and anonymous-class types inside bodies. Expressions and statements
   are skipped as balanced token groups.

It exposes two entry points:
- `readJavaTypesSurface(path, text)` returns the package, the holder name, every nested alias with its
  `AliasShape`, and the frozen ADTs (sealed interfaces with their variants, and records).
- `readJavaImplementationSurface(path, text)` returns the package, the imports, the fields of the
  top-level type named after the file's basename (with interface fields' implicit `public static final`
  added), and every type declared at any depth. The conformance judge
  (`engine/src/core/skeleton/conformance.ts`) uses those types to detect frozen-ADT shadowing and
  re-listing.

The reader never classifies paths. The basename is used only to name the class whose fields are the bound
members.

**The frozen holder.** A frozen Java types file declares exactly one top-level `public interface` or
`public final class`, the holder, and every functional interface, sealed interface and record is nested
inside it. A file with no top-level type, more than one, or one of any other kind is refused at stage two
with `unsupported-holder-shape` and a detail that names what was found. The engine never guesses.
(Implementation note: the shipped rule requires `public` on a holder class as well. The plan seed said
"`final class`". A non-public holder could not be imported from the skeleton's package, so the stricter
form is the one that works.)

**Bindable aliases.** An alias can be bound only if it is a holder-nested, non-sealed interface with
exactly one abstract method that is non-generic, on an interface that is itself non-generic. Public
`Object` methods are ignored (JLS 9.8). Abstract methods inherited from interfaces declared in the same
file are counted, and methods are told apart by override-equivalence (name plus erased parameter types,
with the parent's type arguments substituted). An interface that extends a type the file does not declare
reads as `not-a-function`, because its abstract methods cannot be read from this text. A non-function or
generic alias is the AS-009 refusal.

**The bound member (AS-016), written by `engine/src/core/skeleton/generate.ts`.**

```java
// Skeleton written by Loom from <types file> (<contract>). …
package <target package>;

import <types package>.<Holder>.<Alias>;

public final class <FileBasename> {
    private <FileBasename>() {}

    public static final PriceOrderFn priceOrder = (p0, p1) -> {
        throw new UnsupportedOperationException("unimplemented: priceOrder");
    };
}
```

- The lambda has one parameter (`p0`, `p1`, …) for each parameter of the single abstract method, and javac
  enforces the full signature.
- Imports are sorted and unique, bindings are in plan order, line endings are LF, and there is no
  timestamp (AD-8). When the holder is in the default package it cannot be imported, so each member is
  typed `Holder.Alias` and no import is written.
- The target's package and class name come from the `SkeletonTarget` that `skeletonLanguageOf`
  (AD-15, INV-6) has already validated, so generation is total.

**Shared conformance check.** For Java, a bound name conforms when the file's class has a `static final`
field with that name, its type token resolves to the frozen alias, and its initializer no longer contains
the marker. This is the same three-part check TypeScript uses, with the same reasons.

## Consequences

**Positive:**
- No new dependency and no toolchain I/O. The Java reader sits in the pure core next to the TypeScript
  seam, and the purity linter covers it.
- One conformance algorithm and one set of violation reasons for both languages. That meets SC-006 and
  closes off the parity-drift risk structurally.
- Signatures are checked by javac through lambda typing, not by comparing text, so a wrong parameter or
  return type fails at compile time in the implementer's own build.
- Unsupported shapes (a bad holder, a non-functional or generic alias) are refused by name at stage two,
  so the operator sees a named diagnostic before any Task runs.
- The reader is immune to declarations hidden in comments, strings, text blocks or unicode escapes.

**Negative:**
- The engine maintains a partial Java grammar. New Java syntax that the reader does not handle surfaces as
  `unparseable` until the reader is extended, and the reader can lag the language.
- Contract authors must put Java contracts in the holder layout. Existing Java code that spreads
  functional interfaces across top-level files cannot be frozen as-is.
- Override-equivalence uses simple names after erasure, so two distinct types that share a simple name
  read as the same type. This is an accepted imprecision.
- An alias that extends an interface declared in another file is not bindable, even when javac would
  accept it as a functional interface.
- Implementers write their logic inside a lambda in a static field, not as an ordinary method. This is
  idiomatic enough for functional interfaces, but less familiar than a method body.
- Only `src/main/java/` roots are supported (AD-15). Projects with other source layouts, and Kotlin or
  Scala code, get no Java skeletons.
