# Plan: G2 — skeletons from the frozen types

**Spec:** .claude/specs/2026-11-02-g2-skeletons/spec.md
**Created:** 2026-11-02

## Summary

The plan's File Structure binds each new implementation file to the exports it provides. Each binding is qualified by its contract and typed by a function-type alias that the contract's frozen types file declares (`**Export bindings:**`, AD-3). Population stamps those bindings into the TaskGraph.

**Skeleton generation (approach B, AD-1).** When the shared spawn reservation admits an implementation Task, the engine first does three things:

- It resolves every binding against the frozen, digest-verified types file (stage two).
- It writes a deterministic TypeScript or Java skeleton at each not-yet-existing bound path of that Task, through one no-clobber writer.
- It records the engine-written digest.

Only then does it capture the attempt baselines. Engine bytes are therefore never implementer writes.

**Contract stubs (AD-9).** The contract Task's SubagentStop writes the contract stubs through the same generator.

**Contract Revision (AD-10).** A revision refreshes untouched skeletons and flags modified ones stale.

**Completion (AD-5, AD-11).** The existing `declared-artifact-changed` obligation gains one failure variant, `declared-artifact-contract-violated`. A pure conformance judge refuses a deleted, renamed, retyped or still-unimplemented bound export. It also refuses a shadowed or re-listed frozen ADT. TypeScript is read through a third parse-only compiler seam (AD-6). Java is read through a hand-written restricted lexer (AD-7).

**Reporting (AD-13).** Every file_list path gets exactly one skeleton outcome, from one pure derivation. The brief and `helper orchestration status` both show it.

---

## Architectural Decisions

### AD-1: Skeletons materialize per Task inside the shared spawn reservation (approach B, chosen at the approach gate)

**Choice:** `registerTaskExecutionBatch` (`engine/src/handlers/task-execution.ts`) is the one registration shell that Claude Code (`validate-task-execution` PreToolUse, after brief-marker expansion) and Pi (`pi/spawn-lifecycle.ts`) both call. It runs one new step, `materializeTaskSkeletons` (`engine/src/orchestration/skeleton-materialization.ts`). The step runs after the ownership and eligibility checks and before `captureRepositoryChangeBaseline` and the declared-artifact baseline captures.

The step does three things:

1. **Stage two.** It resolves every stamped binding whose contract is `frozen` or `revised` against that contract's types file. The file's bytes must equal the freeze stamp. Any missing alias, non-function alias or digest drift blocks the spawn, with every problem named.
2. **Writes.** It writes each missing skeleton of the spawning Task through the no-clobber writer (AD-12). This covers the first attempt, a retry whose skeleton was deleted (FR-032) and infrastructure respawns alike.
3. **Records.** It returns the skeleton records and the Task's skeleton outcomes. These are committed in the same locked update as the reservation (`createTaskExecutionAuthorityBatch` / `applyTaskExecutionAuthorityBatch` carry them).

Status and the brief show outcomes that are not yet recorded through the same pure derivation (AD-13), so every path has exactly one outcome (FR-030) before and after its spawn, shown in status and the brief (FR-040).

**Why:** It is the only placement with one Wave-start entry point covering both harnesses, retries and respawns. The attempt baselines are captured after the skeleton exists, so FR-012's attempt-scope half holds by construction. It never touches the Wave Gate completion commit (ADR-0044). It ranks best on the user's primary axis, simplicity (Q3a).

**Rejected:**
- A — a shell effect after the previous gate's completion commit (and after population). Writes would sit beside the most delicate locked commit. A crash between commit and effect needs a recovery path, which is B anyway. It means three writer entry points, more coordination on revision, and roughly +30% effort.
- C — a status-gated `materialize-wave-skeletons` recovery before `spawn-wave-implementation`. It widens the most-read status union and the orchestrator runbooks, still needs a retry path in the spawn, and leans on OOS-009. Roughly +20% effort.

### AD-2: Skeletons freeze only consumer-facing signatures and ADTs (refines ADR-0020, FR-043)

**Choice:**
- A skeleton holds exactly the bound exports and the imports they need (FR-008). Internal helpers, extra exports and module structure stay the implementer's choice (FR-022).
- Signatures come only from the frozen, compiler-checked types file (FR-004). The plan's `**Interface:**` blocks are never read for this purpose.
- ADTs are enforced only by the shadowing and re-listing checks. They are never skeleton targets (OOS-004).

**Why:** ADR-0020 rejected "a full skeleton of every internal helper frozen up front" because it froze guesses. G2 freezes only what the contract Wave already froze and compiled, so no guess is frozen. Refinement, not supersession.

**Rejected:**
- Signatures from `**Interface:**` prose (approach B of brainstorm, OOS-002) — unchecked pseudo-signatures.
- Skeletonizing helpers — the exact failure ADR-0020 names.

### AD-3: Binding grammar — a contract-qualified `**Export bindings:**` list in File Structure (interview Q5a)

**Choice:** In `## File Structure`, outside any fence and directly under a group's fenced block, a column-0 label is followed by `- ` items:

```
**Export bindings:**
- `src/order/pricing.ts` — CT-1: priceOrder: PriceOrderFn, parseOrder: ParseOrderFn
- `src/main/java/com/acme/order/Pricing.java` — CT-2: priceOrder: PriceOrderFn
```

The grammar has these rules:
- **One contract per line.** A path on two lines is the multi-contract refusal (AS-004) when the CT ids differ, and a duplicate otherwise.
- **Identifiers.** Names and aliases match `^[A-Za-z_][A-Za-z0-9_]*$` and are not reserved words of TypeScript or Java (one fixed list). Generated bytes therefore can never inject code (Q11a).

**Parsing.** `engine/src/core/skeleton/bindings.ts` parses the label with the pure `parseExportBindings`. `parsePlanModels` calls it, and it reuses the `labelledList` grammar. A label outside `## File Structure` is a `misplaced-label` stray, never an opt-out.

**Plan validation.** `validateExportBindings` runs inside `validateModelBindings`. It refuses each of these, naming the file and the reason (FR-002, AS-002..AS-005):
- an unsafe path (`isRepoRelativePlanPath`);
- a frozen path;
- a malformed entry, or a duplicate name in one file;
- a file referencing two contracts;
- an unknown CT id, or a CT declaring `**Types file:** none` (nothing to bind to);
- a bound path listed in the contract Task's own `file_list` (the engine writes it, AD-9);
- a bound path in no non-contract Task's `file_list`;
- a holder Task that does not depend, directly or transitively, on the contract Task;
- a bound path on a Task whose regression waiver is `documentation-only` or `generated-artifact` (Q15a — the combination contradicts itself).

A bound path in a language other than TypeScript or Java is accepted. It reports "unsupported language, no skeleton" at its spawn (AS-040).

**Why:** AS-004 must be decided before any types file exists, so the contract has to be in the text. A labelled list reuses the proven regex grammar and stray detection, and decompose copies it verbatim.

**Rejected:**
- A fenced trailer — the engine would have to start parsing fenced File Structure lines.
- A list inside each `### CT-N` — contradicts "bound via File Structure", which was decided at specify.

### AD-4: Persistence — bindings stamped at population, skeleton records with engine digests, content-addressed recognition (interview Q10a)

**Choice:** Additive optional TaskGraph fields, parsed by `state-file-wire.ts`. Graphs from before G2 load unchanged (Q13a).

- **`export_bindings`.** Type `readonly ExportBinding[]`, where `ExportBinding = { path, contract, exports: NonEmpty<{ name, alias }> }`, in plan order. Population stamps it from the validated plan. The brief shell, which already re-reads the recorded plan before every spawn, refuses a brief when `bindingStampAgreement(plan, stamp)` reports drift. The spawn is then blocked until re-population.
- **`skeletons`.** Type `readonly SkeletonRecord[]`, sorted by path. A `SkeletonRecord` holds:
  - `path`, `contract`, `language` (`typescript` | `java`);
  - `origin` (`spawn` | `contract-stub` | `revision`);
  - `engineSha256` — the raw-bytes digest of the bytes the engine wrote (FR-031);
  - `typesSha256` — the types-file digest it was generated from;
  - `stale` — `null`, or `{ revision }` (FR-033).
- **`task.skeleton_outcomes`.** Type `readonly { path, outcome: SkeletonOutcome }[]`, recorded at each registration (FR-030).

**Content-addressed recognition.** A file is an untouched engine skeleton exactly when its current bytes equal the record's `engineSha256`, or the canonical bytes the generator produces for the current surface (`isUntouchedSkeleton`, owned by `outcomes.ts`). So a write whose later locked record failed, such as a registration refused after the write, is adopted by the next materialization rather than misreported as "exists, not skeletonized".

**Why:** Stamping follows ADR-0032: the run never depends on a plan that can still change. Content addressing makes NFR-021 crash safety and idempotency (FR-010) one rule instead of a journal.

**Rejected:**
- Re-deriving bindings from the plan at each use — mutable authority.
- A write-ahead journal of skeleton writes — more state for what a digest already proves.

### AD-5: Completion refusals ride the existing `declared-artifact-changed` obligation (interview Q10a, FR-013..FR-021)

**Choice:**
- **New failure variant.** `ProofFailure` gains `declared-artifact-contract-violated { artifact, violations: NonEmpty<ConformanceViolation> }`. `ConformanceViolation = { subject, reason }`, where `reason` is one of `deleted`, `renamed`, `retyped`, `still unimplemented`, `shadows frozen ADT`, `re-lists frozen variants` (FR-021).
- **Required conformance field.** `ObservedProofEvidence` gains `contractConformance`, which is required: `{ kind: "not-owed" } | { kind: "judged"; violations: ReadonlyMap<artifact, NonEmpty<ConformanceViolation>> }`. Every caller must decide it, so no settlement path can omit it silently. The callers are `implementation-completion.ts` through `exact-implementation-settlement.ts`, the Pi stop resolution in `implementation-application.ts`, and `reconcile-implementation-proof.ts`.
- **Evaluation.** In `evaluateOne`, the `declared-artifact-changed` arm reports violations ahead of the changed test, so an untouched skeleton is refused as `still unimplemented` (AS-024) rather than as `not-changed`.
- **Failure handling.** One shell, `observeContractConformance` (`engine/src/orchestration/contract-conformance-observation.ts`), reads texts and calls the pure judge. A read failure is an `implementation-observation-unavailable` infrastructure failure: it never consumes a semantic attempt and never passes. The new kind joins the semantic retry appendix, which lists every violation (FR-028).
- **Engine bytes subtracted (FR-012).**
  - `buildTaskLocalByteObservation` takes the recorded `engineSha256` per path. It drops a proof-scope change whose current digest equals it, so engine bytes never satisfy "changed".
  - It also drops a repository-changed path whose current digest equals a recorded engine digest. That keeps contract stubs out of the contract Task's out-of-scope set.

**Why:** "Reported through the existing declared-artifact channel" (FR-021). A new failure variant on the existing obligation widens one union, not the obligation set, its parsers and its drift matchers.

**Rejected:**
- A new obligation kind `declared-artifact-conforms` — wider wire and retry surface for the same information.
- An optional observation field — "absent means not owed" would let a forgotten caller pass silently.

### AD-6: TypeScript enters through a third parse-only compiler seam, `core/skeleton/ts-surface.ts` (interview Q1a; amends ADR-0042)

**Choice:**
- **The seam.** `engine/src/core/skeleton/ts-surface.ts` is added to `TYPESCRIPT_COMPILER_API_SEAMS`. It is granted `typescript` per file, exact specifier. It parses through `import-graph.ts`'s `parseModule`, so the path-to-script-kind rule keeps one home. It calls only `ts.createSourceFile` and node visitors.
- **What it exports:**
  - `readTsTypesSurface(path, text)` — function-type aliases, plus whether each is generic; discriminated unions (discriminant key, variant tags, named variants); branded types.
  - `readTsImplementationSurface(path, text)` — exported bindings with annotation identifier, import source and initializer marker literals; local type, interface, class and enum names; local object-member unions with their discriminant literals.
  - `typesImportSpecifier(acceptancePath, acceptanceText, typesPath)` — AD-8.
- **Lockstep updates.** Both INV-1 rule copies (`.claude/` and `.pi/`) gain the third exclusion in lockstep with the constant, pinned by `project-lint-rules.test.ts`. The machine-purity audit grants it too. The ADR task amends ADR-0042.

**Why:** Declaration extraction is a third concern, separate from mutation sites and module edges. A hand tokenizer would be the second copy of TypeScript lexing that ADR-0042 forbids.

**Rejected:**
- Widening `import-graph.ts` — mixes concerns, as ADR-0042 option 2 noted.
- A Program or type checker — disk I/O, rejected by ADR-0042.

### AD-7: Java — a restricted pure lexer, a frozen holder shape, and a typed static final constant per binding (interview Q6a, Q18a; resolves AS-016)

**Choice:**

**The reader.** `engine/src/core/skeleton/java-surface.ts` is a hand-written, pure lexer and declaration reader. It blanks comments, string and char literals and text blocks, keeping the literal values for marker detection. It then reads:
- `package` and `import` lines;
- type declarations: `class`, `interface`, `record`, `enum`, with modifiers, `sealed`/`non-sealed` and `permits` (or implicit nested permitted subtypes);
- `@FunctionalInterface`, and the single abstract method's parameter count and generic-ness;
- field declarations, with their type token and initializer span.

**The frozen holder.** A frozen Java types file must have exactly one top-level `public` interface or `final class` (the holder) declaring every functional interface, sealed interface and record nested inside it. Any other shape is refused at stage two with a named diagnostic, never guessed.

**Bindable aliases.** A bindable Java alias is a nested non-generic interface with exactly one abstract, non-generic method. A non-function or generic alias is the AS-009 refusal.

**The bound member (AS-016).** One `public final class <FileBasename>` with a private constructor and, per binding:

```
public static final PriceOrderFn priceOrder = (p0, p1) -> {
    throw new UnsupportedOperationException("unimplemented: priceOrder");
};
```

The lambda arity is the single abstract method's parameter count. javac enforces the signature.

**Supported roots.** Only paths under a `src/main/java/` root are supported, and the package comes from the path after it. Other Java roots, Kotlin and Scala report "unsupported language, no skeleton" (Q16b). That decision is AD-15's `skeletonLanguageOf`, not this reader's: `java-surface.ts` reads text and never classifies paths.

**Why:** It mirrors the TypeScript `export const name: Alias` shape exactly, so both languages share one check: name, declared type token, marker in the initializer. That meets SC-006's shared reasons and the Java/TypeScript parity risk. There is no new dependency (Q14a).

**Rejected:**
- A static method mirroring the single abstract method plus an anchor constant — two places that drift, and a text-compared signature.
- A class implementing the interface — one binding per file, and names don't map.
- A Java parser package or `javac` — a new dependency or toolchain I/O.

### AD-8: Canonical skeleton bytes — deterministic, unformatted, specifier copied from the frozen acceptance tests (interview Q8a, Q16c)

**Choice:** `engine/src/core/skeleton/generate.ts` produces the bytes.

**Common to both languages:**
- LF line endings, a trailing newline, no timestamps.
- One header comment naming the types file and the contract.
- Bindings in plan order; imports sorted and unique.

**TypeScript:**

```
// Skeleton written by Loom from src/order/order-contract.ts (CT-1). Make these signatures work; keep each name and its type.
import type { ParseOrderFn, PriceOrderFn } from "./order-contract";

export const parseOrder: ParseOrderFn = () => {
  throw new Error("unimplemented: parseOrder");
};
```

- A zero-parameter throwing arrow is assignable to any non-generic function type. No parameter list has to be derived, and `noUnusedParameters` stays clean. Generic aliases are refused at stage two (AS-009).
- The import specifier copies the style (extensionless, `.js` or `.ts`) of the first frozen acceptance file, in declaration order, that imports the types file. With none, it is an extensionless relative path.

**Java:** AD-7. `import <package>.<Holder>.<Alias>;` for each alias.

The generator takes a `SkeletonTarget` (AD-15), which carries the language and, for Java, the package and class name. An unsupported path cannot be passed to it at all, so it has no language refusal of its own that could drift from the AS-040 outcome.

No project formatter ever runs (Q16c).

**Why:** FR-009 and FR-010 need bytes that are a pure function of the surface and the bindings. The frozen acceptance tests are compiler-checked proof of a specifier style that resolves.

**Rejected:**
- Reading `tsconfig` `moduleResolution` — shell I/O for a fact the frozen files already prove.
- Running prettier or google-java-format — the bytes would depend on the environment.

### AD-9: Contract stubs at the contract Task's SubagentStop (interview Q7a; resolves AS-043)

**Choice:** `materializeContractStubs` (`engine/src/orchestration/contract-stub-materialization.ts`) runs for a Task whose `contractRole` is `contract-task`. It runs in both stop shells (`engine/src/handlers/subagent-stop/dispatch.ts` and `pi/subagent-stop.ts`), before `runStopChecks` and before settlement.

1. It reads the contract Task's current, not-yet-frozen types file and resolves that contract's bindings.
2. For every bound file of the contract, it writes a missing stub, or refreshes an untouched stub whose canonical bytes changed after a stop-check block and further edits. Both go through the writer.
3. It records `origin: "contract-stub"` records under the lock.

Unresolvable bindings write no stub. Their problems go into the stop output and status. The contract gate then sees an uncollected acceptance file, which G1 already refuses as a non-behavioral RED.

Further consequences:
- Bound paths leave the contract Task's `file_list` (AD-3 refuses them there).
- The contract brief and decompose rule 12 say the engine writes the stubs (FR-023, FR-041, AS-045).
- An engine stub is a skeleton record, so it reports "skeleton written (contract stub)" at its owning Wave, and US5/US6 apply (AS-044).
- Stubs are written for every bound file of the contract, a superset of what the acceptance tests import. This is deterministic and needs no import-graph walk.

**Why:** It is the one point where the types file exists and RED has not yet been observed, and it is shared by both harnesses. Freeze semantics are unchanged (OOS-008).

**Rejected:**
- PostToolUse on every types-file write — more entry points, and work on every edit.
- Wave Gate start — neither the agent nor the I7 stop check would ever see the stubs.

### AD-10: Contract Revision refreshes only untouched skeletons (FR-033, interview Q16d)

**Choice:** After `revise-contract` observes the revised frozen bytes, the handler does the following:
- It re-resolves the contract's bindings against the revised surface.
- Each record that is untouched (`isUntouchedSkeleton`) is refreshed through the writer's guarded replace. Its record gets the new `engineSha256` and `typesSha256` and `origin: "revision"`.
- Each modified record is left on disk and flagged `stale: { revision }`.
- Resolution problems are named in the revision outcome message, and the next spawn's stage two blocks on them (AS-051).

Writes precede the locked update. A refused update leaves refreshed bytes that content-addressed recognition adopts (AD-4). Revision semantics are otherwise unchanged (OOS-008).

**Why:** A revision is the one sanctioned way frozen types change, and it must never destroy implementer work.

**Rejected:**
- Regenerating modified skeletons — destroys work (Q16d).
- Leaving untouched skeletons on the old signatures — implementers would start against signatures that no longer exist.

### AD-11: Conformance rules — syntactic, all violations listed, scope by production file and contract (interview Q15a, Q16a)

**Choice:** `engine/src/core/skeleton/conformance.ts` exports the pure `judgeConformance({ surfaces, bindings, files })`. `files` is a list of path plus text-or-missing. Per bound export:
- **`deleted`** — the name is not exported, or the file is missing (FR-014, AS-027).
- **`renamed`** — the name is missing and another export carries the same alias annotation.
- **`retyped`** — the name is exported but not as `export const name: Alias` (TypeScript), or `static final Alias name` (Java), where `Alias` is imported from the frozen types file or holder.
- **`still unimplemented`** — the initializer still contains a string literal exactly `unimplemented: <name>`. Any other throw is fine (AS-025).

Per frozen ADT, where a frozen ADT is a TypeScript discriminated union or branded type, or a Java sealed interface, record or permitted variant (FR-017):
- **`shadows frozen ADT`** — any local declaration named as an ADT or one of its named variants.
- **`re-lists frozen variants`** — a local union whose object-shaped members carry the frozen discriminant key with two or more frozen tags, or a local sealed hierarchy whose permitted simple names include two or more frozen variants (FR-016, AS-036). The diagnostic names the remedy: `Extract<FrozenUnion, …>`, or the frozen types directly.

A union of imported frozen variant types is "using the frozen types directly" and passes. Every violation is listed (FR-028). The checks stay syntactic, with no assignability or structural typing (Q16a).

**Scope** (`engine/src/core/skeleton/scope.ts`, INV-5):
- **Which files.** A Task's production files, classified by the existing `classifyTaskFiles` (INV-2 of G5b/I6), that `skeletonLanguageOf` (AD-15) parses to a supported target. The judge receives each file with its target and never classifies paths itself.
- **Which contracts.** Those the Task binds or claims, with a types file and freeze state `frozen` or `revised`.
- **Applied when.** The signature check applies to the Task's bound files. The ADT check applies to the files of the types file's language.
- **Exempt.** A Task that is attested, or that waives regression as `documentation-only` or `generated-artifact`, owes nothing (FR-019, AS-037). There are no new waivers (FR-020).
- **Files existing at Wave start.** They are checked whenever they are in scope (FR-018).

**Why:** One closed reason set across both languages, and false positives limited to deliberate shapes. Legitimate view-models are covered by the "two or more object-shaped members" threshold, and string-literal unions are out of scope (a stated limit).

**Rejected:**
- Type-aware assignability — needs a Program (ADR-0042).
- Checking test files — tests may define fixtures (OOS-005).

### AD-12: One no-clobber writer behind fixed write rules (interview Q9a, Q11a; INV-3)

**Choice:** `engine/src/orchestration/skeleton-writer.ts` exports `createSkeleton(root, path, bytes, frozen)` and `refreshSkeleton(root, path, expectedSha256, bytes, frozen)`.

Both refuse, as values:
- a non-repo-relative path, or a frozen path (NFR-010, NFR-011);
- any symlinked ancestor (no-follow `lstat` walk, reusing `no-follow-fs.ts`).

Create writes a temp file in the target directory, then publishes it with `link(temp, target)`. `EEXIST` comes back as `exists`, never an overwrite (FR-011). Refresh re-reads the current bytes, requires `expectedSha256`, then renames the temp file over the target.

Each file is either complete or absent (NFR-021). Results are `written | exists | refused{reason} | io-failed{message}`, and there is no retry (Q4a). Every engine byte that reaches a repository source file goes through these two functions.

**Why:** Three entry points write source files (spawn, contract stop, revision). One owner of the safety rule makes "never clobber, never frozen, never outside the repository" mutation-verified once.

**Rejected:**
- Writing through `writeFileSync` at each site — three copies of a safety rule.

### AD-13: One skeleton-outcome derivation; outcomes are recorded state, shown in brief and status (interview Q12a; INV-4)

**Choice:** `engine/src/core/skeleton/outcomes.ts` exports `skeletonOutcomes(graph, task, observations)`. `observations` is per path: exists, and current digest. It returns exactly one `SkeletonOutcome` per non-test file_list path, in this precedence:

1. An untouched engine skeleton → `skeleton-written { origin }`.
2. The path exists → `exists-not-skeletonized`.
3. No binding:
   - the Task claims a `Types file: none` contract → `contract-has-no-types-file`;
   - otherwise → `no-bound-exports`.
4. Bound, but `skeletonLanguageOf` (AD-15) returns `unsupported` → `unsupported-language`.
5. Bound and supported → `skeleton-written { origin: "spawn" }` (to write).

Exact render strings: "skeleton written", "no bound exports, no skeleton", "contract has no types file, no skeletons", "unsupported language, no skeleton", "exists, not skeletonized". It also owns `isUntouchedSkeleton`.

Consumers:
- materialization, the stub step and the revision refresh;
- `core/skeleton/status.ts`, which builds the `skeletons` report of `LoomStatusDocument`: per current-Wave Task and path, the outcome marked recorded or projected, every stale flag, and every stage-two problem;
- the brief.

When stage-two problems exist, `core/implementation-window.ts` replaces `spawn-wave-implementation` with a blocked reason, `skeleton-bindings-unresolved`, that names them.

No logs and no metrics. Expected failures are never crashes (FR-045).

**Why:** FR-030 and FR-040 need exactly one outcome per path, identical wherever it is read. Five readers deriving their own would drift.

**Rejected:**
- Persisting projected outcomes before the spawn — state written by a read path.

### AD-15: One supported-language predicate, parsed once into a `SkeletonTarget` (plan-alignment OWN-1; INV-6)

**Choice:** `engine/src/core/skeleton/language.ts` exports `skeletonLanguageOf(path): SkeletonTarget | Unsupported`.
- `SkeletonTarget` is either `{ language: "typescript" }` (`.ts`, `.tsx`, `.mts`, `.cts`) or `{ language: "java"; package; className }` (a `.java` path under a `src/main/java/` root, package from the path after it, class from the basename).
- `Unsupported` carries a reason: other extension, Java outside a `src/main/java/` root, or a Kotlin or Scala file.
- `SkeletonTarget` is branded, and `language.ts` is its only constructor.

Applying sites:
- materialization, the contract stub step and the revision refresh, which parse each bound path before generating;
- `frozen-surface-observation.ts`, which picks the TypeScript or Java reader for a types file;
- `outcomes.ts` (AD-13 step 4);
- `scope.ts` (AD-11).

Consumers of the parsed value: `generateSkeleton` takes a `SkeletonTarget`; `judgeConformance` receives each file with its target; `resolveBindings` receives a surface already tagged with its language. None of them classifies a path.

**Why:** The AS-040 outcome, the generator's input, the conformance scope and the choice of types-file reader must agree on what is supported. Parse don't validate: one predicate, one branded result, so the downstream modules cannot disagree with it, because they never re-decide it.

**Rejected:**
- A per-module extension check, including the old `javaPackageOf` in `java-surface.ts` — four copies of one rule (the OWN-1 gap).
- Folding the predicate into `outcomes.ts` — it is a different rule from outcome precedence. One invariant per rule.

### AD-14: Pure core, DomainResult end to end, simplicity axis (interview Q2a, Q3a, Q4a, Q13a, Q14a)

**Choice:**
- Everything under `engine/src/core/skeleton/` is pure, strings in and data out, and is listed in `DEFAULT_PURE_MODULES` (INV-2).
- Expected failures are `DomainResult` values: a refused binding, a missing or non-function alias, an unparseable file, a violation, an unsupported language.
- Shells convert I/O into values. There is no retry or backoff.
- Additive, no feature flag. Pre-G2 graphs run unchanged, and their frozen ADTs are not checked retroactively.
- Both harnesses go through the shared spawn and settlement paths. No new runtime dependency.

**Why:** ADR-0042 and ADR-0043 already bind the core. Simplicity is the user's primary axis.

**Rejected:**
- Pragmatic mocks at the boundaries.
- Retroactive ADT checks on running graphs (Q13b).

---

## File Structure

### Contract CT-1 (T1, Wave 1)

```
engine/src/core/skeleton/types.ts                              — NEW, declarations only: ExportBinding, ExportBindingsDeclaration, BindingProblem, TsTypesSurface, TsImplementationSurface, JavaTypesSurface, JavaImplementationSurface, FrozenSurface, SurfaceProblem, ResolvedBinding, ResolutionProblem, SkeletonLanguage, SkeletonTarget, UnsupportedTarget, SkeletonOrigin, SkeletonOutcome, SkeletonRecord, GeneratedSkeleton, ConformanceViolation, ViolationReason, ContractConformance, plus the function-type aliases ParseExportBindingsFn, ValidateExportBindingsFn, ReadTsTypesSurfaceFn, ReadTsImplementationSurfaceFn, TypesImportSpecifierFn, ReadJavaTypesSurfaceFn, ReadJavaImplementationSurfaceFn, ResolveBindingsFn, GenerateSkeletonFn, JudgeConformanceFn, SkeletonOutcomesFn, SkeletonLanguageOfFn
engine/src/core/skeleton/bindings.ts                           — NEW compiling stub (throws "not implemented"); T4 implements
engine/src/core/skeleton/ts-surface.ts                         — NEW compiling stub, no typescript import; T5 implements
engine/src/core/skeleton/java-surface.ts                       — NEW compiling stub; T6 implements
engine/src/core/skeleton/generate.ts                           — NEW compiling stub; T7 implements
engine/src/core/skeleton/resolve.ts                            — NEW compiling stub; T7 implements
engine/src/core/skeleton/language.ts                           — NEW compiling stub; T9 implements
engine/tests/acceptance/skeleton-generation.acceptance.test.ts — NEW (supported domain: TS/Java supported, Rust/Kotlin/odd roots unsupported, frozen-holder shapes, determinism and idempotency laws)
```

### Contract CT-2 (T2, Wave 2)

```
engine/src/core/skeleton/conformance.ts                         — NEW compiling stub; T8 implements
engine/tests/acceptance/skeleton-conformance.acceptance.test.ts — NEW seeded-violation matrix, both languages (SC-006)
engine/tests/fixtures/skeleton-sources.ts                       — NEW string fixtures: TS and Java frozen types, conforming and violating implementation texts, near-miss view-models
```

### Contract CT-3 (T3, Wave 2)

```
engine/tests/acceptance/skeleton-spawn.acceptance.test.ts       — NEW drives registerTaskExecutionBatch over a temp repo
engine/tests/acceptance/skeleton-completion.acceptance.test.ts  — NEW drives settleExactImplementation
engine/tests/acceptance/contract-stubs.acceptance.test.ts       — NEW drives the contract Task's stop path
engine/tests/acceptance/skeleton-revision.acceptance.test.ts    — NEW drives the revise-contract handler
engine/tests/acceptance/skeleton-status-brief.acceptance.test.ts — NEW drives helper orchestration status --json and brief rendering
engine/tests/fixtures/skeleton-repo.ts                          — NEW temp git repo builder: TS and Java contracts, frozen stamps, a raw-JSON State File with export_bindings, bound and unbound Tasks
```

### Plan grammar and binding validation (T4, Wave 2)

```
engine/src/core/skeleton/bindings.ts                    — parseExportBindings, validateExportBindings, bindingStampAgreement, renderBindingProblem
engine/src/core/parse-plan-models.ts                    — File Structure section, call parseExportBindings, misplaced-label stray for **Export bindings:**
engine/src/types.ts                                     — PlanModels.exportBindings, Stray home "File Structure"
engine/src/handlers/helpers/validate-model-bindings.ts  — run validateExportBindings over the decomposed Tasks
engine/tests/core/skeleton-bindings.test.ts             — NEW unit + property (parse ∘ render round-trip)
engine/tests/core/parse-plan-models.test.ts             — strays and the new field
```

### TypeScript surface seam (T5, Wave 2)

```
engine/src/core/skeleton/ts-surface.ts                         — the third parse-only seam (AD-6)
engine/src/linter/programmatic/no-cross-boundary-imports.ts    — TYPESCRIPT_COMPILER_API_SEAMS += ts-surface.ts
engine/src/linter/programmatic/no-io-in-pure-modules.ts        — DEFAULT_PURE_MODULES += engine/src/core/skeleton/
.claude/linter/rules/inv-1-typescript-compiler-api-seam.json   — third exclusion and description, in lockstep with the constant
.pi/linter/rules/inv-1-typescript-compiler-api-seam.json       — byte-identical mirror
engine/tests/linter/project-lint-rules.test.ts                 — mirror pin covers the third seam
engine/tests/linter/programmatic/machine-purity.test.ts        — grant the seam, refuse others
engine/tests/core/skeleton-ts-surface.test.ts                  — NEW unit over strings
```

### Java reader (T6, Wave 2)

```
engine/src/core/skeleton/java-surface.ts       — lexer + declaration reader, frozen-holder shape check (AD-7)
engine/tests/core/skeleton-java-surface.test.ts — NEW unit + property (comment/string blanking never changes declaration reads)
```

### Outcomes and conformance scope (T9, Wave 2)

```
engine/src/core/skeleton/language.ts            — skeletonLanguageOf, the branded SkeletonTarget (INV-6 owner, AD-15)
engine/src/core/skeleton/outcomes.ts            — NEW skeletonOutcomes, isUntouchedSkeleton, renderSkeletonOutcome (INV-4 owner; INV-6 sibling)
engine/src/core/skeleton/scope.ts               — NEW conformanceScope(graph, task) (INV-5 owner)
engine/tests/core/skeleton-outcomes.matrix.test.ts — NEW INV-4 matrix
engine/tests/core/skeleton-scope.matrix.test.ts    — NEW INV-5 matrix
engine/tests/core/skeleton-language.matrix.test.ts — NEW INV-6 matrix: owner, outcomes and scope rows
engine/tests/core/skeleton-language.test.ts        — NEW unit + property (every path gets exactly one target or unsupported; the package always matches the path)
engine/tests/core/skeleton-outcomes.test.ts        — NEW unit + property (exactly one outcome per non-test path)
```

### Generator and stage-two resolution (T7, Wave 3)

```
engine/src/core/skeleton/generate.ts           — TS and Java canonical bytes (AD-8)
engine/src/core/skeleton/resolve.ts            — resolveBindings(surface, bindings): ResolvedBinding[] | NonEmpty<ResolutionProblem>
engine/tests/core/skeleton-generate.test.ts     — NEW unit + property (100-run byte identity, idempotency, generated TS parses via ts-surface, generated Java reads via java-surface)
engine/tests/core/skeleton-resolve.test.ts      — NEW unit
```

### Conformance judge (T8, Wave 3)

```
engine/src/core/skeleton/conformance.ts          — judgeConformance, renderConformanceViolations (AD-11)
engine/tests/core/skeleton-conformance.test.ts    — NEW unit + property (extra exports and helpers never add a violation)
```

### Persistence and population (T10, Wave 3)

```
engine/src/types.ts                                — TaskGraph.export_bindings, TaskGraph.skeletons, Task.skeleton_outcomes
engine/src/state-file-wire.ts                      — parse and validate the three fields (sorted, unique paths, sha256 shape, outcome ADT)
engine/src/core/task-graph-population.ts           — stamp export_bindings from the validated plan
engine/src/handlers/helpers/populate-task-graph.ts — pass parsed bindings to population
engine/tests/state-file-wire-skeletons.test.ts     — NEW wire round-trip, pre-G2 graph loads unchanged
engine/tests/core/task-graph-population.test.ts    — stamping
```

### Writer and spawn materialization (T11, Wave 4)

```
engine/src/orchestration/skeleton-writer.ts            — NEW createSkeleton, refreshSkeleton (INV-3 owner)
engine/src/orchestration/frozen-surface-observation.ts — NEW read a types file no-follow, verify against the freeze stamp (or read current bytes for the stub step), parse its surface
engine/src/orchestration/skeleton-materialization.ts   — NEW materializeTaskSkeletons (AD-1)
engine/src/handlers/task-execution.ts                  — call materialization before baseline capture; block on stage-two problems
engine/src/core/validate-task-execution.ts             — authority batch carries skeleton records and outcomes into the locked update
engine/tests/orchestration/skeleton-writer.matrix.test.ts — NEW INV-3 matrix
engine/tests/core/skeleton-language.matrix.test.ts     — add the materialization and frozen-surface-observation rows
engine/tests/core/skeleton-outcomes.matrix.test.ts     — add the materialization row
engine/tests/orchestration/skeleton-writer.test.ts     — NEW unit over a temp dir (EEXIST, symlinked parent, frozen path, temp cleanup)
engine/tests/handlers/task-execution-skeletons.test.ts — NEW handler tests (both harness callers, refused registration then adoption)
```

### Proof channel (T12, Wave 5)

```
engine/src/core/proof-obligations.ts                     — failure variant, required contractConformance, evaluation order, failure parser
engine/src/core/implementation-completion.ts             — proof failure kind mapping for the new variant
engine/src/core/implementation-retry.ts                  — retry appendix lists violations
engine/src/core/implementation-application.ts            — engine-digest subtraction in buildTaskLocalByteObservation; conformance into evaluateTaskProof
engine/src/orchestration/contract-conformance-observation.ts — NEW observeContractConformance (INV-5 sibling)
engine/src/handlers/helpers/exact-implementation-settlement.ts — supply the observation; read failure → infrastructure-blocked
engine/src/handlers/helpers/task-local-completion.ts     — pass recorded engine digests and current digests
engine/src/handlers/helpers/reconcile-implementation-proof.ts — supply the observation
engine/tests/core/skeleton-scope.matrix.test.ts          — add the observation row
engine/tests/core/proof-obligations.test.ts              — variant ordering, parser round-trip
engine/tests/core/implementation-application.test.ts     — subtraction cases
```

### Contract stubs and revision refresh (T13, Wave 5)

```
engine/src/orchestration/contract-stub-materialization.ts — NEW materializeContractStubs (AD-9)
engine/src/handlers/subagent-stop/dispatch.ts             — call it for the contract Task before runStopChecks
pi/subagent-stop.ts                                        — the same, before report-only stop checks and settlement
engine/src/handlers/helpers/revise-contract.ts            — refresh untouched, flag stale, report resolution problems
engine/src/core/contract-revision.ts                      — revision outcome carries binding problems and stale paths
engine/tests/orchestration/skeleton-writer.matrix.test.ts — add stub and revision rows
engine/tests/core/skeleton-outcomes.matrix.test.ts        — add stub and revision rows
engine/tests/core/skeleton-language.matrix.test.ts        — add stub and revision rows
engine/tests/handlers/contract-stubs.test.ts              — NEW both stop shells
engine/tests/handlers/revise-contract-skeletons.test.ts   — NEW
```

### Status, brief and the stage-two blocker (T14, Wave 6)

```
engine/src/core/skeleton/status.ts                    — NEW skeletonStatusReport, renderSkeletonStatus (INV-4 sibling)
engine/src/core/loom-status.ts                        — LoomStatusDocument.skeletons, human and --json rendering
engine/src/core/implementation-window.ts              — skeleton-bindings-unresolved blocked reason
engine/src/types.ts                                   — LoomStatusDocument.skeletons, StatusReason kind
engine/src/handlers/helpers/orchestration.ts          — status shell observes paths and frozen surfaces
engine/src/core/implementation-brief.ts               — Frozen signatures section, frozen ADT list (INV-4/INV-5 sibling), contract-task block says the engine writes stubs
engine/src/orchestration/implementation-brief.ts      — observation for the brief, bindingStampAgreement drift refusal
commands/templates/impl-agent-context.md              — the section placeholder
engine/tests/core/skeleton-outcomes.matrix.test.ts    — add status and brief rows
engine/tests/core/skeleton-scope.matrix.test.ts       — add the brief row
engine/tests/core/implementation-brief.test.ts        — section and contract block
engine/tests/core/loom-status.test.ts                 — report and blocker
```

### Docs (T15, Wave 6)

```
CONTEXT.md                                   — Skeleton, Export Binding, Frozen ADT (FR-044)
docs/operations.md                           — skeletons at spawn, stubs at stop, revision refresh, status section
commands/loom.md                             — execute loop: skeleton outcomes, skeleton-bindings-unresolved
commands/templates/phase-decompose.md        — rule 12: the engine writes stubs; bound paths stay off the contract Task; copy **Export bindings:** verbatim
commands/templates/phase-architecture.md     — teach the binding grammar, one contract per file, the frozen-ADT rule (FR-042)
references/plan-template.md                  — **Export bindings:** under File Structure
references/executable-models.md              — Contracts: bindings, Java holder shape, frozen ADTs
engine/tests/runbook-contract.test.ts        — prose pins for the new rule-12 and template text
```

---

## Component Design

### Skeleton types (CT-1 surface)

**Responsibility:** The frozen declarations every G2 module and acceptance test imports.
**Files:** `engine/src/core/skeleton/types.ts`
**Interface:**

```
type ExportBinding = Readonly<{ path: string; contract: string; exports: NonEmpty<Readonly<{ name: string; alias: string }>> }>
type BindingProblem = unsafe-path | frozen-path | malformed-entry{line} | duplicate-name{path,name} | multi-contract{path,contracts}
  | unknown-contract{path,contract} | contract-without-types{path,contract} | bound-on-contract-task{path,contract}
  | unheld-path{path} | holder-not-after-contract{path,task,contractTask} | bound-on-waived-task{path,task,reason}
type SkeletonLanguage = "typescript" | "java"
type SkeletonTarget = Brand<Readonly<{ language: "typescript" } | { language: "java"; package: string; className: string }>, "SkeletonTarget">
type UnsupportedTarget = Readonly<{ kind: "unsupported"; reason: "other-extension" | "java-outside-main-root" | "jvm-non-java" }>
type SkeletonLanguageOfFn = (path: string) => SkeletonTarget | UnsupportedTarget
type ResolutionProblem = missing-alias{alias,path,typesFile} | not-a-function{alias,path,typesFile} | generic-alias{...}
  | unsupported-holder-shape{typesFile,detail} | types-unparseable{typesFile,detail} | types-drifted{typesFile}
type SkeletonOrigin = "spawn" | "contract-stub" | "revision"
type SkeletonOutcome = skeleton-written{origin} | no-bound-exports | contract-has-no-types-file | unsupported-language | exists-not-skeletonized
type SkeletonRecord = Readonly<{ path; contract; language; origin; engineSha256; typesSha256; stale: null | { revision: number } }>
type ViolationReason = "deleted" | "renamed" | "retyped" | "still unimplemented" | "shadows frozen ADT" | "re-lists frozen variants"
type ConformanceViolation = Readonly<{ subject: string; reason: ViolationReason; remedy: string | null }>
type ContractConformance = Readonly<{ kind: "not-owed" }> | Readonly<{ kind: "judged"; violations: ReadonlyMap<string, NonEmpty<ConformanceViolation>> }>
type ParseExportBindingsFn = (fileStructureSection: string) => ExportBindingsDeclaration
type ValidateExportBindingsFn = (bindings, contracts: readonly PlanContract[], tasks) => readonly BindingProblem[]
type ResolveBindingsFn = (surface: FrozenSurface, bindings: readonly ExportBinding[]) => DomainResult<readonly ResolvedBinding[], NonEmpty<ResolutionProblem>>
type GenerateSkeletonFn = (input: { path; target: SkeletonTarget; contract; typesPath; surface; resolved; specifierStyle }) => DomainResult<GeneratedSkeleton, SurfaceProblem>
type JudgeConformanceFn = (input: { surfaces; bindings; files: readonly { path; text: string | null }[] }) => ContractConformance
type SkeletonOutcomesFn = (graph, taskId, observations: ReadonlyMap<string, { exists: boolean; sha256: string | null }>) => readonly { path; outcome }[]
```

**Depends on:** `core/orchestration-contract` (NonEmpty, DomainResult), `core/acceptance-contract` (PlanContract)

### Plan grammar and binding validation

**Responsibility:** Turn `**Export bindings:**` text into bindings, and refuse every FR-002 case before population.
**Files:** `engine/src/core/skeleton/bindings.ts`, `engine/src/core/parse-plan-models.ts`, `engine/src/handlers/helpers/validate-model-bindings.ts`
**Interface:**

```
parseExportBindings: ParseExportBindingsFn          // total; problems collected, never thrown
validateExportBindings: ValidateExportBindingsFn    // graph-shape rules of AD-3
bindingStampAgreement(plan: readonly ExportBinding[], stamp: readonly ExportBinding[]): DomainResult<null, string>
```

**Depends on:** Skeleton types, `plan-path-match`, `task-dependencies`, `verification-policy`

### TypeScript surface seam

**Responsibility:** Read TypeScript declaration surfaces from given text through the compiler parser only.
**Files:** `engine/src/core/skeleton/ts-surface.ts`
**Interface:**

```
readTsTypesSurface(path, text): DomainResult<TsTypesSurface, SurfaceProblem>
readTsImplementationSurface(path, text): DomainResult<TsImplementationSurface, SurfaceProblem>
typesImportSpecifier(acceptancePath, acceptanceText, typesPath): "extensionless" | ".js" | ".ts" | null
```

**Depends on:** `owner-verification/import-graph.ts` (`parseModule`, `syntaxErrorsOf`)

### Java reader

**Responsibility:** Read Java declaration surfaces from given text with a restricted, pure lexer.
**Files:** `engine/src/core/skeleton/java-surface.ts`
**Interface:**

```
readJavaTypesSurface(path, text): DomainResult<JavaTypesSurface, SurfaceProblem>   // holder shape enforced
readJavaImplementationSurface(path, text): DomainResult<JavaImplementationSurface, SurfaceProblem>
```

**Depends on:** Skeleton types

### Generator and resolution

**Responsibility:** Resolve bindings to bindable aliases, and produce canonical skeleton bytes.
**Files:** `engine/src/core/skeleton/generate.ts`, `engine/src/core/skeleton/resolve.ts`
**Interface:** `resolveBindings: ResolveBindingsFn`, `generateSkeleton: GenerateSkeletonFn` (the result carries `bytes` and `sha256` via `core/digest.ts`)
**Depends on:** Skeleton types, `core/digest.ts`

### Outcomes and scope

**Responsibility:** One derivation each for "which paths are supported skeleton targets" (INV-6), "which outcome does this path have" (INV-4) and "which files of which Task owe which conformance" (INV-5).
**Files:** `engine/src/core/skeleton/language.ts`, `engine/src/core/skeleton/outcomes.ts`, `engine/src/core/skeleton/scope.ts`
**Interface:**

```
skeletonLanguageOf: SkeletonLanguageOfFn                  // language.ts, INV-6 owner
skeletonOutcomes: SkeletonOutcomesFn
isUntouchedSkeleton(record: SkeletonRecord | undefined, currentSha: string | null, canonicalSha: string | null): boolean
renderSkeletonOutcome(outcome): string
conformanceScope(graph, task): Readonly<{ kind: "not-owed" } | { kind: "owed"; contracts; bindings; files: NonEmpty<string> }>
```

**Depends on:** Skeleton types, `acceptance-contract` (contractRole, claimants), `test-file-classification`, `verification-policy`

### Conformance judge

**Responsibility:** Decide every violation of one Task's in-scope files, as data.
**Files:** `engine/src/core/skeleton/conformance.ts`
**Interface:** `judgeConformance: JudgeConformanceFn`, `renderConformanceViolations(artifact, violations): string`
**Depends on:** ts-surface, java-surface, Skeleton types

### Writer, frozen-surface observation and spawn materialization

**Responsibility:** The only engine path that writes skeleton bytes into the repository, and the per-Task spawn step of AD-1.
**Files:** `engine/src/orchestration/skeleton-writer.ts`, `engine/src/orchestration/frozen-surface-observation.ts`, `engine/src/orchestration/skeleton-materialization.ts`, `engine/src/handlers/task-execution.ts`, `engine/src/core/validate-task-execution.ts`
**Interface:**

```
createSkeleton(root, path, bytes, frozen: ReadonlySet<string>): WriteResult
refreshSkeleton(root, path, expectedSha256, bytes, frozen): WriteResult
type WriteResult = written | exists | refused{reason} | io-failed{message}
observeFrozenSurface(root, contract, mode: "stamped" | "current"): DomainResult<FrozenSurface & { typesSha256 }, ResolutionProblem>
materializeTaskSkeletons(root, graph, taskIds): DomainResult<{ records; outcomes: Map<taskId, outcomes> }, NonEmpty<string>>
```

**Depends on:** generator, resolution, outcomes, `no-follow-fs`, `acceptance-contract` (`frozenPaths`)

### Proof channel

**Responsibility:** Carry conformance into the existing declared-artifact obligation, and subtract engine bytes.
**Files:** `engine/src/core/proof-obligations.ts`, `engine/src/core/implementation-application.ts`, `engine/src/core/implementation-completion.ts`, `engine/src/core/implementation-retry.ts`, `engine/src/orchestration/contract-conformance-observation.ts`, the three settlement shells
**Interface:**

```
ProofFailure |= { kind: "declared-artifact-contract-violated"; artifact; violations: NonEmpty<ConformanceViolation> }
ObservedProofEvidence.contractConformance: ContractConformance          // required
observeContractConformance(root, graph, task): DomainResult<ContractConformance, string>   // string → infrastructure-blocked
TaskLocalObservationInput.engineSkeletonDigests: ReadonlyMap<path, sha256>
```

**Depends on:** conformance judge, scope, frozen-surface observation

### Contract stubs and revision refresh

**Responsibility:** The other two writer entry points (AD-9, AD-10).
**Files:** `engine/src/orchestration/contract-stub-materialization.ts`, `engine/src/handlers/subagent-stop/dispatch.ts`, `pi/subagent-stop.ts`, `engine/src/handlers/helpers/revise-contract.ts`, `engine/src/core/contract-revision.ts`
**Interface:** `materializeContractStubs(root, manager, taskId): DomainResult<{ written; problems }, string>`; the revision outcome gains `staleSkeletons: readonly string[]` and `bindingProblems: readonly ResolutionProblem[]`
**Depends on:** writer, frozen-surface observation, generator, outcomes

### Status, brief and blocker

**Responsibility:** Show every outcome, stale flag and stage-two problem, and tell the implementer what is frozen.
**Files:** `engine/src/core/skeleton/status.ts`, `engine/src/core/loom-status.ts`, `engine/src/core/implementation-window.ts`, `engine/src/handlers/helpers/orchestration.ts`, `engine/src/core/implementation-brief.ts`, `engine/src/orchestration/implementation-brief.ts`
**Interface:**

```
skeletonStatusReport(graph, observations, problems): SkeletonStatusReport   // never-absent field of LoomStatusDocument
StatusReason |= skeleton-bindings-unresolved
brief section "Frozen signatures": per owned file → bound exports + aliases, "signatures are frozen; remove `unimplemented: <name>`", frozen ADTs to import (not re-declare or re-list), fallback outcomes
```

**Depends on:** outcomes, scope, resolution

---

## Data Flow

```
plan File Structure ──parseExportBindings──▶ validateExportBindings ──▶ population stamps export_bindings
contract Task stop ──observeFrozenSurface(current)──▶ resolve ──▶ generate ──▶ createSkeleton/refresh ──▶ records(contract-stub)
contract Wave Gate ──▶ Acceptance Freeze (unchanged)
spawn (Claude PreToolUse | Pi) ──▶ registerTaskExecutionBatch
     └─ materializeTaskSkeletons: observeFrozenSurface(stamped) ─▶ resolve(all frozen bindings) ─┬─ problems ─▶ BLOCK
                                                                                                └─ outcomes ─▶ generate ─▶ createSkeleton
     └─ capture baselines (after writes) ─▶ locked update: reservation + skeleton records + skeleton_outcomes
settlement ──observeContractConformance (scope ─▶ read texts ─▶ judgeConformance)──▶ evaluateProofObligations
     declared-artifact-changed: violations? → contract-violated : changed (engine digest subtracted)? → satisfied : not-changed
revise-contract ──▶ re-resolve ─▶ refresh untouched / flag stale ─▶ locked update
status / brief ──skeletonOutcomes + scope + resolution──▶ outcome lines, stale flags, skeleton-bindings-unresolved
```

Every decision is a pure function over text or graph data. The shells read bytes, write through the writer, and commit under the StateManager lock.

---

## Invariants

### INV-1: The TypeScript compiler API enters only through the three parse-only seams

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-typescript-compiler-api-seam.json`
**Owner module:** none
**Unowned reason:** An import-confinement prohibition with no implementation to home. T5 edits the existing rule (and its `.pi` mirror) in lockstep with `TYPESCRIPT_COMPILER_API_SEAMS`, because `project-lint-rules.test.ts` fails whenever the two drift. Editing the rule in this phase would break that test until T5 lands.
**Statement:** No engine, Pi or script TypeScript file imports, requires or dynamically imports `typescript` or a `typescript/` subpath, except these three: `engine/src/core/owner-verification/mutation-plan.ts`, `engine/src/core/owner-verification/import-graph.ts` and `engine/src/core/skeleton/ts-surface.ts`. Test files are exempt. After T5 the rule's `excludePatterns` list `.test.ts` plus exactly those three paths.

### INV-2: The skeleton core performs no I/O

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A purity prohibition over a directory. A project regex rule cannot be scoped to a directory, so the programmatic `no-io-in-pure-modules` rule enforces it once T5 lists `engine/src/core/skeleton/` in `DEFAULT_PURE_MODULES`, and the machine-purity closure audit backs it.
**Statement:** No file under `engine/src/core/skeleton/` imports `fs`, `child_process`, `os` or `process`, or reads the clock, randomness or `process.*`. Every repository read and write lives in `engine/src/orchestration/skeleton-writer.ts`, `frozen-surface-observation.ts`, `skeleton-materialization.ts`, `contract-stub-materialization.ts`, `contract-conformance-observation.ts` and the existing handler shells.

### INV-3: Every engine-written skeleton byte goes through the one no-clobber writer

**Tier:** advisory
**Owner module:** `engine/src/orchestration/skeleton-writer.ts`
**Sibling entry points:**
- `engine/src/orchestration/skeleton-materialization.ts` — writes the spawning Task's missing skeletons and refreshes untouched stale-surface ones at registration
- `engine/src/orchestration/contract-stub-materialization.ts` — writes and refreshes contract stubs at the contract Task's stop
- `engine/src/orchestration/skeleton-revision.ts` — refreshes untouched skeletons after a Contract Revision (run by `handlers/helpers/revise-contract.ts`)
- `engine/src/orchestration/skeleton-refresh.ts` — `writePlanned`, the one step through which all three siblings call the writer
**Matrix test:** `engine/tests/orchestration/skeleton-writer.matrix.test.ts`
**Statement:** Every code path that writes a skeleton, contract stub or refreshed skeleton into the repository calls `createSkeleton` or `refreshSkeleton`. These are the spawn materialization, the contract stop step and the revision refresh. No path calls `writeFileSync`, `renameSync` or `linkSync` on a skeleton path itself. The writer refuses a non-repo-relative path, a frozen path and any symlinked ancestor. It never replaces an existing file on create, and never replaces a file whose digest differs from the expected engine digest on refresh. The matrix test drives each sibling over a temp repository with a pre-existing file, a frozen path, a symlinked parent and a modified skeleton, and asserts the bytes are unchanged and the refusal is a value.

### INV-4: One derivation decides each file_list path's skeleton outcome and whether a skeleton is untouched

**Tier:** advisory
**Owner module:** `engine/src/core/skeleton/outcomes.ts`
**Sibling entry points:**
- `engine/src/orchestration/skeleton-materialization.ts` — which paths to write, regenerate or adopt at registration, and the recorded skeleton_outcomes
- `engine/src/core/skeleton/refresh-plan.ts` — `planSkeletonRefresh`, the one planner of the contract stop (candidate-driven: which stubs are missing or untouched) and the revision (record-driven: untouched, refresh, versus modified, stale)
- `engine/src/core/skeleton/status.ts` — recorded and projected outcomes in `helper orchestration status`
- `engine/src/core/implementation-brief.ts` — per-file outcome lines in the brief
**Matrix test:** `engine/tests/core/skeleton-outcomes.matrix.test.ts`
**Statement:** Every call site that names a path's skeleton outcome, or decides whether an existing skeleton is engine-untouched, calls `skeletonOutcomesOf`, `isUntouchedSkeleton` or `presentSkeletonOf`. None compares digests or orders the five outcomes inline. That covers registration, the contract stop, revision, status and the brief. The matrix test feeds one graph and observation set through every sibling and asserts the same outcome per path, the precedence order, and the exact render strings. `generate.ts` and `scope.ts` are deliberately not siblings: neither names an outcome or judges untouchedness. Their shared language decision belongs to INV-6.

### INV-5: One derivation decides which files of which Task owe conformance, against which contracts

**Tier:** advisory
**Owner module:** `engine/src/core/skeleton/scope.ts`
**Sibling entry points:**
- `engine/src/orchestration/contract-conformance-observation.ts` — which files settlement reads and judges, or `not-owed`
- `engine/src/core/implementation-brief.ts` — which frozen ADTs and bound exports the brief lists as duties
**Matrix test:** `engine/tests/core/skeleton-scope.matrix.test.ts`
**Statement:** Every call site that decides whether a Task owes the signature or ADT check, and over which files and contracts, calls `conformanceScope`. That covers settlement (all three proof-evaluating shells, through the observation) and the brief's duty section. The matrix test covers each of these through every sibling, and asserts the same scope at each: an attested Task, a `documentation-only` Task, a claimant of a contract with `Types file: none`, a test file in `file_list`, a file that existed at Wave start, and a binder whose contract is still `awaiting-red`.

---

### INV-6: One predicate decides which paths are supported skeleton targets, and in which language

**Tier:** advisory
**Owner module:** `engine/src/core/skeleton/language.ts`
**Sibling entry points:**
- `engine/src/core/skeleton/outcomes.ts` — AD-13 step 4, the `unsupported-language` outcome
- `engine/src/core/skeleton/scope.ts` — which production files are TypeScript or Java for conformance
- `engine/src/orchestration/skeleton-materialization.ts` — generates each bound path's target at registration (through `generatedSkeleton`)
- `engine/src/orchestration/frozen-surface-observation.ts` — picks the TypeScript or Java reader for a contract's types file
- `engine/src/orchestration/skeleton-refresh.ts` — `generatedSkeleton`, which parses each bound path into its target for registration, the contract stop (`contract-stub-materialization.ts`) and the revision refresh (`skeleton-revision.ts`)
**Matrix test:** `engine/tests/core/skeleton-language.matrix.test.ts`
**Statement:** Every call site that decides whether a path is TypeScript, supported Java (under `src/main/java/`, with its package and class) or unsupported calls `skeletonLanguageOf`, and no module compares extensions or Java roots inline. That covers the outcome derivation, the conformance scope, spawn materialization, the types-file reader choice, the contract stub step and the revision refresh. `generate.ts`, `conformance.ts` and `resolve.ts` are deliberately not siblings, because they take the already-parsed branded `SkeletonTarget` or a language-tagged surface and make no language decision. The matrix test runs one path table (`.ts`, `.tsx`, `.mts`, `.cts`, `src/main/java/a/b/C.java`, `src/test/java/C.java`, `lib/C.java`, `.kt`, `.scala`, `.rs`) through every sibling, and asserts the same supported or unsupported verdict and the same Java package everywhere, so a change to the predicate fails at every row.

---

## Contracts

### CT-1: Bindings, frozen surfaces, resolution and canonical skeleton bytes

**Types file:** `engine/src/core/skeleton/types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/skeleton-generation.acceptance.test.ts` — FR-001, FR-002, FR-003, FR-006, FR-007, FR-008, FR-009, FR-010, AS-001, AS-002, AS-003, AS-004, AS-005, AS-011, AS-017
**Supported domain:** `engine/tests/acceptance/skeleton-generation.acceptance.test.ts`
**Statement:** `parseExportBindings` accepts `` - `path` — CT-n: name: Alias, … `` lines and records each export against its file. `validateExportBindings` refuses each of these with a diagnostic naming the file and the entry: an unsafe path, a frozen path, a malformed or duplicate entry, and a file whose lines name two contracts. `resolveBindings` refuses each alias the frozen surface does not declare, and each alias that is not a non-generic function type (TypeScript) or single-abstract-method interface (Java), naming the alias, the binding file and the types file. `generateSkeleton` emits, for TypeScript: type imports of exactly the bound aliases, with the acceptance tests' specifier style; one `export const name: Alias` per binding, throwing `unimplemented: name`. For Java it emits one `public static final Alias name` lambda per binding, throwing `UnsupportedOperationException("unimplemented: name")`, in a `public final class` named after the file. It emits nothing beyond the bound exports and their imports. 100 generations over the same input are byte-identical, and generating from an untouched skeleton's inputs reproduces its bytes. The supported table, read through `skeletonLanguageOf` and then `generateSkeleton`, accepts TypeScript and Java under `src/main/java/`. It refuses Rust, Kotlin, other Java roots and a Java types file that is not one top-level holder.

### CT-2: The completion conformance judge

**Types file:** none
**No types reason:** It consumes CT-1's `JudgeConformanceFn`, `ConformanceViolation` and surface types. Its only new code is the judge that `conformance.ts` stubs.
**Acceptance tests:**
- `engine/tests/acceptance/skeleton-conformance.acceptance.test.ts` — FR-013, FR-014, FR-015, FR-016, FR-017, FR-022, AS-020, AS-021, AS-022, AS-023, AS-024, AS-025, AS-026, AS-027, AS-028, AS-029, AS-030, AS-031, AS-032, AS-033, AS-034, AS-035, AS-036
**Statement:** For one set of frozen TypeScript and Java surfaces and bindings, `judgeConformance` returns no violation for a file that keeps every bound export with its name and alias annotation, has no marker, imports and pattern-matches the frozen ADTs, and adds helpers and extra exports. It returns a violation per bound export: `deleted` for a removed export or a missing file (every export of that file); `renamed` when the same alias annotation now sits on another name; `retyped` for a removed or replaced annotation, even one that compiles; `still unimplemented` for a remaining `unimplemented: <name>` literal, but never for another throw. It returns `shadows frozen ADT` for a local type, interface, class or record named as a frozen union, brand, sealed interface, record or variant. It returns `re-lists frozen variants` for a local union of object-shaped members sharing two or more frozen discriminant tags, or a local sealed hierarchy permitting two or more frozen variant names, with the `Extract<…>`/frozen-types remedy. A single shared variant name trips only the same-name rule. Every violation is listed, with the same reasons and shape in both languages.

### CT-3: The vertical slice — spawn, completion, stubs, revision, status and brief

**Types file:** none
**No types reason:** The slice consumes CT-1's types and drives production entry points that exist today. Those are `registerTaskExecutionBatch`, `settleExactImplementation`, the contract Task's stop path, the `revise-contract` handler, `helper orchestration status --json` and brief rendering. The tests read engine output as unknown JSON narrowed by CT-1 types, so they compile against today's engine.
**Acceptance tests:**
- `engine/tests/acceptance/skeleton-spawn.acceptance.test.ts` — FR-005, FR-011, FR-030, FR-032, AS-007, AS-008, AS-009, AS-010, AS-012, AS-013, AS-014, AS-016, AS-018, AS-019
- `engine/tests/acceptance/skeleton-completion.acceptance.test.ts` — FR-012, FR-018, FR-019, FR-021, AS-015, AS-037
- `engine/tests/acceptance/contract-stubs.acceptance.test.ts` — FR-023, AS-043, AS-044
- `engine/tests/acceptance/skeleton-revision.acceptance.test.ts` — FR-033, AS-049, AS-050, AS-051
- `engine/tests/acceptance/skeleton-status-brief.acceptance.test.ts` — FR-024, FR-040, AS-006, AS-038, AS-039, AS-040, AS-041, AS-042, AS-046, AS-047, AS-048
**Entry point:** `engine/src/handlers/task-execution.ts`
**Statement:** Registering an implementation Task whose bound TypeScript and Java files do not exist writes their canonical skeletons before the reservation commits, and records `engineSha256`. It leaves an existing file byte-identical, recording "exists, not skeletonized". It writes nothing for an unbound, unsupported-language or no-types-contract file, and records the matching outcome. It regenerates a deleted skeleton on retry. It refuses registration when a frozen types file lacks a bound alias, or declares it as a non-function, naming alias, file and types file. An untouched skeleton never counts as changed and never enters the attempt-scope delta. Completion is refused through `declared-artifact-contract-violated` with every violation, for files that existed at Wave start too. Attested and waived Tasks are not judged. The contract Task's stop writes every bound stub before the stop checks, and that stub is a skeleton for its owning Wave. A Contract Revision regenerates untouched skeletons, flags modified ones `stale against revised contract`, and blocks the next spawn on a vanished alias. Status lists every non-test file_list path of the Wave with exactly one outcome, plus stale flags. The brief lists bound exports with aliases, the frozen-signature and marker rules, the frozen ADTs to import, and each fallback outcome.

---

## Implementation Phases

Fifteen Tasks over six Waves. Every acceptance testcase is named `FR-0NN: …` or `AS-0NN: …`, and asserts new evidence (a written skeleton, a recorded outcome, a contract-violated refusal), so it is RED before the feature exists.

The contract Tasks hand-write their compiling stubs, because G2 is not live while it is being built.

The project already has a schema-2 `.loom/verification-manifest.json` with `affectedRunner` and `acceptanceRunner` writing JUnit. So contracts and the mutation-verified owned invariants (INV-3, INV-4, INV-5, INV-6, none exempt) populate without operator setup.

Requirements outside the contracts are claimed as ordinary tested work:
- FR-004 — T7
- FR-020 — T12, no new waiver arm
- FR-031 — T10
- FR-045 — T11, every refusal a value
- FR-041, FR-042, FR-044, AS-045 — T15, with T14 contributing the brief half of FR-041 and AS-045
- FR-043 — the ADR task decompose adds for AD-2

### Phase 1: CT-1 contract (no dependencies)

- **T1 — CT-1 contract Task.** Write `core/skeleton/types.ts` (declarations only), the CT-1 acceptance file with its supported/unsupported table, and the compiling stubs `bindings.ts`, `ts-surface.ts` (no `typescript` import), `java-surface.ts`, `generate.ts`, `resolve.ts` and `language.ts`, each `export const x: XFn = () => { throw new Error("not implemented"); }`. Claims nothing. Contributes FR-001..FR-010.
- **Files:** `engine/src/core/skeleton/types.ts`, the five stubs, `engine/tests/acceptance/skeleton-generation.acceptance.test.ts`

### Phase 2: Remaining contracts and the pure foundations (depends on Phase 1)

- **T2 — CT-2 contract Task.** Depends on T1. Writes the conformance acceptance matrix (TypeScript and Java, near-miss view-models), `tests/fixtures/skeleton-sources.ts` and the `conformance.ts` stub.
- **T3 — CT-3 contract Task.** Depends on T1. Writes the five slice acceptance files and `tests/fixtures/skeleton-repo.ts` (temp git repo, raw-JSON State File carrying `export_bindings` and freeze stamps, TypeScript and Java contracts).
- **T4 — Plan grammar and binding validation.** Depends on T1. `parseExportBindings`, `validateExportBindings`, `bindingStampAgreement`, the File Structure section and stray in `parse-plan-models.ts`, and wiring into `validate-model-bindings.ts`. Claims FR-001, FR-002, AS-001, AS-002, AS-003, AS-004, AS-005.
- **T5 — TypeScript surface seam.** Depends on T1. `ts-surface.ts`, the seam constant, both INV-1 rule copies, purity listing of `engine/src/core/skeleton/`, lint and purity tests. Contributes FR-003, FR-006, FR-015, FR-016.
- **T6 — Java reader.** Depends on T1. `java-surface.ts` with the holder-shape refusal. Contributes FR-003, FR-007, FR-015, FR-016.
- **T9 — Language predicate, outcomes and conformance scope.** Depends on T1. `language.ts` (INV-6 owner, AD-15), `outcomes.ts` (INV-4 owner, INV-6 sibling), `scope.ts` (INV-5 owner, INV-6 sibling), the three matrix tests with their owner rows and the INV-6 outcomes and scope rows. Contributes FR-018, FR-019, FR-030.
- **Files:** per File Structure groups CT-2, CT-3, T4, T5, T6, T9

### Phase 3: Generator, judge, persistence (depends on Phase 2)

- **T7 — Generator and resolution.** Depends on T1, T5, T6, T9 (it takes the `SkeletonTarget` that `language.ts` mints). Canonical TypeScript and Java bytes (AD-8), specifier style, stage-two resolution. Claims FR-003, FR-004, FR-006, FR-007, FR-008, FR-009, FR-010, AS-011, AS-017.
- **T8 — Conformance judge.** Depends on T2, T5, T6. Claims FR-013, FR-014, FR-015, FR-016, FR-017, FR-022, AS-020 through AS-036.
- **T10 — Persistence and population.** Depends on T4, T9. TaskGraph fields, State File wire, population stamping. Claims FR-031.
- **Files:** per File Structure groups T7, T8, T10

### Phase 4: Writer and spawn materialization (depends on Phase 3)

- **T11 — Writer and per-Task spawn materialization (AD-1).** Depends on T3, T7, T9, T10.
  - `skeleton-writer.ts` (INV-3 owner), `frozen-surface-observation.ts`, `skeleton-materialization.ts` (INV-3 and INV-4 sibling).
  - The call in `registerTaskExecutionBatch` before baseline capture, and the authority batch carrying records and outcomes.
  - The INV-3 matrix test, the materialization row in the INV-4 matrix, and the materialization and frozen-surface-observation rows in the INV-6 matrix.
  - Claims FR-005, FR-011, FR-030, FR-032, FR-045, AS-007, AS-008, AS-009, AS-010, AS-012, AS-013, AS-014, AS-016, AS-018, AS-019.
- **Files:** per File Structure group T11

### Phase 5: Proof channel, stubs and revision (depends on Phase 4)

- **T12 — Proof channel.** Depends on T3, T8, T9, T10, T11. The new failure variant, the required `contractConformance`, the evaluation order, the retry appendix, engine-digest subtraction in both the proof scope and the repository delta, `contract-conformance-observation.ts` (INV-5 sibling) in all three settlement shells, and the INV-5 matrix row. Claims FR-012, FR-018, FR-019, FR-020, FR-021, AS-015, AS-037.
- **T13 — Contract stubs and revision refresh.** Depends on T3, T7, T9, T10, T11. `contract-stub-materialization.ts` in both stop shells (AD-9), revision refresh and stale flags (AD-10), and the INV-3, INV-4 and INV-6 matrix rows for both siblings. Claims FR-023, FR-033, AS-043, AS-044, AS-049, AS-050, AS-051.
- **Files:** per File Structure groups T12, T13

### Phase 6: Status, brief, docs (depends on Phase 5)

- **T14 — Status, brief and the stage-two blocker.** Depends on T3, T7, T9, T10, T11, T13.
  - `core/skeleton/status.ts` (INV-4 sibling), `LoomStatusDocument.skeletons`, the `skeleton-bindings-unresolved` reason in `implementation-window.ts`.
  - The brief's "Frozen signatures" section (INV-4/INV-5 sibling), the contract-task block saying the engine writes stubs, and the plan-drift refusal in the brief shell.
  - The INV-4 and INV-5 matrix rows.
  - Claims FR-024, FR-040, AS-006, AS-038, AS-039, AS-040, AS-041, AS-042, AS-046, AS-047, AS-048. Contributes FR-041, AS-045.
- **T15 — Docs.** Depends on T12, T13. CONTEXT.md terms, operations, loom runbook, decompose rule 12, architecture template, plan template, executable-models reference, prose pins. Claims FR-041, FR-042, FR-044, AS-045.
- **Files:** per File Structure groups T14, T15

ADR tasks are added by decompose in a final Wave, one per AD. The AD-6 ADR amends ADR-0042, and the AD-2 ADR refines ADR-0020 (FR-043).

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Plan grammar (T4) | parse every malformed shape, every FR-002 refusal, stray outside File Structure | `validate-model-bindings` over a plan plus Task fixture | parse ∘ render round-trip over generated bindings |
| ts-surface (T5) | aliases (function, non-function, generic), discriminated unions, brands, export forms, marker literals, specifier style | lint mirror test, purity closure audit | none |
| java-surface (T6) | holder shape refusals, sealed/permits (explicit and implicit), records, SAM arity, fields and initializers, text blocks | none | blanking comments and strings never changes the declaration read |
| Generator and resolution (T7) | each resolution problem, TS and Java bytes, specifier fallback | generated TS reparsed by ts-surface, generated Java reread by java-surface | 100-run byte identity; idempotency; output contains exactly the bound names |
| Conformance (T8) | SC-006 seeded matrix in both languages, near-miss view-models | none | adding helpers or extra exports never adds a violation |
| Language, outcomes and scope (T9) | the supported path table, precedence, render strings, scope exemptions | INV-4, INV-5 and INV-6 matrices | exactly one outcome per non-test path; exactly one target or unsupported per path |
| Persistence (T10) | wire parse and refusals | pre-G2 State File loads unchanged; population stamps | none |
| Writer and materialization (T11) | writer results (EEXIST, symlinked parent, frozen, io failure, temp cleanup) | `registerTaskExecutionBatch` through the Claude and Pi callers over a temp repo; refused registration then adoption; 20-file Wave timing (NFR-001) | none |
| Proof channel (T12) | evaluation order, new parser arm, retry appendix, subtraction | `settleExactImplementation` over a temp repo; read failure → infrastructure-blocked; 20-bound-file completion timing (NFR-002) | none |
| Stubs and revision (T13) | revision outcome shape | both stop shells; revise-contract handler with touched and untouched skeletons | none |
| Status and brief (T14) | report rendering, blocker reason, brief section | `helper orchestration status --json`; brief marker expansion | none |
| Docs (T15) | prose pins | none | none |

Regression: every Task runs `npm run verify` in `engine/` unless the red-window waiver applies. The Wave Gate's acceptance-aware suite is the authority for pending CT testcases. SC-004 (no false positives on waived or attested artifacts) is the existing fixture corpus run through `conformanceScope` in the INV-5 matrix.

---

## Security & NFR Notes

- **Security:**
  - The engine now writes source files into the user's repository and parses agent-written text.
  - Writes go only through INV-3's writer: repo-relative, never frozen, no symlinked ancestor, no-replace create, digest-guarded refresh.
  - Generated bytes contain only identifiers validated by AD-3's grammar plus fixed template text, so there is no injection.
  - Both parsers are parse-only: no evaluation, no Program, no `ts.sys`.
  - No new trust boundary needs `/security-expert` (Q11a).
- **Performance:** Generation and checks are linear in file size and parse each file once. Expected well under NFR-001 and NFR-002 (2 s each). T11 and T12 measure both on 20-file fixtures.
- **Reliability:** Each file is complete or absent (temp file plus link or rename). A crash between write and record is recovered by content-addressed recognition (AD-4).

---

## Verification

1. `cd engine && npm run typecheck`
2. `cd engine && npm run verify` — all unit, acceptance and smoke suites green
3. `bun engine/src/cli.ts helper validate-lint-rules .claude/linter/rules` and the same for `.pi/linter/rules` — all rules load, and INV-1 lists the three seams
4. Manual: in a scratch repo with a TypeScript and a Java contract, run a contract Wave and check four things:
   - the stop writes the stubs;
   - a claimant spawn writes the skeletons, and status lists every path with exactly one outcome;
   - an untouched skeleton is refused `still unimplemented`;
   - a `revise-contract` refreshes untouched skeletons and flags a modified one stale.
