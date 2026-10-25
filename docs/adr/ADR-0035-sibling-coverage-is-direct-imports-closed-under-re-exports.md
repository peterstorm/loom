# ADR-0035: Sibling coverage is direct imports closed under re-exports

## Status
Accepted (2026-10-23). Records plan AD-5 of `.claude/plans/2026-10-21-g5b-owner-enforcement.md` (FR-005..FR-007,
AS-001..AS-003, AS-006). It shipped with G5b owner enforcement on `feat/g5b-owner-enforcement`.

## Context
G5b turns an owned invariant's family (one owner module, its declared sibling entry points and a matrix test)
into a Wave Gate obligation. The engine-reserved completion check `loom:owner-verification` has two halves.
Mutation verification shows the matrix test kills mutants of the owner. Sibling coverage, the subject of this
ADR, shows the matrix test reaches the owner and every declared sibling at all. Without it, a matrix test could
exercise the owner through one sibling and ignore the rest. A sibling that bypasses the owner would then never
meet the test that is meant to pin the rule.

"Reaches" needs an exact meaning, and several forces pull on it:

- **The owner requirement must not be vacuous (AS-003).** Siblings import the owner by construction, since that
  is how they delegate to it. Under a full transitive import closure, a matrix test that imports any sibling would
  "reach" the owner, and the check that the owner is reached would always pass.
- **Real test layouts must count (AS-006).** Matrix tests import through relative paths, through tsconfig `paths`
  aliases, and through barrel files that `export … from` the real modules. A rule that rejects these would push
  authors to rewrite working tests just to satisfy the gate.
- **Parsing must be faithful.** A specifier inside a comment, a string or a template is not an import. A
  specifier in `import()`, `require()` or `import x = require(...)` is one. A type-only import or re-export
  is erased at runtime and never loads its module, so it is not one either (FR-005).
- **The core stays pure.** `engine/src/core/` may not do I/O (`no-io-in-pure-modules`). Module resolution is
  filesystem work, so it must either move to the shell or be expressed over text the shell already read.
- **The check is bounded.** It runs at every Wave Gate that owes the invariant, so a pathological import graph
  must fail with a clear message and must not hang the gate.

The check also has a limit that no static analysis can remove: a runtime import proves the module is loaded, not
exercised. A matrix test that imports a sibling but never drives the rule through it still passes coverage.

## Options Considered

1. **Direct imports closed under re-exports, parsed with the TS compiler API, resolved purely (chosen)**
   - Pros: the owner requirement keeps its meaning, because a plain import chain stops after its first hop.
     Barrels, relative paths and aliases all count (AS-006). Parsing uses the real TypeScript scanner, so
     comments, strings and templates are never edges. Resolution is a pure function of file text, the declared
     paths and the tsconfig `paths`, so property and table tests can cover it with no filesystem.
   - Cons: it is a second module resolver beside TypeScript's own and covers only the subset the engine needs
     (no `node_modules`, `exports` maps, `rootDirs` or `moduleSuffixes`). A matrix test that reaches a sibling
     only through a non-re-export helper module counts as a miss, even when that helper really calls the sibling.

2. **Full transitive import closure**
   - Pros: simplest to state. It credits every file the test can load, including helpers.
   - Cons: siblings import the owner, so the owner is always reached and AS-003 means nothing. Any module that
     imports a sibling credits that sibling too, so coverage would almost never fail.

3. **Only the matrix test's own import declarations, with no re-export following**
   - Pros: trivial, and the most conservative.
   - Cons: fails AS-006. A test that imports a barrel `index.ts` which re-exports the siblings would be reported
     as missing all of them, which makes authors flatten working imports.

4. **Regex specifier scanning (rejected in the plan)**
   - Pros: no dependency on `typescript` in the core, and fast.
   - Cons: comments, string literals and templates defeat it, and handling them means building a second
     tokenizer. Its false edges would credit coverage that does not exist.

5. **`ts.resolveModuleName` with a compiler host (rejected in the plan)**
   - Pros: TypeScript's exact resolution semantics, including `node_modules` and `exports`.
   - Cons: the host does filesystem I/O inside `engine/src/core/`, which breaks the functional-core rule and
     the purity lint. Testing it would need a real or faked filesystem, and its behavior would follow
     `moduleResolution` settings that matrix tests do not need.

## Decision
**A matrix test reaches the files it imports or re-exports directly, closed under `export … from` edges only,
counting only edges that load their module at runtime. Specifiers are parsed with the TypeScript compiler API and
resolved purely against shell-gathered files.**

**Edge extraction: `engine/src/core/owner-verification/import-graph.ts`.** This is one of the two INV-1 seams
allowed to import `typescript`. `engine/src/linter/programmatic/no-cross-boundary-imports.ts` grants it, alongside
`mutation-plan.ts`. It exports `moduleEdges(path, text): ModuleEdges`, a list of `Edge`
(`{ kind: "import" | "reexport"; specifier; typeOnly }`). It parses through `parseModule(path, text)`, the one
parse both INV-1 seams share: `ts.createSourceFile` with the script kind the path's extension names (`.tsx` and
`.jsx` with JSX, `.js`/`.mjs`/`.cjs` as JavaScript, TypeScript otherwise). `mutation-plan.ts` parses owners
through the same function, so the two seams cannot disagree on the script-kind rule. It never builds a Program, a
language service or `ts.sys`. Edges are:

- `import`: static `import … from`, side-effect `import "…"`, `import x = require("…")`, and calls to
  `import(...)` or a bare `require(...)` whose first argument is a string literal or a template with no
  substitutions, found anywhere in the file;
- `reexport`: every `export … from "…"` form.

An edge is `typeOnly` when it is erased at runtime: `import type …`, `import type x = require(…)`,
`export type … from` (`export type *` included), and an import or re-export whose every named specifier is
`type` with no default or namespace binding. FR-005 counts only edges that load their module, so the coverage walk
ignores type-only edges: a matrix test that only type-imports the owner or a sibling does not reach it. A
specifier imported both ways is a runtime edge. Computed specifiers, templates with substitutions and member calls
such as `module.require(...)` are never edges. Each (kind, specifier) appears once, in first-seen source order.

**Resolution and reach: `engine/src/core/owner-verification/coverage.ts`.** This module is pure, and its path
arithmetic is hand-rolled so it needs no `node:path`.

- `resolveSpecifier(from, specifier, aliases, known)` tries candidates in order and picks the first one present
  in the known files. A relative specifier resolves against the importing file's directory through the extension
  ladder: `""`, `.ts`, `.tsx`, `.mts`, `.cts`; then a `.js`, `.jsx`, `.mjs` or `.cjs` specifier mapped to its
  TypeScript source (`.js` to `.ts`/`.tsx`, `.jsx` to `.tsx`, `.mjs` to `.mts`, `.cjs` to `.cts`); then
  `/index.ts` and `/index.tsx`. A non-relative specifier is matched against the `paths` aliases the way
  TypeScript chooses one: an exact pattern wins, then the longest wildcard prefix, then declared order. A pattern
  holds at most one `*`. Each target of the matched alias, with the captured text substituted, runs the same
  ladder in order. A bare package specifier with no alias, an absolute specifier, or a path that escapes the
  repository root is external and reaches nothing.
- `reachedFiles(matrixTest, files, aliases)` starts from the matrix test's runtime imports and re-exports, then
  follows only the runtime re-exports of each reached file. Edges are parsed lazily and memoized.
- `decideCoverage(reached, obligation)` returns `{ kind: "covered" }` or
  `{ kind: "missing"; paths: NonEmpty<string> }`. The missing paths come in declared order with the owner first.
  `coverageOverFiles` composes the two and implements `CoverageOverFilesFn` from `types.ts`.
- `CoverageVerdict` in `engine/src/core/owner-verification/types.ts` adds a third arm,
  `{ kind: "infrastructure"; failure }`, for failures to gather the graph.

**The frontier: pure steps, I/O in the shell.** The core cannot read files, so `coverage.ts` exposes a bounded
step, `coverageFrontier(state, read): CoverageFrontierStep`. Each step returns one of three results:

- `read` with a `NonEmpty` list of `next` paths;
- `complete`, meaning the gathered files now decide coverage exactly as the whole repository would;
- `bound-exceeded`, carrying the `coverage-bound-exceeded` infrastructure failure once more than
  `COVERAGE_FRONTIER_BOUND` (512) files have been gathered.

The step and the final decision share one traversal (`walk`). If any candidate ahead of a specifier's first
present candidate is still undecided, the walk does not follow that specifier yet. It reports those candidates
for reading instead. So the frontier reads exactly the candidates whose existence could change the resolution.

`engine/src/orchestration/owner-verification-runner.ts` drives the loop in `coverage()`. It reads each named path
through `readRepositoryText` against the canonical repository root, which never throws. A path that is absent
(`ENOENT`, `ENOTDIR`, `EISDIR`), not a regular file, or a symlink that escapes the root is left out of the read,
which tells the core that path is known absent. A path the filesystem refuses for any other reason (`EACCES`, a
symlink loop `ELOOP`, `EIO`, `EMFILE`, `ENAMETOOLONG`, ...) is the `repository-file-unreadable` infrastructure
failure, and coverage stops there: an unreadable file is never reported as a missing sibling. A tsconfig in the
`paths` chain that the filesystem refuses is the same failure. The shell then calls `coverageOverFiles` over
the gathered files.

**tsconfig `paths` resolution is pure; only the reads and the JSONC parse are injected.** Since the PR #131
review remediation, `pathAliasesOf(matrixTest, read, parseJsonc)` lives in
`engine/src/core/owner-verification/tsconfig-paths.ts`; the runner supplies the file read and a `jsonc-parser`
adapter (the only `jsonc-parser` import, under its existing grant). It finds the nearest
`tsconfig.json` from the matrix test's directory up to the repository root and parses it through that adapter.
It follows `extends` chains, both relative and under `node_modules`, and rejects cycles. It resolves `paths`
targets against `baseUrl` when the chain declares one, and otherwise against the directory of the config that
declared `paths`. The result is a repository-relative `PathAliases` list, which is empty when no tsconfig governs
the test. A tsconfig that does not parse, or has a malformed `extends`, `baseUrl` or `paths`, makes the aliases
unknown. Coverage then reports the infrastructure failure `alias-config-unresolvable` ("the import graph of …
cannot be resolved") and does not guess. The kind is its own (PR #131 round-2 review remediation): as shipped in
#127 this case reused `plan-unreadable`, whose remedy row says to restore the plan, although the plan is fine
and the cause is the tsconfig. Each `OwnerInfrastructureFailureKind` now points at exactly one remedy.

The neighbouring case keeps its kind on purpose. An owned Invariant whose owner path is not a file in the
workspace (absent, a directory, or a symlink escaping the root) is reported by the runner (`planMutation` in
`owner-verification-runner.ts`) as `plan-drift`, not as a file failure: the path comes from the stamp, so a
missing owner means the stamp names a path the Wave no longer has, and the remedy is the drift remedy (restore
the plan and its owner, or re-populate). An owner, matrix test or reached import that exists but the
filesystem refuses is still `repository-file-unreadable`.

**Where it is documented.** The operator remedy table in `docs/operations.md` (§ Owner verification) covers
"missing siblings", `coverage-bound-exceeded`, `repository-file-unreadable` and `alias-config-unresolvable`. `references/executable-models.md` describes the sibling-coverage
rule and lists "An import is not proof of exercise" under Known residuals (AS-035).

**Tests.** `engine/tests/core/owner-verification-import-graph.test.ts` covers edge extraction.
`engine/tests/core/owner-verification-coverage.test.ts` covers resolution, reach, decision order and frontier
behavior. `engine/tests/orchestration/owner-verification-runner.test.ts` exercises the shell. The acceptance
scenarios live in `engine/tests/acceptance/owner-verification-core.acceptance.test.ts`.

**How the shipped code departs from the AD-5 seed.**
- The extension ladder is wider than the seed's `'', .ts, .tsx, .mts, .cts, .js->.ts, /index.ts`. It also maps
  `.js` to `.tsx`, `.jsx`, `.mjs` and `.cjs` to their sources, and tries `/index.tsx`.
- Alias choice follows TypeScript's own precedence (exact pattern, then longest prefix), not just "a single `*`".
- `baseUrl` and `paths` are found by walking to the nearest tsconfig and its `extends` chain, rather than read from
  one known config.
- The shell's reads are typed as `coverageFrontier(state, read)` steps over a `CoverageGraphState`, not a single
  `readFiles` callback. A missing candidate counts as known absent; an unreadable one is an infrastructure
  failure. The infrastructure arm covers an unreadable file, an exceeded bound and unresolvable aliases.
- Type-only edges were first counted as reach (the edge test pinned `import type` as an edge). The PR #131
  review remediation tags them `typeOnly` and the walk ignores them, so coverage means the module is loaded at
  runtime. This closes a gap for an exempt Invariant, whose owner no mutation run guards.

## Consequences

**Positive:**
- AS-003 keeps its meaning. The owner must be imported directly, or through a re-export chain, by the matrix test
  itself, and is never credited through a sibling that imports it.
- Barrels, relative paths, aliases, `import x = require`, and string-literal dynamic imports all count, so
  idiomatic matrix tests pass without rewrites (AS-006).
- The real TypeScript scanner removes false edges from comments, strings and templates. No second tokenizer
  exists to maintain.
- Resolution, reach and the frontier are pure. They are tested by table and property tests with no filesystem,
  and the purity lint keeps them that way.
- The 512-file bound and the frontier's minimal reads keep the check cheap and its failure mode explicit. A
  `missing` verdict names every unreached path, owner first, which maps directly to the remedy in
  `docs/operations.md`.

**Negative:**
- A runtime import is not proof of exercise. A matrix test that imports a sibling but never drives the rule
  through it passes coverage. (A type-only import is not even proof of load and does not count.) Mutation
  verification mutates only the owner, so a sibling that bypasses the owner is caught only by a test that
  really drives it, or by the second-copy lens in review. This limit is accepted and documented in
  `references/executable-models.md`.
- A helper module that imports a sibling without re-exporting it does not credit that sibling, even if the test
  calls the sibling through it. Authors must import siblings directly or through `export … from` barrels.
- The engine now carries its own partial module resolver. It ignores `node_modules`, package `exports`,
  `rootDirs`, `moduleSuffixes` and non-TypeScript sources. If a project's resolution diverges from this subset,
  coverage reports a false miss. It never reports a false pass, because an unresolved specifier reaches nothing.
- An unreadable candidate blocks as infrastructure (`repository-file-unreadable`) rather than counting as absent.
  A draft in #127 read `EACCES` and `ELOOP` as absent, so a permission problem showed up
  as a coverage miss; it was corrected before merge, so the behavior matches the `CoverageVerdict`
  contract. The cost: a candidate path the frontier only probes (an extension or `/index` variant) that the
  filesystem refuses, for example under a directory without search permission, blocks the gate until the
  permission is fixed, even when another candidate would have resolved the specifier.
- The core now depends on `typescript` in a second seam (INV-1). A TypeScript upgrade that changes the AST shape
  could change the edges.
