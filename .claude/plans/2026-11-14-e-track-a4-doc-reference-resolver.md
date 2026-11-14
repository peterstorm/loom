# Plan: E-track A4 — the doc-reference resolver

**Created:** 2026-11-14
**Track:** E-track Phase A item 4 (static enforcement). This is item 1 in the re-ranked list in the vault note `learning/loom-fugue-review/static-enforcement-track-analysis.md` §3.
**Status:** built on branch `feat/doc-reference-resolver` (2026-11-14), not yet committed. Decision record: ADR-0074. All six acceptance items are met. Item 6 is the Fugue dry-run report in ADR-0074 and the vault track note.

**Deviations from this plan, each deliberate:**

- **Index files.** The index is `reference-index.ts` (pure, over the `ProjectSnapshot` port) and `project-snapshot.ts` (the one impure adapter), not a single index-build shell. The port has an in-memory fake in the tests, so the index is tested without the filesystem.
- **No `.pi` twin config.** Loom keeps one rules directory, `.claude/linter/rules`, which both harnesses read. A second copy would be the stale twin `lint-project` refuses.
- **Path frames include every ancestor directory**, not just the referring directory and the root. A doc may write a path relative to any directory above it. A path with no extension may name a module file, as an import specifier does.
- **Two more `DanglingReason` arms.** `spec-unreadable` carries the spec parser's reason. `absolute-path` refuses a path that names one machine's checkout.
- **Test code feeds the corpus with its declarations only**, so a doc may name a test helper, but a name a test merely uses keeps nothing alive.
- **Found by the Fugue dry run, fixed here:** adr-tools ADR numbering, YAML and TOML in the corpus, and media types refused as references.
- **The snapshot is git's view of the tree**, not the disk: a fresh worktree showed that runtime directories and installed packages resolved only where they existed. Loom's baseline is 514 entries as a result.
- **Markdown files are lintable**, but `lint-project` lints a Markdown file only where `docReferences` governs it.

## Why this item first

The 1,247-finding classification labels 36 findings `doc-dangling` (24 certified, 12 possible) across 9 PRs, 5 of them critical. That is the smallest certified family, and it needs no design judgement: a reference either resolves or it does not. Measured on Loom `main` (`70e70694`) on 2026-11-14, the mechanical sub-families in those 36 findings are:

| Sub-family | Findings | Example | Caught by |
|---|---|---|---|
| Backticked token names nothing in the code | ~17 | `planStopCheck`, `TEST_FILE_SUFFIXES`, `acceptanceRunner`, `piPostEditResult`, `waveChangedObligations`, `voteReason` (4, 3 critical), `needs-verification` (3), `budget_cut` | token resolution (AD-3) |
| Backticked repo path does not exist | 9 | `LOOM-DELTAS.md` (7), `tests/linter/...` without `engine/`, `programs/legacy-panel.ts` | path resolution (AD-2) |
| Documented run filename never written | 2 (both critical) | `coverage-ledger.json`, `run-metadata.json` | token resolution (the real names are string constants) |
| `FILE.md#anchor` names no heading | 2 | `WEB-PROTOCOL-AND-AUTH.md#authentication-and-session-handling` | anchor resolution (AD-2) |
| Plan cites an FR/AS id its spec lacks | 2 | `FR-028` | id resolution (AD-4) |
| Out of scope | ~4 | orphan JSDoc block (2, an AST rule), prose with no backticks naming a deleted runtime (#110), a code span split across a line | not this rule |

So about 30 of the 36 are caught by one rule. **Every backticked reference in a governed doc or code comment resolves against the project, or is named in a baseline.**

## Measured baseline on Loom `main` (2026-11-14)

These were produced by throwaway scripts that are not shipped; they will be re-measured by T6.

- **Anchors:** 212 `FILE.md#anchor` and link anchors. **All resolve**: the security-audit anchor findings were already fixed.
- **ADR ids:** 73 distinct `ADR-NNNN` references, **all resolve**.
- **FR/AS ids:** every plan that has a `**Spec:**` header cites only ids its spec defines. One plan names a spec file that does not exist (`2026-02-23-plan-alignment-phase.md`).
- **Paths:** 3,047 backticked path-shaped tokens outside `.claude/`. With *doc dir or repo root*, 1,063 do not resolve. Most are written relative to a source root (`core/skeleton/` means `engine/src/core/skeleton/`) or name a **target-project** path (`.claude/hooks/`, `src/main/java/`) or a **run-directory** artifact (`ledger.json`). Real dangling paths include `.claude/linter/rules/inv-1-typescript-compiler-api-seam.json` (ADR-0042, ADR-0053), `orchestration/fugue-program-runtime.ts` and `orchestration/dags/` (ADR-0004, ADR-0029), `references/reviewer-protocol-v2/` (ADR-0047, `docs/standalone-review.md:427`), and `docs/deterministic-implementation.md` (ADR-0064).
- **Tokens:** backticked non-path tokens resolved by substring against non-test source (`*.ts/js/sh/json`):

  | Tree | Tokens | Unresolved | Reading |
  |---|---|---|---|
  | `agents/` | 140 | 5 | placeholders (`FR-NNN`) and external APIs (`getOrElse`) |
  | `commands/` | 194 | 23 | placeholders, dotted wire paths (`claude.prompt`) |
  | `docs/` | 2,037 | 106 | real (`storeFunctionalCheckFindings`, `withTaskGraphRepository`), commit SHAs, external tools |
  | `references/` | 282 | 42 | mostly the vendored security lenses (browser APIs) |
  | `rules/` | 113 | 48 | the rules' own worked examples (`calculateShipping`) |
  | `skills/` | 540 | 283 | framework guidance (Spring, React, Next.js) |
  | `CONTEXT.md` / `README.md` | 53 | 2 | |
  | TS comments (`engine/src`, `pi`, `scripts`) | 1,490 | 19 | mostly deliberate history ("the retired `derivePanelPhase`") and external APIs |

The noise is concentrated in recognizable classes (placeholders, SHAs, history, framework guidance, vendored text). Scope plus a baseline handles it. Heuristics on prose are not needed.

## Architectural Decisions

### AD-1: One linter rule, `no-dangling-doc-reference`, in the programmatic registry

The rule lives beside `no-duplicate-block` and `no-wire-cast` (`engine/src/linter/programmatic/`). It is not a Loom-only vitest suite, because the E-track's goal is rules that bite on **target projects** (Fugue first) through `scripts/lint-project.ts` and the edit hook. The executor already filters by `rule.extensions` (`engine/src/linter/executor.ts:59`), so `.md` plus the script extensions works with no executor change.

- **Tiers:** `immediate`, on the edited file at every edit; and `full`, over the tree in `lint-project`, `npm run verify` and the Wave Gate. The full tier is not optional. The commonest way a reference dangles is a **rename or delete in another file** (`planStopCheck` was removed from `stop-check-planner.ts`, and the dangling comment sat in `affected-stop-check-types.ts`). No per-edit check of the edited file can see that.
- **Project-wide index, built once:** the rule declares `firstCallSetup` exactly as `no-duplicate-block` does, so the executor runs it last and never charges index-building time to a per-file deadline (`engine/src/linter/types.ts:46-51`).

### AD-2: Paths and anchors resolve against named frames, never by suffix

A path-shaped token (it has a `/` or ends in a known extension) resolves if it exists relative to any of these, in order:
1. the referring file's directory;
2. the project root;
3. each configured `docReferences.sourceRoots` entry (Loom: `engine/src`, `engine`).

**No unique-suffix matching.** It would have accepted `programs/legacy-panel.ts`, which a reviewer flagged precisely because it does not say where the file is.

A `FILE.md#anchor` reference, or a Markdown link with a fragment, additionally requires a heading in the target whose GitHub slug equals the anchor. Slugging is one pure function with its own property tests. Fenced code is never a heading.

### AD-3: A non-path token resolves if the project's source text contains it

A backticked token that is not a path resolves if it occurs in the **source corpus**. That is the non-comment text of the project's script, JSON and shell files, minus tests and fixtures, so a test cannot be the only thing keeping a doc alive. Identifiers, string constants (`"ledger.json"`, `"needs_validation"`) and wire field names all resolve by the same check. That one check catches `voteReason`, `needs-verification`, `budget_cut` and `coverage-ledger.json` without a vocabulary per wire format.

Recognized token shapes are fixed, so prose inside a code span is not a reference:
- a single word: `[A-Za-z_$][A-Za-z0-9_$.-]*`;
- a call: the word plus `()`;
- a dotted path: `a.b.c`, where **every segment** must resolve.

A span with a space, an operator or a quote is a code fragment and is ignored.

**Never a reference:**
- placeholder grammar: `NNN`, a trailing `-N`, `xxx`, `YYYY-MM-DD`, `<…>`, `{…}`, `*`;
- a hex string of 7 or more characters (commit SHAs);
- a URL.

### AD-4: Plan ids resolve against the plan's own spec

In a plan with a `**Spec:**` header, every `FR-NNN` / `AS-NNN` / `OOS-NNN` the plan cites must be defined in that spec. These are the three `SpecFamily` members `engine/src/core/parse-spec.ts` parses, and the rule reuses that parser; it does not add a second spec reader. A `**Spec:**` header naming a missing file is itself a violation. Plans and specs are excluded from AD-2 and AD-3, because a plan legitimately names files and symbols that do not exist yet.

ADR ids (`ADR-NNNN`) resolve against `docs/adr/` in every governed file. This is free to add and keeps the 73-for-73 that holds today.

### AD-5: Scope is configured per project; the default governs a project's own description of itself

This is new in the linter `config.json`, parsed strictly like every other key (`engine/src/linter/programmatic/config.ts`):

```
"docReferences": {
  "govern": [ReasonedPath, …],        // trees whose references must resolve
  "exclude": [ReasonedPath, …],       // vendored or framework-guidance trees inside them
  "sourceRoots": ["engine/src", "engine"],
  "comments": true                    // also read code-comment spans in governed source files
},
"docReferenceBaseline": ["docs/adr/ADR-0029-….md::orchestration/dags/", …]
```

- **Default when absent:** the rule checks nothing. This is fail-closed in the linter's own sense: a typo in a scope key is refused, never read as "everything".
- **Loom's scope:** governs `agents/`, `commands/`, `docs/`, `CONTEXT.md`, `README.md`, the Loom-procedure `skills/*/SKILL.md`, `.claude/plans/` (AD-4 only), and code comments in `engine/src`, `pi` and `scripts`. It excludes `references/security-lenses/` (vendored), `skills/*/references/` and the framework-guidance skills (they teach external APIs), and the worked examples in `rules/`.
- **Baseline:** `path::token` keys. These are line-free, so an entry survives unrelated edits. Staleness is reported by the existing `consume`/`unused` machinery (`engine/src/linter/programmatic/baseline.ts`), so a fixed reference cannot stay excused.

**History is not exempted by a heuristic.** A comment that says "the retired `derivePanelPhase`" is either rewritten without backticks (it is prose about a name, not a reference to code) or baselined with that reason. This keeps the rule a resolver, not a prose classifier, and it is the one convention change it asks of authors. It is documented in the lint-project skill and the rule's fix hint.

### AD-6: Functional core, imperative shell

The pure core:
- `extractDocReferences(text, kind)`: a fence-aware Markdown reader and a comment-span reader for script files. It yields the `DocReference` ADT: `path`, `anchor`, `token`, `plan-id` and `adr-id`, each with its 1-based line.
- `resolve(reference, index)`: returns `DomainResult<Resolved, DanglingReason>`, where `DanglingReason` is a closed union (`no-such-path`, `no-such-heading`, `not-in-source`, `id-not-in-spec`, `spec-missing`, `no-such-adr`).

The shell, `buildReferenceIndex(projectRoot, config)`, walks once with the existing project walk. It records the file set, the heading slugs per `.md` file, the source-token set, the spec ids per spec path and the ADR ids. The index is an immutable value handed to the pure resolver. Tests build it from in-memory fixtures, without mocks.

The Markdown reading reuses or promotes `engine/tests/support/markdown.ts`'s fence and heading rules into `engine/src`. It must not write a third Markdown reader. Moving the reader is a T2 decision recorded in the ADR.

## File Structure

| Task | Files |
|---|---|
| **T1 contract** | `engine/src/linter/doc-references/types.ts`: `DocReference`, `ReferenceIndex`, `DanglingReason`, `DocReferenceOptions` |
| **T2 extract** | `engine/src/linter/doc-references/extract.ts` (Markdown and comment spans, the token grammar of AD-3, the placeholder/SHA/URL grammar); the shared fence and heading reader moves from `engine/tests/support/markdown.ts` into `engine/src/linter/markdown.ts` (tests keep importing it) |
| **T3 index** | `engine/src/linter/doc-references/index-build.ts` (shell: one walk, the source corpus minus tests and fixtures, heading slugs, spec and ADR ids via `parse-spec.ts`) and `slug.ts` (pure) |
| **T4 resolve** | `engine/src/linter/doc-references/resolve.ts` (pure, AD-2 to AD-4 frames) |
| **T5 rule** | `engine/src/linter/programmatic/no-dangling-doc-reference.ts`; registry entry and baseline owner in `programmatic/index.ts`; `docReferences` and `docReferenceBaseline` in `programmatic/config.ts` |
| **T6 adoption** | `.claude/linter/rules/config.json` and `.pi/linter/rules/config.json` (scope plus the generated baseline); fixes to the real dangling references listed under "Measured baseline" |
| **T7 docs** | `docs/adr/ADR-0074-…` (the rule, the frames, the no-suffix decision, the history convention); `skills/lint-project/SKILL.md`; `lint-rules/README.md`; the vault E-track status |

## Tasks and waves

- **Wave 1:** T1 (contract).
- **Wave 2:** T2, T3 and T4, in parallel; each depends only on T1.
- **Wave 3:** T5.
- **Wave 4:** T6, then T7.

Tests per task (`rules/property-testing.md` applies to T2 and T4):
- **T2:**
  - Property tests: a token inside a fence is never extracted.
  - Property tests: every extracted reference's line holds its text.
  - Property tests: placeholder, SHA and URL shapes are never references.
  - Table tests: links, anchors, dotted paths and `()` calls.
- **T3:**
  - The corpus excludes comments, tests and fixtures. A token present only in a test does not resolve.
  - Slugs match GitHub's on a pinned table of headings: backticks, punctuation, duplicate headings.
- **T4:**
  - Each `DanglingReason` arm has a refusing case and an admitting case.
  - Frame order is pinned.
  - A unique suffix is refused (the `programs/legacy-panel.ts` case).
- **T5, Historical RED:** a seeded-copy fixture project replays the certified findings verbatim. The rule must name each one with its `DanglingReason`; the fixed form must pass.
  - the `LOOM-DELTAS.md` mention;
  - the bad anchor;
  - `planStopCheck` in a comment after its export is deleted;
  - `voteReason` in an agent doc;
  - `coverage-ledger.json`;
  - `FR-028`.
- **T5, cross-file:** deleting an export makes the full tier fail on an unedited doc that names it. This is the case per-edit checking cannot see.
- **T5, budget:** the immediate tier on one edited file stays under the per-edit deadline on Loom's tree, with the index build charged to `firstCallSetup`.
- **T6:** the rule's own test asserts Loom's baseline against the live repository, as the totality rules do. A fixed reference that stays baselined fails.

## Acceptance

1. `bun scripts/lint-project.ts --tier=full` reports zero non-baselined `no-dangling-doc-reference` violations on Loom.
2. The real dangling references named above are fixed, not baselined.
3. Every certified `doc-dangling` finding in the seeded-copy fixture is named; the fixed forms pass.
4. `npm run verify` is green. It already runs `lint`, so the rule gates Loom's CI from merge.
5. Runtime is measured and recorded in the ADR: index build time and per-edit time on Loom's tree.
6. The Fugue dry run is a report, not a gate: run against Fugue `main` with a proposed `docReferences` scope; record the counts in the vault. Wiring it into Fugue's `scripts/verify.sh` belongs with the Fugue config-hygiene slice in the track analysis §5, not here.

## Out of scope (named so they are not mistaken for done)

- **Orphan JSDoc blocks** (2 findings): an AST rule over TS. It is a candidate for the next linter slice.
- **Prose that names a deleted thing without backticks** (#110, `docs/deterministic-core.md`): not mechanical. Doc-prose drift stays review-only (12% of findings).
- **Whether a reference is placed correctly** (ADR-0027 places `extractShellWriteTargets` in the wrong file): the symbol resolves, so a resolver cannot see it.
- **Wire examples in JSON fences:** already owned by ADR-0073 (`doc-wire-examples`).

## Decisions taken without an interview (revisit if wrong)

- **Plans are governed for ids only (AD-4).** Applying path and token resolution to plans would flag every not-yet-built file a plan designs.
- **ADRs are governed in full.** They name current files in "What shipped" sections, and reviewers flag them (ADR-0029, ADR-0004). A reference to deliberately removed code is rewritten as prose or baselined with its reason, the same as any history.
- **Substring resolution (AD-3) is deliberately lenient.** A token that occurs anywhere in source resolves even if it is not the declared symbol a doc means. Exact symbol resolution needs a per-language symbol table. It would catch the "right name, wrong place" family, but that is the out-of-scope placement case, at much higher cost.
