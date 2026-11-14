# ADR-0074: Every doc reference resolves against the project

## Status
Accepted (2026-11-14). Implements E-track Phase A item 4 (`.claude/plans/2026-11-14-e-track-a4-doc-reference-resolver.md`).

## Context
The 1,247-finding review classification labels 36 findings doc-dangling across 9 PRs, 5 of them critical:
a doc or comment names a file, heading, symbol, spec id or run file the project does not have. About 30 are
mechanical. A backticked name either resolves or it does not, and no reviewer judgement is needed to say which.

The usual cause is an edit to another file. planStopCheck was removed from the stop-check planner while a
comment in a different file still named it. A check of the edited file alone cannot see that, so the check
has to read the unedited doc against the edited code.

## Options Considered

1. **A vitest suite over Loom's own docs.**
   - Cons: it holds only Loom. The E-track's goal is rules that bite on target projects through
     `lint-project` and the edit hook.

2. **Suffix matching for paths** (a path resolves when some file ends that way).
   - Cons: it accepts the shortened path a reviewer flagged precisely because it does not say where its file is.

3. **A per-language symbol table for tokens.**
   - Pros: it would catch the right name in the wrong module.
   - Cons: a parser per language for a family the classification puts out of scope (placement).

4. **One programmatic rule, named frames, a source-text corpus and a baseline (chosen).**

## Decision
**`no-dangling-doc-reference` holds every backticked reference in a governed document or code comment to
the project, or to a `path::reference` baseline entry.**

**Scope is the project's.** `docReferences` in its `config.json` names `govern`, `plans`, `exclude` and
`sourceRoots`, each parsed strictly (`linter/programmatic/config.ts`). Without it the rule reads nothing.

- A Markdown file under `govern` is read in full.
- A source file under `govern` is read for its comments.
- A Markdown file under `plans` is read for its spec header, spec ids and ADR ids only, because a plan names
  files that do not exist yet.

`lint-project` walks the governed paths beneath a directory the walk never enters, such as `.claude/plans/`.
It lints a Markdown file only where the scope governs it. Scope entries that match nothing are reported as drift.

**What a reference is** (`linter/doc-references/extract.ts`):
- a code span shaped like a path, a file name, or a word, with an optional call `()` or dotted path;
- a Markdown link;
- a plan's spec header and its FR/AS/OOS ids;
- an ADR id.

Some shapes are never references, whatever their form: placeholder grammar, a commit hash, a URL or other
scheme, a path rooted outside the project, a flag, a package scope, a media type, and another document's line id. Fenced
code and HTML comments are not read. An unclosed fence is itself a violation, because everything after it
would go unread.

**How it resolves** (`linter/doc-references/resolve.ts`, pure, over a `ReferenceIndex`):
- **Paths** are tried in named frames: the referring file's directory, each directory above it up to the
  root, then each source root.
  - A path with no extension may name a module file, as an import specifier does.
  - There is no suffix matching.
  - An absolute path is refused as such, because it names one machine's checkout.
- **Links** resolve as GitHub resolves them. A Markdown target's anchor must be one of its GitHub heading
  slugs (`slug.ts`) or HTML anchors.
- **Tokens** resolve when the source text holds the whole word, or every dotted segment of it.
- **Spec ids** go through the engine's one spec parser (`core/parse-spec.ts`). A spec it refuses is
  `spec-unreadable`, with the parser's reason.
- **ADR ids** must name a file in `docs/adr/`, numbered either with an ADR prefix or with adr-tools' bare four
  digits.

Each failure is one arm of the closed `DanglingReason`.

**The source corpus** (`linter/doc-references/reference-index.ts`) holds:
- the non-comment text of every script, JVM, JSON, shell, YAML and TOML file outside tests and fixtures. CI
  workflows hold the job names and secrets a contributing guide names. Comments are excluded so a comment
  cannot keep a deleted name alive;
- the names test code declares at the start of a line, so a doc may describe a test helper. A name a test
  only uses, such as a refused key in an assertion, does not count;
- every path segment and file stem.

Lockfiles are excluded.

**Shape.** `ProjectSnapshot` is the one port. Its filesystem adapter is `project-snapshot.ts`, the only
impure module; its in-memory fake lives in the tests. In a git repository the snapshot is the tree as every
clone has it: git's files, tracked or not yet added, never an ignored or deleted one, listed through the
engine's one policy-bound Git seam. The filesystem walk is the fallback only where there is no git or no
repository; a broken repository fails the lint closed. Reading the disk instead made the answer machine-dependent. A runtime directory or
an installed package resolved where it happened to exist and dangled in a fresh worktree and in CI. A word an
ignored file held kept a doc alive on one machine only. A path that runs through a file (`ENOTDIR`) names
nothing; it is not a failure. The index is lazy and memoized. The rule declares
`firstCallSetup`, so building the index is charged to no per-file deadline. It runs in the immediate tier
and again in the full tier, where the unedited doc is read against the edited code. It is a baseline owner,
so `--write-baseline` and the stale-entry pass apply.

**History is prose.** A mention of something deliberately gone is written without backticks or baselined.
The rule does not guess which names are history. The Markdown reader the doc-contract suites used moved
from `engine/tests/support/` into `engine/src/linter/markdown.ts` so the rule and the suites share it.

## Consequences

**Positive:**
- Each certified finding family is caught at the edit or in the full tier. The historical RED test replays
  them: the deltas file, the bad anchor, the deleted stop-check planner export, the refused vote-reason key, the ledger file name
  and FR-028.
- The real dangling references the plan measured were fixed rather than baselined. So were four stale
  comment names found on the way.
- A reference that later resolves leaves a stale baseline entry, and the stale-entry pass fails on it.

**Negative:**
- Building the index costs about 410 ms on Loom's tree (2,330 files) on the first edit of a governed file,
  and about 470 ms per edit in total with the other rules. A plan costs 17 ms. A full `lint-project` run
  takes about 5.5 s.
  - The corpus was built as one set filled in a tight loop, and test declarations are read by a
    line-anchored match rather than segmented, which halved the first measurement.
  - A disk cache was not added.
- Token resolution is deliberately lenient: a word that occurs anywhere in the source resolves, even when it
  is not the symbol the doc means.
- Loom starts with a 514-entry baseline. It is mostly decision-time history in ADRs, target-project paths in
  guidance, comment examples, plans whose specs are missing or unparseable, and runtime or installed
  locations the snapshot deliberately does not see (the state directory, completion reports, node_modules).
  A declared list of runtime locations would let the last group leave the baseline; that is a separate
  decision.
- A dry run on Fugue (`main` at a5c8df08, 1,443 files, a proposed scope over `docs/`, the package
  sources and both plan directories) reports 1,444 references in 277 files, in about 2 s for the whole
  lint. 1,072 are words the source does not hold. Most of those name an external system the code never
  spells out (Graph permissions, Redis commands, Azure resources, Python evaluators); the rest are
  removed code names. 347 are paths, mostly directories created at run time or relative to a package.
  The first run found 3,043. That run exposed two gaps the Loom tree could not show, and both were closed
  before this ADR was accepted: adr-tools ADR numbering (1,277 false misses) and CI workflows missing
  from the corpus.
  - A project whose docs describe external systems at length adopts with a large baseline. A
    configured vocabulary of external names would shrink it; that is a separate decision.
