# ADR-0058: Conformance rules are syntactic, list all violations and are scoped by production file and contract

## Status
Accepted (2026-11-07). Records AD-11 of the G2 skeletons plan
(`.claude/plans/2026-11-02-g2-skeletons.md`; spec `.claude/specs/2026-11-02-g2-skeletons/spec.md`,
FR-013 through FR-020, FR-022 and FR-028, interview Q15a and Q16a). Shipped on branch
`feat/g2-skeletons`. The CT-2 contract Task (T2) wrote the acceptance matrix, T8 the judge and T9 the
scope. ADR-0052 (AD-5) covers how the judge's verdicts reach Proof.

## Context

G2 freezes a contract's consumer-facing signatures and ADTs (ADR-0049). It also writes a skeleton for
each not-yet-existing bound path, where every bound export has the frozen signature and an initializer
that throws `unimplemented: <name>` (ADR-0048, ADR-0055). The freeze is only real if completion refuses
a Task that breaks it. That means refusing when a bound export is removed, renamed, given a different
type or left unimplemented. It also means refusing when an implementation file sets up its own
parallel copy of a frozen ADT, by redeclaring its name or listing its variants again (FR-013 to
FR-017). AD-5 / ADR-0052 decided that these refusals go through the existing
`declared-artifact-changed` obligation. It left open what the rules are, how precise they have to be,
how many violations one refusal reports, and which files and contracts a Task is checked against.

Several forces apply. The rules must mean the same thing in TypeScript and Java, so that receipts,
status and the retry appendix can work from one closed set of reasons. The engine core is pure, and
the TypeScript compiler API is allowed in only through parse-only seams (ADR-0042, ADR-0053). Java has
only a restricted lexer (ADR-0054). Neither language has a type checker or a `Program` available. A
false positive blocks a Task that did nothing wrong and costs the operator a manual override. A false
negative only lets a parallel hierarchy or a hollow export through to the acceptance tests, which
remain the behavioural bar. So the rules should catch deliberate shapes and leave ordinary code
alone: view-models, local helper types, and throws that are reached on legitimate paths (AS-025).
Additions must never count as violations (FR-022). A semantic retry is expensive, so one refusal
should give the next attempt everything it needs to fix (FR-028).

Scope has its own pressures. Tests may define fixtures that look like frozen types (OOS-005).
Attested Tasks and documentation-only Tasks produce no code to check (FR-019). Files that already
existed at Wave start get no skeleton, but they are still bound or still in the contract's language
and must still conform (FR-018). Every place that decides "does this Task owe a check, over which
files" has to give the same answer. That includes the settlement observation and the brief's duty
section.

## Options Considered

1. **Syntactic rules over parsed surfaces, every violation listed, a single pure scope owner (chosen)**
   - Pros: Uses only what the parse-only seams already give: export names, declared annotations and
     where they come from, initializer string literals, local type names, union members and `permits`
     lists. The same six reasons cover both languages. Each rule starts from a bound name or a frozen
     name, so new declarations cannot trigger anything (FR-022). Listing everything lets attempt 2 fix
     all of it at once. One scope function means the brief and settlement cannot disagree.
   - Cons: Cannot tell that a structurally identical local type is "really" the frozen one, and cannot
     catch a parallel hierarchy written as a plain string-literal union or with renamed discriminant
     keys. A marker can be dodged by swapping it for a different throw. Both are accepted, stated
     limits.

2. **Type-aware rules (assignability, structural identity)**
   - Pros: Would catch structural copies of frozen ADTs and retyped exports whose annotation names a
     look-alike type. Fewer gaps an implementer could exploit.
   - Cons: Needs a TypeScript `Program` with module resolution and a compiler host, which ADR-0042
     explicitly keeps out of the pure core. Nothing equivalent exists for Java without a JDK
     toolchain. The two languages would end up with different precision and therefore different
     reason sets. Assignability also flags legitimate view-models that happen to be compatible, which
     raises the false-positive rate this design is trying to keep low.

3. **Fail fast on the first violation**
   - Pros: Simpler judge and shorter diagnostics.
   - Cons: Each semantic attempt would see only one problem. A file with three hollow exports and a
     shadowed ADT would use up the retry budget one violation at a time. This contradicts FR-028.

4. **Check every file the Task touches, tests included**
   - Pros: No classification step; a parallel hierarchy anywhere gets caught.
   - Cons: Test fixtures legitimately build sample ADT values and may define helper unions that
     mention frozen tags (OOS-005). Checking them would refuse correct Tasks. It would also make the
     scope disagree with `classifyTaskFiles`, the classification Proof already uses for declared
     artifacts.

5. **Let each caller decide scope locally**
   - Pros: No new shared module.
   - Cons: The brief would promise checks that settlement does not make, or the other way round. A
     new waiver path could quietly exempt Tasks. This is exactly the kind of drift INV-5 is there to
     prevent.

## Decision
**Conformance is judged by one pure, syntactic function that returns every violation per file, over a
scope decided only by `conformanceScope`: the Task's production files that parse to a supported
skeleton language, checked against the frozen contracts the Task binds or claims.**

### The judge (`engine/src/core/skeleton/conformance.ts`)

`judgeConformance({ surfaces, bindings, files }): ContractConformance` is pure. `files` is a list of
`ConformanceFile = { target: SkeletonTarget; text: string | null }`, where `null` means the file is
missing. The judge gets each file's language from its `target` and never classifies paths. It reads
implementation surfaces through `readTsImplementationSurface` (`ts-surface.ts`) and
`readJavaImplementationSurface` (`java-surface.ts`). It returns `{ kind: "judged", violations }`,
where `violations` is a `ReadonlyMap<path, NonEmpty<ConformanceViolation>>` that contains only files
with at least one violation, in input order. A clean run is an empty Map, never an empty array.
`ConformanceViolation = { subject, reason, remedy }` and `ViolationReason` is one closed union shared
by both languages (`engine/src/core/skeleton/types.ts`).

Per bound export, against its contract's surface:

| Reason | Rule |
|---|---|
| `deleted` | No export (TypeScript) or field of the file's class (Java) has the name, or the file is missing or no longer parses. A file that cannot be read proves none of its bound exports (AS-027). |
| `renamed` | The name is missing, and another export or field that is not a bound name of the binding has the same frozen alias annotation. |
| `retyped` | The name exists, but not as `export const name: Alias` (TypeScript) or `static final Alias name` (Java), where `Alias` must be shown to come from the frozen types file or holder. TypeScript import provenance is decided by the single rule `typesImportSpecifier`. |
| `still-unimplemented` | A string literal in the initializer or body is exactly `unimplemented: <name>`. Any other throw passes (AS-025). |

Per frozen ADT of a surface in the file's own language. Frozen ADTs are TypeScript discriminated
unions and branded types, and Java sealed interfaces, records and their permitted variants (FR-017).

| Reason | Rule |
|---|---|
| `shadows-frozen-adt` | A local type, interface, class, enum or record, at any depth, has the name of a frozen ADT or of one of its named variants (FR-015). |
| `re-lists-frozen-variants` | A local union whose object-shaped members use the frozen discriminant key with two or more distinct frozen tags, or a local sealed type that permits two or more frozen variant names (FR-016, AS-036). `RELISTING_THRESHOLD = 2`. The remedy names the fix: `Extract<FrozenUnion, { kind: "a" } \| …>` for a union, or the frozen types imported directly. |

A union of *imported* frozen variant types counts as using the frozen types directly and passes.
Those members are type references, not object-shaped members carrying the discriminant. A local type
that shares only one variant name is caught only by the shadowing rule.

**Every violation is listed** (FR-028). Within each file the order is: signature violations in
binding order, then shadowing, then re-listing. `renderConformanceViolations` produces one diagnostic
per artifact: the path, then each violation's subject, its reason in words and its remedy where it has
one. **Only syntactic checks are made** (Q16a): name lookup, annotation text and its import source,
literal strings, discriminant keys and tags, and `permits` lists. There is no assignability and no
structural typing.

### The scope (`engine/src/core/skeleton/scope.ts`, INV-5 owner)

`conformanceScope(graph, task): ConformanceScope` returns either
`{ kind: "not-owed"; reason }` or `{ kind: "owed"; contracts; bindings; files }`. The `not-owed`
reasons form a closed set: `attested | documentation-only | generated-artifact | no-frozen-contract |
no-file-in-scope`. Every caller uses this function, including `observeContractConformance`
(`engine/src/orchestration/contract-conformance-observation.ts`) and the brief's duty section.

- **Exempt.** An attested Task, or one whose regression is waived as `documentation-only` or
  `generated-artifact`, owes nothing (FR-019, AS-037). Every other waiver still owes the check, and no
  new waiver kinds were added (FR-020).
- **Which files.** `productionFiles(graph, task)` returns the Task's non-test `file_list` paths
  according to `classifyTaskFiles` and the graph's frozen test-file classification (INV-2 of
  G5b/I6). Frozen paths are excluded. `skeletonLanguageOf` (AD-15) must parse each file to a
  supported target. Test files are never in scope (OOS-005).
- **Which contracts.** The contracts the Task binds (through a binding on one of its files) or claims
  as claimant, that have a types file, and whose freeze state is `frozen` or `revised`. A contract
  still `awaiting-red` has no frozen surface yet. A `Types file: none` contract has no surface at all
  (AS-039).
- **Applied when.** The signature check runs on the Task's bound files. The ADT check runs on files in
  the language of an in-scope types file. A file stays in scope only if at least one of the two
  checks applies to it.
- **Wave-start files.** A file that existed at Wave start (outcome "exists, not skeletonized") is
  checked like any other file in scope (FR-018).

## Consequences

**Positive:**
- TypeScript and Java share one closed reason set. Receipts, status, the retry appendix and
  `renderConformanceViolations` all handle `ViolationReason` exhaustively, and a new reason would
  fail to compile at every consumer.
- The judge needs nothing beyond the existing parse-only seams. It stays pure and inside the purity
  linter's coverage (ADR-0043), with no `Program`, no compiler host and no JDK.
- False positives are limited to deliberate shapes. View-models that share one tag, local helpers and
  string-literal unions pass, and new declarations never add a violation (FR-022).
- A single refusal lists every violation along with its remedy, so one semantic retry can fix all of
  them.
- Scope has one owner. The brief's promise and settlement's verdict cannot diverge, and no waiver
  path can be added without changing `scope.ts` and its INV-5 matrix test.

**Negative:**
- Structural copies are not caught. A hierarchy written as a plain string-literal union, one that uses
  a different discriminant key, or a lookalike type under a fresh name all pass. This is a stated
  limit. The acceptance tests are the backstop.
- The `still-unimplemented` check only looks for the marker. Replacing it with a different throw
  satisfies the check without implementing anything. This risk is accepted in the spec's risk table,
  and the acceptance tests remain the behavioural bar.
- `retyped` relies on the text and import source of the annotation, not on what the type means. A
  local alias that re-exports the frozen type under the same name, imported from somewhere else, is
  refused even if it is equivalent.
- The threshold of two or more re-listed tags is a heuristic. A local union that legitimately narrows
  a frozen union to two variants with a hand-written shape is refused, and the remedy steers it to
  `Extract<…>`.
- A missing or unparseable file reports every bound export as `deleted`. That is noisy but accurate:
  none of the exports is proven.
- Contracts whose types file no skeleton language reads contribute no surface, so their ADTs are not
  checked.
