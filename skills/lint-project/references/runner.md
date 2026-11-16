# Lint Runner

Run the linter with the one shipped runner, `scripts/lint-project.ts`, from
any directory inside the project:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/lint-project.ts
```

This is the only runner: the edit hooks and the Wave Gate lint the files they
are given, and nothing else walks the project.

## The scope: everything, minus explicit exclusions

The runner lints **every file with a lintable extension** — `.ts .tsx .mts .cts
.js .jsx .mjs .cjs .java .kt .scala`, test files and declaration files included
— except:

- directories that never hold a project's own source, in any project
  (`node_modules`, `.git`, `.claude`, `.pi`, `dist`, `build`, `out`, `.next`,
  `target`, `.gradle`, `coverage`, `vendor`, `.cache`, `.venv`, …); and
- the project's `exclude` list in `config.json`, where every entry names a path
  and the reason it must not be checked (vendored upstream code, generated
  files):

<!-- wire-example: linter-project-config -->
```json
{
  "exclude": [
    { "path": "third_party/", "reason": "vendored upstream, byte-pinned by its manifest" }
  ]
}
```

A trailing `/` names a directory (every file beneath it); otherwise the entry
names one file. Globs are refused.

Rules that do not apply to tests say so themselves (`excludePatterns` on a
regex rule, `isTestFile` in a programmatic one) — the walk never drops tests
for every rule at once.

## Options

| Option | Effect |
|--------|--------|
| *(paths…)* | Lint these files or directories. An explicit file is linted exactly — unless the exclusion list names it, which prints `excluded: <file> (<reason>)` |
| `--tier=full` | All rules (default) |
| `--tier=immediate` | The edit-time tier only: regex rules, the import-boundary pair, `switch-totality`, `no-duplicate-block`, `no-wire-cast` |
| `--summary` | Counts by rule |
| `--json` | `{ violations, errorCount, staleEntries, coverageGaps, coverage, excluded }`; `coverage` is `set-up` or `no-setup` |
| `--no-fix-hints` | Hide fix hints |
| `--no-baseline-check` | Skip the staleness pass |
| `--write-baseline` | Record pre-existing totality sites, copied blocks and wire casts in `config.json`, then exit |
| `--init` | Turn every rule family on that the layout allows, then baseline (below). Creates `.claude/linter/rules/config.json` (`.pi/linter/rules/` in a project with `.pi` and no `.claude`), or fills the gaps of the existing one |

## What fails the run

Exit 1 on any violation, any file the linter could not lint, and — in the full
tier — any **stale entry**: a baseline key no live site consumes, an exclusion
that matches no file, a pure root, governance root or boundary module that
matches no file, a declared shell (`impureModules`) that names no file under a
pure root, a per-file capability grant for a file that no longer exists, or
an external name (`docReferences.externalNames`) that no governed document
references or that the source already resolves. Every list that subtracts from
the linter's reach is checked for decay. Scoping entries and external names are
judged against the whole project even on a run given paths.

A full-tier run also fails on each **coverage gap** (ADR-0075): an opt-in rule
family — `boundaries`, `pureModules`, `requireGovernance`, `docReferences` —
that a set-up project has neither configured nor declined in `config.json`.
Each gap line names the family, what it checks and both ways to decide it:
configure it, or add `{ "key": "<family>", "reason": "<why>" }` to the
`declined` list. An empty `boundaries` or `pureModules` list checks nothing,
so it is a gap too, and declining it is accepted. The immediate tier does not
judge coverage.

Exit 2 when the run cannot be trusted at all: a `config.json` the strict parser
refuses (an unknown key is refused by name), a project that carries both
`.claude/linter/rules` and `.pi/linter/rules` ("keep one rules directory"), a
path argument that does not exist, or path arguments that yield no file to lint
(every one excluded, or a directory with no lintable file). A run that checked
nothing never reads as a pass; only a project with no lintable file at all, run
with no path arguments, exits 0 with "No source files found to lint."

## Project root and rules directory

The project root is the nearest ancestor holding `.claude/linter/rules` or
`.pi/linter/rules`, else the nearest holding `.git` — so running from a
subdirectory with its own `package.json` (such as `engine/`) still lints the
whole repository under its rules. Every path in `config.json` (module
prefixes, baseline keys, exclusions) is relative to that root.

One lookup answers it everywhere (`findProjectRoot` in
`engine/src/linter/project-root.ts`; the engine's shell reads it through
`projectAt` and `editedFileRulesDir` in `engine/src/config.ts`), asked from a
different place by each caller: this runner and `helper validate-lint-rules`
ask from the working directory; Claude Code's edit hook and Pi's post-edit
lint ask from the edited file's directory. A file is therefore linted under its own project's rules
wherever the session's shell happens to be — in `engine/`, in another
checkout, or in the main checkout while editing a worktree's file. The Wave
Gate lint reads the rules at the repository root.

A project has one rules directory, and the lookup does not depend on the
harness: `.claude/linter/rules` when present, else `.pi/linter/rules` (a
Pi-only project). Claude Code's edit hook, Pi's post-edit lint, the Wave Gate
lint, `helper validate-lint-rules` with no argument and this runner all read
that same directory. A project carrying both layouts is refused (exit 2): the
hooks read only `.claude/linter/rules`, so the `.pi` twin would look enforced
while nothing reads it. `--write-baseline` writes only the one directory;
`--init` creates `.claude/linter/rules` unless the project has a `.pi`
directory and no `.claude` one.

With no rules directory, only Loom's default rules fire, and the boundary and
purity rules check nothing. The run does not fail for it, but prints a notice
on stderr; the session-start reminder says the same to the model and the user
until the project is set up or the user silences it for the repository.

## `--init`: every family the layout allows

`--init` infers each family the project has neither configured nor declined
(`engine/src/linter/starter-config.ts`), writes it into `config.json`, and
then runs `--write-baseline`, so the debt the baselined rules already flag
does not block the next edit:

- `pureModules`: the conventional functional-core roots the project has.
- `boundaries`: the layered TypeScript structure of `typescript.md`, when at
  least two of its layers exist. Each layer allows exactly what it imports
  today and denies the layers its arrows must not reach. A deny an import
  already breaks is left out and printed as a note: boundary violations are
  not baselined.
- `requireGovernance`: the source root, when the boundaries govern every
  source file beneath it.
- `docReferences`: the project's documents and plans, with the source root.

A family it cannot infer is printed with the reason, for a decision. A family
already configured or declined is never touched, so a re-run changes nothing.

`${CLAUDE_PLUGIN_ROOT}` is the Loom package root. Claude Code expands it; Loom's
Pi resource adapter renders it from the extension module's location.
