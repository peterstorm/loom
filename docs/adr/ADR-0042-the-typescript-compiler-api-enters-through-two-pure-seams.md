# ADR-0042: The TypeScript compiler API enters through two pure seams

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, NFR-003, FR-011; plan
`.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-12 and INV-1). This decision deviates from
interview answer Q4d. The deviation is recorded below.

## Context
G5b owner verification has two jobs that need TypeScript parsing:

- **Mutation (AD-6).** The engine mutates the changed lines of an owner module and checks that the owner's
  matrix test kills each mutant. It has to find real condition, comparison, logical, boolean-literal, return
  and expression-statement nodes, and it has to keep `true` inside a type and prologue directives out of the
  candidate set. Character matching cannot do this reliably.
- **Sibling coverage (AD-5).** The engine decides which modules the matrix test reaches. "Reached" means
  the files the test imports directly, closed under re-export edges. To get this right, the engine must read
  static imports, side-effect imports, `import x = require("…")`, string-literal `import("…")` and
  `require("…")` calls, and every form of `export … from`. It must also ignore comments, plain strings,
  template literals with substitutions and member calls such as `module.require("…")`.

Several forces constrain where that parsing can live. Everything under `engine/src/core/owner-verification/`
is pure core: `DEFAULT_PURE_MODULES` lists it (AD-13, INV-2), and the purity linter bans `fs`,
`child_process`, the clock, randomness and `process.*` there. NFR-003 forbids a new runtime dependency. The
pure core also has an exact per-file package-grant model.
`engine/src/linter/programmatic/no-cross-boundary-imports.ts` grants packages one file at a time, and
`engine/tests/linter/programmatic/machine-purity.test.ts` audits the transitive closure of every pure
module. A package that enters the core needs an audited, narrow entry point. Any other arrangement weakens
the purity guarantees the gate depends on.

Interview Q4d named `mutation-plan.ts` as the only module allowed to import `typescript`. That answer came
before AD-5 settled that coverage resolution needs real specifier parsing, including re-exports and dynamic
imports.

## Options Considered

1. **One seam: `mutation-plan.ts` only, with a regex/hand tokenizer for import edges (the Q4d answer).**
   - Pros: Matches the interview answer. Only one file holds the compiler-API grant.
   - Cons: A tokenizer would be a second copy of TypeScript's lexing rules, which is the duplication G5b
     exists to stop. It would get comments, strings, template literals, `import x = require`, multi-line
     `export { … } from` and member `require` calls wrong. A wrong edge produces a wrong coverage verdict:
     a module that is not reached could be reported as covered. Line-text matching also cannot give the
     first-seen, de-duplicated ordering that coverage relies on.

2. **One seam: `mutation-plan.ts`, which also exports import-edge parsing.**
   - Pros: Real parsing, and still a single grant.
   - Cons: It merges two unrelated concerns, mutation-site selection and module-graph reading, into one
     module. Coverage would then depend on the mutation module. A change to mutation operators could break
     coverage, and the reverse. The module's interface would get wider and shallower, and its name would no
     longer describe what it does.

3. **Two named seams: `mutation-plan.ts` and `import-graph.ts`, each granted `typescript` (chosen).**
   - Pros: Both jobs use the real parser. Each seam does one thing behind a small interface. Each grant is an
     exact per-file entry, so no other core file gains the capability. The rule, the linter grant and the
     purity audit all name the same two files.
   - Cons: Two files hold a heavyweight capability instead of one. The deviation from Q4d has to be recorded
     and explained (this ADR).

4. **Use the compiler's Program or language service (`ts.createProgram`, `ts.sys`, module resolution) from
   the shell.**
   - Pros: Real module resolution, including `tsconfig` handling, for free.
   - Cons: `ts.sys` and a Program read the filesystem, which pure core cannot do. Moving the logic to the
     shell would make coverage untestable without a disk fixture. It would also pull a much larger and
     slower part of the API into every Wave Gate. Resolution is a small, pure job:
     `engine/src/core/owner-verification/coverage.ts` does it with an extension ladder and single-`*`
     `paths` matching, over a file set the shell supplies.

5. **Add a dedicated parser package (for example, an ES module lexer).**
   - Pros: A smaller dependency than the compiler.
   - Cons: It adds a new dependency, which NFR-003 rules out. It still could not locate mutation sites, so
     `typescript` would be needed anyway.

## Decision
**INV-1 confines the TypeScript compiler API to exactly two pure seams:
`engine/src/core/owner-verification/mutation-plan.ts` and
`engine/src/core/owner-verification/import-graph.ts`. Each one parses only text it has been given.**

- **Seams and their interfaces.**
  - `import-graph.ts` exports `moduleEdges(path, text): ModuleEdges`, which returns
    `{ imports, reexports }`. Each list keeps a specifier once, in first-seen source order. The script kind
    comes from the file extension. The only caller is `coverage.ts`, which resolves the edges against the
    shell-supplied file set.
  - `mutation-plan.ts` exports `mutationPlan({ ownerPath, ownerText, changedLines, cap })` and
    `applyMutant`. It parses with `ts.createSourceFile(…, ScriptTarget.Latest, true, ScriptKind.TS)`. The
    shell `engine/src/orchestration/owner-verification-runner.ts` reads the owner text and calls it.
- **Parse-only contract.** Both seams call only `ts.createSourceFile` and node visitors on text they are
  given. They never use `ts.sys`, a Program, module resolution or a language service. Both module headers
  state this. The purity linter enforces it: the package directory is in `DEFAULT_PURE_MODULES` (INV-2).
- **Three enforcement points that name the same pair.**
  - `.claude/linter/rules/inv-1-typescript-compiler-api-seam.json`, mirrored at
    `.pi/linter/rules/inv-1-typescript-compiler-api-seam.json`. This is a checkable regex rule. It refuses
    `from "typescript…"`, `require("typescript…")` and `import("typescript…")` everywhere except the two
    seams and `.test.ts` files. Its fix hint sends authors to `mutationPlan` or `moduleEdges`, or tells them
    to extend one of the seams.
  - `engine/src/linter/programmatic/no-cross-boundary-imports.ts` has two `perFileExactAllow` entries,
    `"engine/src/core/owner-verification/import-graph.ts": ["typescript"]` and
    `"engine/src/core/owner-verification/mutation-plan.ts": ["typescript"]`. These are exact-specifier
    grants, never a prefix. A `typescript/…` subpath therefore fails until it is re-audited.
  - `engine/tests/linter/programmatic/machine-purity.test.ts` has a `TYPESCRIPT_SEAMS` list holding the
    same two paths. `auditClosure` treats `typescript` as a granted capability only for those modules. It
    reports a `typescript` import from any other pure file, and any widened specifier such as
    `typescript/lib/tsserverlibrary` from a seam, as `unaudited package`. The test
    "expands the owner-verification package entry to every file and grants typescript only to its two
    seams" proves both refusals.
- **Test exemption.** Test files may import `typescript`. `machine-purity.test.ts` does so to parse the
  dependencies it audits.
- **Dependency status (NFR-003).** `typescript` stays where it already was, in `engine/package.json`
  `devDependencies` (`"typescript": "^5.0.0"`). The documented `(cd engine && bun install --frozen-lockfile)`
  installs it, the same way it installs `ts-pattern`, which dozens of engine modules under `engine/src`
  import at runtime. No dependency is added. `docs/operations.md` says that the Wave Gate's owner verification loads
  `typescript` at runtime, and that an engine checkout without its locked install cannot run the Wave Gate.

## Consequences

**Positive:**
- Coverage and mutation both use TypeScript's own parser. Edge cases such as comments, strings, template
  literals, type-position literals, prologue directives and multi-line re-exports are handled correctly
  rather than approximated. There is no second copy of TypeScript lexing in the engine.
- Each seam is deep: one function over plain text, so tests need only strings
  (`engine/tests/core/owner-verification-import-graph.test.ts`,
  `engine/tests/core/owner-verification-mutation-plan.test.ts`). They need no fixture repository or
  compiler host.
- The capability stays narrow and visible. The project rule, the programmatic linter and the purity audit
  each list the same two files, so widening the grant requires deliberate edits in three places.
- No new dependency, and the pure-core and FC/IS boundaries are unchanged. All I/O stays in
  `owner-verification-runner.ts` and the coverage shell input.

**Negative:**
- This deviates from interview answer Q4d. Two files hold the compiler-API grant instead of one, and a
  reader has to come to this ADR to learn why.
- Three artifacts encode the same seam list: the rule JSON (with its `.pi` mirror), the linter grant map,
  and `TYPESCRIPT_SEAMS`. Moving or renaming a seam means updating all of them. The machine-purity test
  catches drift on the audit side.
- `typescript` is now a runtime requirement of the Wave Gate, even though it is declared as a
  `devDependency`. An install that skips dev dependencies would break owner verification. The operations
  docs record this, but `package.json` does not express it.
- The regex rule matches line text. A multi-line import of `typescript` that splits the specifier from
  `from` could slip past it. The exact-specifier programmatic grant and the closure audit cover that case.
- Parse-only means no type information. Mutation operators and edge extraction are syntactic. If a future
  need arises for type-aware mutation or `tsconfig`-driven resolution beyond `baseUrl`/`paths`, it must be
  solved in the shell or by a new ADR. Reaching for a Program inside the seams is not allowed.
