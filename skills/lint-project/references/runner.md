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
  `target`, `.gradle`, `coverage`, `vendor`, `.cache`, …); and
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
| `--json` | `{ violations, errorCount, staleEntries, excluded }` |
| `--no-fix-hints` | Hide fix hints |
| `--no-baseline-check` | Skip the staleness pass |
| `--write-baseline` | Record pre-existing totality sites, copied blocks and wire casts in `config.json`, then exit |
| `--init` | Scaffold `.claude/linter/rules/config.json` (`.pi/linter/rules/` in a project with `.pi` and no `.claude`); its starter `pureModules` keeps only the roots the project already has, so the first run is not stale |

## What fails the run

Exit 1 on any violation, any file the linter could not lint, and — in the full
tier — any **stale entry**: a baseline key no live site consumes, an exclusion
that matches no file, a pure root, governance root or boundary module that
matches no file, a declared shell (`impureModules`) that names no file under a
pure root, or a per-file capability grant for a file that no longer exists.
Every list that subtracts from the linter's reach is checked for decay.

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
purity rules check nothing.

`${CLAUDE_PLUGIN_ROOT}` is the Loom package root. Claude Code expands it; Loom's
Pi resource adapter renders it from the extension module's location.
